/**
 * session-extract-apply.ts — session-extract 的**批量落库应用层** (round 77 写入链收口)
 *
 * 为什么有本文件:
 *   `scripts/session-extract.ts` 是每 20 分钟跑一次的 systemd timer worker, 原先用 better-sqlite3
 *   **直连生产库**写 14 处/9 张表 —— 它是 mind 核心库的**第二个写进程**, 且把同一份写入契约
 *   (标题归一/受控投影/qualityScore/contentHash 去重/认知闸) 在脚本里**又实现了一遍**。
 *   本文件是 mind 侧的**唯一落库实现**: 脚本只负责"算"(LLM 调用/解析/归一/去重判定/批次组装),
 *   通过 `POST /api/v1/session-extract/apply` 把一批写入意图交到这里执行。
 *
 * 复用既有写入服务(不新写裸 SQL, 不绕过认知闸):
 *   · Memory    -> safeCreateMemory    -> PrismaMemoryStore.create    (safe-create.ts:42)
 *   · Knowledge -> safeCreateKnowledge -> PrismaKnowledgeStore.create (safe-create.ts:46)
 *   · Practice  -> safeCreatePractice  -> PrismaPracticeStore.create  (safe-create.ts:50)
 *   · Skill     -> safeCreateSkill     -> PrismaSkillStore.create     (safe-create.ts:58)
 *   · Skill 名写侧硬上限判据复用 db-writer.resolveSkillNameForWrite (db-writer.ts:103, 与
 *     db-writer 主产线 round74 同一实现) —— 超长即降级为 Knowledge, 绝不写超长 Skill。
 *   · Task / FlywheelEvent / 关联表 / Knowledge 撤回 -> Prisma 模型层(非裸 SQL)。
 *
 * 幂等键(与旧直写路径**逐字兼容**, 保证重放同一批不产生重复行; 复算方式见各分支注释):
 *   · 产物(Memory/Knowledge/Practice/Skill): `contentHash = sha256(title + content)`, 由**本文件复算**
 *     (客户端传的 contentHash 只作交叉校验, 不一致即 400 —— 把"第二套实现"变成被检不变量)。
 *     这正是旧脚本 `sha256(c.title + c.content)` 的公式, 所以对历史直写行**同样命中**。
 *   · Skill 额外按 `name`(唯一约束)去重 —— 对应旧脚本 `stmtSkillByName`。
 *   · 关联表: 复合主键/唯一键(practiceId+memoryId / +skillId / +knowledgeId) -> 已存在即 deduped。
 *   · Task: `id`(脚本 genId, 重放同一批同 id) + 业务键(improvementType + 完整 title + 活跃态)。
 *   · FlywheelEvent: `id`。
 *   · Knowledge 撤回: 目标已 stale 且 supersededBy 未变 -> skipped(与旧 retractKnowledge 幂等口径同)。
 *
 * 失败语义(刻意区分两类, 与脚本侧 `rejected`/`errors` 对应):
 *   · rejected = 平台写入闸/认知闸**确定性拒收**(store 返回 null)。重试无意义 -> 脚本记为可见丢数, 水位线照常推进。
 *   · errors   = 基础设施异常(DB/字段/约束)。可重试 -> 脚本把该会话标 ERROR 且**不推进水位线**, 下轮重试
 *                (重试时上面各幂等键保证已落库的行不会重复)。
 *
 * 原子性说明(诚实登记): 旧直写路径把单会话全部写入放在**一个 better-sqlite3 事务**里。
 *   本层改为**逐条幂等应用**(不包一个长事务)。理由: 跨 HTTP 边界时客户端无法区分"已提交但响应丢失"
 *   与"未提交", 逐条幂等重放比 all-or-nothing 更安全; 代价是极端情况下可能出现**部分落库**,
 *   由脚本的 ERROR + 水位线不推进 + 幂等重放收敛。
 */
import { skillNameFields, findPublicSkillId } from "./skill-naming";
import type { PrismaClient } from "../../../node_modules/.prisma/mind-client";
import {
  safeCreateMemory,
  safeCreateKnowledge,
  safeCreatePractice,
  safeCreateSkill,
  safeCreateReflection,
} from "./safe-create";
import { resolveSkillNameForWrite } from "./db-writer";
// 2026-10-25 撤回流程补漏: 去重判定统一走"活行口径"(未撤回 + 未被取代)
import { liveRowWhere } from "./stale-aware-dedup";
import {
  productContentHash,
  productHashForRow,
  type ExtractRow,
  type SessionExtractBatch,
} from "./session-extract-hash";

// contentHash 契约的实现在 session-extract-hash.ts(唯一实现, 脚本与 mind 共用); 这里 re-export 便于审计。
export { productContentHash, productHashForRow };
export type { ExtractRow, SessionExtractBatch, ProductKind } from "./session-extract-hash";

export interface ApplyCounter {
  memory: number;
  knowledge: number;
  practice: number;
  skill: number;
  reflection: number;
  task: number;
  event: number;
  link: number;
  retraction: number;
}

export interface ApplyItemFailure {
  section: string;
  key: string;
  reason: string;
}

export interface ApplyBatchResult {
  sessionUid: string;
  /** 逐类 applied */
  applied: ApplyCounter;
  /** 逐类 deduped(contentHash / name / 复合键 / id 命中) */
  deduped: ApplyCounter;
  /** 技能名超长 -> 降级为 Knowledge 的条数(旧脚本 droppedNameTooLong 同口径) */
  downgraded: { skillNameTooLong: number };
  /** 平台闸确定性拒收(store 返回 null); 重试无意义 */
  rejected: ApplyItemFailure[];
  /** 基础设施异常; 可重试(幂等键保证不重复) */
  errors: ApplyItemFailure[];
}

const EMPTY_COUNTER = (): ApplyCounter => ({
  memory: 0, knowledge: 0, practice: 0, skill: 0, reflection: 0, task: 0, event: 0, link: 0, retraction: 0,
});

function toDate(v: unknown): Date | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v;
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n)) return new Date(n);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  return s.length ? s : undefined;
}

/**
 * 交叉校验客户端 contentHash: 不一致 -> 抛错(由 route 转 400)。
 * 为什么不让客户端直接决定 hash: 那等于把"同一份写入契约"留在 mind 之外 —— 本函数就是收口点。
 */
function assertHash(row: ExtractRow, expected: string, kind: string): void {
  const given = str(row.contentHash);
  if (given && given !== expected) {
    const e: any = new Error(
      `contentHash mismatch for ${kind}: client=${given.slice(0, 12)}… mind=${expected.slice(0, 12)}… ` +
        `(公式必须为 sha256(title+content); 见 session-extract-apply.ts 头注)`,
    );
    e.code = "CONTENT_HASH_MISMATCH";
    throw e;
  }
}

/** 单条产物的落库结果: created=新建(带 id) / deduped=命中已有 / downgraded=降级 Knowledge / rejected=闸拒收 */
type ProductOutcome =
  | { status: "created"; id: string }
  | { status: "deduped"; id: string | null }
  | { status: "downgraded"; id: string }
  | { status: "rejected"; reason: string };

/**
 * 批次前置校验: contentHash 与 mind 复算值不一致 -> 返回违规明细(route 转 400)。
 * 为什么 fail-fast: 契约(公式)必须在 mind 内单一实现; 客户端算错就该**当场红**, 而不是静默写入不同口径的行。
 */
export function validateSessionExtractBatch(batch: SessionExtractBatch): string[] {
  const issues: string[] = [];
  if (!String(batch?.sessionUid || "").trim()) issues.push("sessionUid required");
  const kinds: Array<"memory" | "knowledge" | "practice" | "skill" | "reflection"> = ["memory", "knowledge", "practice", "skill", "reflection"];
  for (const kind of kinds) {
    for (const row of batch?.products?.[kind] || []) {
      const expected = productHashForRow(kind, row);
      const given = str(row.contentHash);
      if (given && given !== expected) {
        issues.push(`${kind}: contentHash mismatch (title=${String(row.title ?? "").slice(0, 30)})`);
      }
    }
  }
  return issues;
}

export async function applySessionExtractBatch(
  prisma: PrismaClient,
  batch: SessionExtractBatch,
): Promise<ApplyBatchResult> {
  const sessionUid = String(batch?.sessionUid || "").trim();
  if (!sessionUid) throw new Error("sessionUid required");

  const out: ApplyBatchResult = {
    sessionUid,
    applied: EMPTY_COUNTER(),
    deduped: EMPTY_COUNTER(),
    downgraded: { skillNameTooLong: 0 },
    rejected: [],
    errors: [],
  };
  const fail = (section: string, key: string, e: unknown): void => {
    out.errors.push({ section, key, reason: String((e as any)?.message || e).slice(0, 300) });
  };
  const reject = (section: string, key: string, reason: string): void => {
    out.rejected.push({ section, key, reason: reason.slice(0, 300) });
  };

  /**
   * 通用产物落库模板: 复算 contentHash -> 查重 -> 走 store(带认知闸) -> 判空。
   * 返回 deduped 时携带已有行 id(供调用方决定是否建关联边 —— 旧脚本命中 dup 即跳过整条, 故**不建边**)。
   */
  async function createProduct(opts: {
    kind: "memory" | "knowledge" | "practice" | "skill" | "reflection";
    row: ExtractRow;
  }): Promise<ProductOutcome> {
    const { kind, row } = opts;
    // contentHash 的 pre-image 一律是 **行对象里的原始 title**(skill 用候选名, 不是归一后的 name),
    // 与旧直写 `sha256(c.title + c.content)` 逐字一致 —— 保证对历史行仍能命中。
    const hash = productHashForRow(kind, row);
    assertHash(row, hash, kind);

    if (kind === "memory") {
      // 2026-10-25 撤回流程补漏: 同内容判重只看活行 —— 被撤回的行不得再挡住同内容新记忆落库。
      const dup = await prisma.memory.findFirst({ where: liveRowWhere("memory", { contentHash: hash }), select: { id: true } });
      if (dup) return { status: "deduped", id: dup.id };
      const created = await safeCreateMemory(prisma, { data: rowToMemoryData(row, hash, sessionUid) });
      if (!created) return { status: "rejected", reason: "memory_rejected_by_write_gate(store 返回 null)" };
      return { status: "created", id: created.id };
    }
    if (kind === "knowledge") {
      // 2026-10-25 撤回流程补漏: 同上(Knowledge 有 stale 列)。
      const dup = await prisma.knowledge.findFirst({ where: liveRowWhere("knowledge", { contentHash: hash }), select: { id: true } });
      if (dup) return { status: "deduped", id: dup.id };
      const created = await safeCreateKnowledge(prisma, { data: rowToKnowledgeData(row, hash, sessionUid) });
      if (!created) return { status: "rejected", reason: "knowledge_rejected_by_cognitive_gate(store 返回 null)" };
      return { status: "created", id: created.id };
    }
    if (kind === "practice") {
      // 2026-10-25 撤回流程补漏: 同上(Practice 有 stale 列)。
      const dup = await prisma.practice.findFirst({ where: liveRowWhere("practice", { contentHash: hash }), select: { id: true } });
      if (dup) return { status: "deduped", id: dup.id };
      const created = await safeCreatePractice(prisma, { data: rowToPracticeData(row, hash, sessionUid) });
      if (!created) return { status: "rejected", reason: "practice_rejected_by_cognitive_gate(store 返回 null)" };
      return { status: "created", id: created.id };
    }
    if (kind === "reflection") {
      // 2026-11-05 ord-085: 反思持久化。此前提取链路完全不处理 reflections（脚本 0 处引用），
      //   导致 Reflection 表 11 天零新增 —— 不是模型不产，是没人接。
      const score = typeof row.score === "number" ? row.score : (typeof row.qualityScore === "number" ? row.qualityScore : null);
      if (score !== null && score < 0.6) return { status: "rejected", reason: "reflection_below_quality_gate(score=" + score + " < 0.6)" };
      const dup = await prisma.reflection.findFirst({ where: { contentHash: hash }, select: { id: true } });
      if (dup) return { status: "deduped", id: dup.id };
      const created = await safeCreateReflection(prisma, { data: rowToReflectionData(row, hash, sessionUid) });
      if (!created) return { status: "rejected", reason: "reflection_rejected_by_store(store 返回 null)" };
      return { status: "created", id: created.id };
    }
    // skill: 先做写侧硬上限判据(与 db-writer round74 同一实现), 超长 -> 降级 Knowledge
    const resolved = resolveSkillNameForWrite(row.title, row.shortenedName ?? null);
    if (resolved.tooLong || !resolved.name) {
      out.downgraded.skillNameTooLong++;
      const fbTitle = String(resolved.name || row.title || "").slice(0, 30);
      const fbDup = await prisma.knowledge.findFirst({ where: liveRowWhere("knowledge", { contentHash: hash }), select: { id: true } });
      if (fbDup) return { status: "deduped", id: fbDup.id };
      const fb = await safeCreateKnowledge(prisma, {
        data: rowToKnowledgeData(
          { ...row, title: fbTitle, tags: "skill-name-too-long", category: row.category || "OTHER",
            sourceDetail: `session-extract:${sessionUid} | downgraded=skill-name-too-long` },
          hash,
          sessionUid,
        ),
      });
      if (!fb) return { status: "rejected", reason: "skill-name-too-long 降级 Knowledge 被闸拒收" };
      return { status: "downgraded", id: fb.id };
    }
    // 2026-10-26: 查公共技能改走技术名（technicalName 优先，name 兜底）
    const nameDupId = await findPublicSkillId(prisma, resolved.name);
    const nameDup = nameDupId ? { id: nameDupId } : null;
    if (nameDup) return { status: "deduped", id: nameDup.id };
    const created = await safeCreateSkill(prisma, { data: rowToSkillData(row, resolved.name, hash, sessionUid) });
    if (!created) return { status: "rejected", reason: "skill_rejected_by_write_gate(store 返回 null)" };
    return { status: "created", id: created.id };
  }

  // ===== 产物: practice -> memory/knowledge/skill =====
  // 关联边依赖产物 id; 脚本已在行对象里带 id(genId, 与旧直写同形 cuid), 这里保留映射
  // (scriptId -> 实际落库 id), 供关联边解析 —— 行被 deduped/rejected 时其边不建(与旧脚本"dup 即 continue"一致)。
  const idByScriptId = new Map<string, string>();
  const order: Array<"practice" | "memory" | "knowledge" | "skill" | "reflection"> = ["practice", "memory", "knowledge", "skill", "reflection"];
  for (const kind of order) {
    const rows = batch.products?.[kind] || [];
    for (const row of rows) {
      const key = String(row.title ?? row.name ?? "").slice(0, 60);
      try {
        const r = await createProduct({ kind, row });
        if (r.status === "created") {
          out.applied[kind]++;
          if (str(row.id)) idByScriptId.set(String(row.id), r.id);
        } else if (r.status === "downgraded") {
          // 技能名超长 -> 降级为 Knowledge(内容不丢; downgraded.skillNameTooLong 已在分支里计)
          out.applied.knowledge++;
          if (str(row.id)) idByScriptId.set(String(row.id), r.id);
        } else if (r.status === "deduped") {
          out.deduped[kind]++;
        } else {
          reject(kind, key, r.reason);
        }
      } catch (e) {
        fail(kind, key, e);
      }
    }
  }

  // ===== 关联表(knowledge graph 的 derived_from_practice 边) =====
  // 旧实现 INSERT OR IGNORE; 这里按复合唯一键幂等。产物未落库(deduped/rejected)则边不建。
  async function createLink(opts: {
    section: string;
    key: string;
    exists: () => Promise<boolean>;
    create: () => Promise<unknown>;
  }): Promise<void> {
    try {
      if (await opts.exists()) {
        out.deduped.link++;
        return;
      }
      await opts.create();
      out.applied.link++;
    } catch (e) {
      fail(opts.section, opts.key, e);
    }
  }
  for (const l of batch.links?.practiceUsedMemory || []) {
    const practiceId = idByScriptId.get(String(l.practiceId || ""));
    const memoryId = idByScriptId.get(String(l.memoryId || ""));
    if (!practiceId || !memoryId) { out.deduped.link++; continue; }
    await createLink({
      section: "link.practiceUsedMemory", key: `${practiceId}/${memoryId}`,
      exists: async () => !!(await prisma.practiceUsedMemoryLink.findUnique({
        where: { practiceId_memoryId: { practiceId, memoryId } }, select: { practiceId: true },
      })),
      create: () => prisma.practiceUsedMemoryLink.create({
        data: { practiceId, memoryId, role: str(l.role) ?? "derived_from_practice", createdAt: toDate(l.createdAt) },
      }),
    });
  }
  for (const l of batch.links?.practiceKnowledge || []) {
    const practiceId = idByScriptId.get(String(l.practiceId || ""));
    const knowledgeId = idByScriptId.get(String(l.knowledgeId || ""));
    if (!practiceId || !knowledgeId) { out.deduped.link++; continue; }
    await createLink({
      section: "link.practiceKnowledge", key: `${practiceId}/${knowledgeId}`,
      exists: async () => !!(await prisma.practiceKnowledgeLink.findUnique({
        where: { practiceId_knowledgeId: { practiceId, knowledgeId } }, select: { practiceId: true },
      })),
      create: () => prisma.practiceKnowledgeLink.create({
        data: { practiceId, knowledgeId, applicationNote: str(l.applicationNote) ?? null },
      }),
    });
  }
  for (const l of batch.links?.practiceSkill || []) {
    const practiceId = idByScriptId.get(String(l.practiceId || ""));
    const skillId = idByScriptId.get(String(l.skillId || ""));
    if (!practiceId || !skillId) { out.deduped.link++; continue; }
    await createLink({
      section: "link.practiceSkill", key: `${practiceId}/${skillId}`,
      exists: async () => !!(await prisma.practiceSkillLink.findUnique({
        where: { practiceId_skillId: { practiceId, skillId } }, select: { practiceId: true },
      })),
      create: () => prisma.practiceSkillLink.create({
        data: { practiceId, skillId, role: str(l.role) ?? null, notes: str(l.notes) ?? null },
      }),
    });
  }

  // ===== 遗留项 -> 改进任务 =====
  for (const t of batch.tasks || []) {
    const key = String(t.title ?? "").slice(0, 60);
    try {
      const id = str(t.id);
      if (id) {
        const byId = await prisma.task.findUnique({ where: { id }, select: { id: true } });
        if (byId) { out.deduped.task++; continue; }
      }
      // 业务键去重: 同一(类型+完整标题)的活跃遗留任务已存在 -> 不再开单
      const active = await prisma.task.findFirst({
        where: {
          improvementType: str(t.improvementType) ?? "GOAL_GAP",
          title: String(t.title ?? ""),
          status: { in: ["PENDING", "PROCESSING", "IN_PROGRESS", "BLOCKED"] },
        },
        select: { id: true },
      });
      if (active) { out.deduped.task++; continue; }
      await prisma.task.create({
        data: {
          id: id || undefined,
          title: String(t.title ?? ""),
          description: String(t.description ?? ""),
          background: String(t.background ?? ""),
          requirements: String(t.requirements ?? ""),
          materials: String(t.materials ?? ""),
          acceptanceCriteria: String(t.acceptanceCriteria ?? ""),
          qualityStandards: String(t.qualityStandards ?? ""),
          status: "PENDING",
          priority: str(t.priority) ?? "P2",
          theme: str(t.theme) ?? null,
          improvementType: str(t.improvementType) ?? null,
          improvementPayload: str(t.improvementPayload) ?? null,
          manualReview: false,
          createdAt: toDate(t.createdAt),
        },
      });
      out.applied.task++;
    } catch (e) {
      fail("task", key, e);
    }
  }

  // ===== 观测事件 =====
  for (const e of batch.events || []) {
    const key = String(e.stage ?? "").slice(0, 40);
    try {
      const id = str(e.id);
      if (id) {
        const byId = await prisma.flywheelEvent.findUnique({ where: { id }, select: { id: true } });
        if (byId) { out.deduped.event++; continue; }
      }
      await prisma.flywheelEvent.create({
        data: {
          id: id || undefined,
          stage: String(e.stage ?? ""),
          sourceType: String(e.sourceType ?? "session-extract"),
          sourceId: String(e.sourceId ?? sessionUid),
          sourceTitle: String(e.sourceTitle ?? ""),
          targetStage: String(e.targetStage ?? "OK"),
          targetType: str(e.targetType) ?? null,
          targetId: str(e.targetId) ?? null,
          createdAt: toDate(e.createdAt),
        },
      });
      out.applied.event++;
    } catch (err) {
      fail("event", key, err);
    }
  }

  // ===== 会话内推翻 -> 撤回 Knowledge(必须在产物之后: 目标可能是本批刚建的 Knowledge) =====
  // 语义对齐 knowledge-retraction.retractKnowledge: 已 stale 且 supersededBy 未变 -> skipped(幂等);
  // 否则 stale=1 + staleReason + verification=REJECTED + AuditLog(RETRACT) + FlywheelEvent(RETRACTION)。
  for (const r of batch.retractions || []) {
    const id = String(r.knowledgeId || "");
    if (!id) continue;
    try {
      const row = await prisma.knowledge.findUnique({
        where: { id },
        select: { id: true, title: true, stale: true, staleReason: true, supersededBy: true, verification: true },
      });
      if (!row) { out.deduped.retraction++; continue; }
      const reason = String(r.reason || "").slice(0, 1000);
      const now = new Date();
      if (row.stale && !row.supersededBy) { out.deduped.retraction++; continue; }
      const staleReason = reason;
      const before = JSON.stringify({
        stale: row.stale, staleReason: row.staleReason, supersededBy: row.supersededBy, verification: row.verification,
      });
      await prisma.knowledge.update({
        where: { id },
        data: { stale: true, staleReason, verification: "REJECTED", updatedAt: now },
      });
      await prisma.auditLog.create({
        data: {
          entityType: "Knowledge", entityId: id, action: "RETRACT",
          actor: "session-extract", actorType: "SESSION_EXTRACT",
          before,
          after: JSON.stringify({ stale: true, staleReason, supersededBy: row.supersededBy, verification: "REJECTED" }),
          metadata: JSON.stringify({ verb: "retractKnowledge", reason, supersededBy: row.supersededBy }),
          createdAt: now,
        },
      });
      await prisma.flywheelEvent.create({
        data: {
          stage: "RETRACTION", sourceType: "KNOWLEDGE_RETRACTION", sourceId: "session-extract",
          sourceTitle: `撤回 ${id}: ${reason}`.slice(0, 400), targetStage: "KNOWLEDGE",
          targetType: "Knowledge", targetId: id, createdAt: now,
        },
      });
      out.applied.retraction++;
    } catch (e) {
      fail("retraction", id, e);
    }
  }

  return out;
}

// ============================================================
// 行对象 -> store data 映射(字段与旧直写 SQL 的列**逐字对齐**, 见 session-extract.ts insMemory/insKnowledge/...)
// ============================================================
function rowToMemoryData(row: ExtractRow, contentHash: string, sessionUid: string): any {
  return {
    id: str(row.id),
    content: String(row.content ?? ""),
    title: str(row.title) ?? null,
    tier: "WARM",
    type: str(row.type) ?? "EXPERIENCE",
    sourceType: "SESSION_EXTRACT",
    sourceId: sessionUid,
    agentSource: "SESSION_EXTRACT",
    contentHash,
    theme: str(row.theme) ?? null,
    qualityScore: typeof row.qualityScore === "number" ? row.qualityScore : undefined,
    summary: str(row.summary) ?? null,
    scenario: str(row.scenario) ?? null,
    sourcePracticeId: str(row.sourcePracticeId) ?? null,
    valueScore: typeof row.valueScore === "number" ? row.valueScore : undefined,
    importance: typeof row.importance === "number" ? row.importance : undefined,
    createdAt: toDate(row.createdAt),
  };
}

/** 2026-11-05 ord-085: Reflection 行映射（字段与 db-writer 的 reflection.create 对齐） */
function rowToReflectionData(row: ExtractRow, contentHash: string, sessionUid: string): any {
  const score = typeof row.score === "number" ? row.score : (typeof row.qualityScore === "number" ? row.qualityScore : undefined);
  return {
    id: str(row.id),
    title: String(row.title ?? "").slice(0, 120),
    description: String(row.description ?? row.content ?? ""),
    category: str(row.category) ?? "WORKFLOW",
    priority: str(row.priority) ?? "P2",
    lesson: str(row.lesson) ?? null,
    improvements: typeof row.improvements === "string" ? row.improvements : (row.improvements ? JSON.stringify(row.improvements) : null),
    score,
    sourceType: "SESSION_EXTRACT",
    sourceId: sessionUid,
    agentSource: "SESSION_EXTRACT",
    contentHash,
    theme: str(row.theme) ?? "未分类",
    processingVersion: "v3",
  };
}
function rowToKnowledgeData(row: ExtractRow, contentHash: string, sessionUid: string): any {
  return {
    id: str(row.id),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    qualityScore: typeof row.qualityScore === "number" ? row.qualityScore : undefined,
    sourceType: "SESSION_EXTRACT",
    sourceId: sessionUid,
    sourceDetail: str(row.sourceDetail) ?? null,
    agentSource: "SESSION_EXTRACT",
    category: str(row.category) ?? "OTHER",
    confidence: typeof row.confidence === "number" ? row.confidence : undefined,
    theme: str(row.theme) ?? null,
    contentHash,
    verification: str(row.verification) ?? null,
    humanConfirmed: false,
    sourcePracticeId: str(row.sourcePracticeId) ?? null,
    tags: str(row.tags) ?? null,
    createdAt: toDate(row.createdAt),
  };
}

function rowToPracticeData(row: ExtractRow, contentHash: string, sessionUid: string): any {
  return {
    id: str(row.id),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    type: str(row.type) ?? "OTHER",
    outcome: str(row.outcome) ?? "PARTIAL",
    qualityScore: typeof row.qualityScore === "number" ? row.qualityScore : undefined,
    difficulty: typeof row.difficulty === "number" ? row.difficulty : undefined,
    startedAt: toDate(row.startedAt) ?? new Date(),
    completedAt: toDate(row.completedAt) ?? null,
    agentSource: "SESSION_EXTRACT",
    sourceType: "SESSION_EXTRACT",
    sourceId: sessionUid,
    theme: str(row.theme) ?? null,
    contentHash,
    sourceIds: str(row.sourceIds) ?? null,
    taskRef: str(row.taskRef) ?? null,
    lesson: str(row.lesson) ?? null,
    outputs: str(row.outputs) ?? null,
    leftovers: str(row.leftovers) ?? null,
    createdAt: toDate(row.createdAt),
  };
}

function rowToSkillData(row: ExtractRow, name: string, contentHash: string, sessionUid: string): any {
  return {
    id: str(row.id),
    name,
    ...skillNameFields(name),
    category: str(row.category) ?? "OTHER",
    level: "AWARENESS",
    qualityScore: typeof row.qualityScore === "number" ? row.qualityScore : undefined,
    description: str(row.description) ?? null,
    summary: str(row.summary) ?? null,
    tags: str(row.tags) ?? null,
    content: str(row.content) ?? null,
    source: "SESSION_EXTRACT",
    theme: str(row.theme) ?? null,
    contentHash,
    sourceIds: str(row.sourceIds) ?? sessionUid,
    trigger: str(row.trigger) ?? null,
    verification: str(row.verification) ?? null,
    version: 1,
    legacy: false,
    sourcePracticeId: str(row.sourcePracticeId) ?? null,
    validatedByPracticeId: str(row.validatedByPracticeId) ?? null,
    createdAt: toDate(row.createdAt),
  };
}
