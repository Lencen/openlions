import { skillNameFields, upsertPublicSkill } from "./skill-naming";
import { prisma } from "@/lib/prisma";
import { PrismaClient } from "../../../node_modules/.prisma/mind-client";
import { createHash } from "crypto";
import type {
  ExtractedCognitiveData,
  ParsedConversation,
  PipelineResult,
} from "./types";
// 2026-07-02 STRUCTURED-V3: 候选池 + Resolver 决策
import {
  resolveCandidate,
  recordDecision,
  sha256 as resolverSha256,
  normalizeTheme,
  type ResolverAction,
} from "./resolver";

// 2026-07-12 PHASE-B 版本联动: Memory 更新触发下游 stale 标记
import { triggerVersionLinkage } from "@lions/modules-pipeline";
// 2026-10-09 round 72-G: Knowledge.content 结构拼装的单一来源(执行器同一实现)
import { composeKnowledgeContent as composeKnowledgeContentShared } from "./knowledge-compose";
// 2026-09-18 机制修复(人类决策「重复内容需要清理」): 标题逐字相同 + 正文近重复 -> 强化既有行而非新建
import { findNearDuplicateActiveId } from "./structured-dedup";
// 2026-09-23 uos20 #8: Skills 成功率 (生成即成功 + 候选分母), 与 db-writer 写入计数共用口径
import { computeSkillSuccessRate } from "./skill-success-rate";
// 2026-10-07 P4: LLM 直出枚举字段写入侧投影(受控枚举外的值不再原样落库, 见 enum-projection.ts 头注)
import { projectPracticeOutcome, normalizeEnumToken, projectDomain, projectCategory } from "./enum-projection";
// 2026-10-10 round 74 (agent-d, todo_47f179370e66425dbc8f): 技能名写侧硬上限收口。
//   实测泄漏点就是本文件: 这里直连 prisma.skill.upsert(不走 writeSkillDeduped), 而 prisma $extends
//   钩子用的 normalizeSkillName 默认**不做有损截断**(防"确定性截断把不同技能塌成同名"->假合并),
//   于是 >SKILL_NAME_MAX 的名字一路入库 -> spec:title-length "近 24h 超长 = 0" 必红
//   (实测 2026-10-10 三行 sourceLayer=SESSION_EXTRACT: "guard-registry 漂移修复与 HEAD 树复算" 等)。
//   归一是 skill-dedup 的同一实现(单一来源); 语义压缩用平台唯一实现 llmShortenOne。
import { normalizeSkillName as normalizeSkillNameMeta } from "./skill-dedup";
import { llmShortenOne, SKILL_NAME_MAX } from "../llm/shorten-title";
// 2026-10-10 round 57 G4: 主产线统一写入出口(store 内做受控投影 + qualityScore 兜底 + 标题归一 round58)
import { safeCreateMemory, safeCreateKnowledge, safeCreatePractice, safeCreateReflection } from "./safe-create";
// 遗留#8: modules-pipeline 未导出 Layer 类型, 本地定义 (数值层级)
type LinkageLayer = "memory" | "knowledge" | "practice" | "reflection" | "skill" | "L1" | "L2";

// 2026-06-06 SHARED-BRAIN-V2: sha256 helper for content 去重 key
// 用 createHash 直接 inline (避免 Next.js HMR 拆 chunk 后 function 找不到)
const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf-8").digest("hex");
(globalThis as any).__lions_sha256 = sha256;

// P0-A 2026-08-28: 写入层兜底, 防 LLM 输出 tags 为 JSON 数组时 Prisma 拒 String
// 解析层 cognitive-extractor.normalizeTags 是主防御, 这里做最后兜底
// 任何 ["a","b"] / "a,b" / "a, b" / null/undefined 都归一化为合法 String
function coerceTagsToString(raw: unknown): string | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    return raw.filter((x) => typeof x === "string" && x.trim()).join(",") || null;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length === 0 ? null : t;
  }
  // 其他类型 (number/boolean/object) 强转字符串, 防 Prisma 抛错
  const s = String(raw).trim();
  return s.length === 0 ? null : s;
}

// 2026-09-25 写入闸门(治本同类故障第 5 次, 治 scripts/repair-knowledge-orphan.cjs 根因):
// 早期某个 supersede 写入脚本把 title 当 id 写进 supersededBy 字段, 致 591 条 orphan 链断,
// service-check spec:Knowledge-structure 长报 FAIL。修法:supersededBy 必须以 cuid 前缀("cmu"开头, 长度 >= 20)打头, 否则
// 视为脏数据, 不写入(返回 null 让调用方当"未取代")。
// 这是"通用工具只在加法空间自动"原则的具体化(NORTH-STAR §D): 写时校验 + 治标 + 防再生。
function assertCuidOrNull(v: string | null | undefined, who: string): string | null {
  if (!v) return null;
  if (typeof v === "string" && /^cmu[a-z0-9]{16,}$/i.test(v)) return v;
  console.warn("[db-writer] rejected non-cuid supersededBy " + who + " got=" + JSON.stringify(v).slice(0, 80) + " (历史脏数据或写入脚本 bug; 见 docs/platform-logic/knowledge-orphan-2026-09-25.md)");
  return null;
}

/**
 * O6-V2: 分类型数据质量评估 (2026-08-25)
 * 5 种数据有不同质量维度, 不再用同一套正则
 */

// 标准主题列表 (O3 归一化后的)
// 2026-10-08 round 56a: calcQualityScore 等分数天平已搬到 @lions/product-contract(治本: 与 vocab.json 单一来源); 这里改为 re-export, 
//   mind 47 个调用点 (import from "./db-writer") 零改动, 行为与之前完全一致.
//   见 docs/platform-logic/round56a-quality-single-source-8dim-review-2026-10-08.md.
import {
  calcQualityScore, calcMemoryQuality, calcKnowledgeQuality, calcReflectionQuality, calcPracticeQuality, calcSkillQuality,
  STANDARD_THEMES, STANDARD_LEVELS,
} from "@lions/product-contract";
export {
  calcQualityScore, calcMemoryQuality, calcKnowledgeQuality, calcReflectionQuality, calcPracticeQuality, calcSkillQuality,
  STANDARD_THEMES, STANDARD_LEVELS,
} from "@lions/product-contract";

/**
 * 2026-10-10 round 74 (agent-d, todo_47f179370e66425dbc8f): 技能名写侧「能否落 Skill 表」的**纯判据**。
 *
 * 抽成纯函数是为了可复算单测(真库写路径无法在测试里反复跑):
 *   - raw 先走契约/ skill-dedup 同一实现的归一(去模板前缀/去括号补充, **不做有损截断**);
 *   - 归一后仍 >SKILL_NAME_MAX 时, 只接受调用方给的**语义压缩结果**(LLM, 且校验长度);
 *   - 仍不合规 -> tooLong=true, 调用方必须**降级/不写**, 绝不写超长 Skill, 也绝不用确定性截断
 *     (确定性截断会把不同技能塌成同名 -> 假技能合并, 见 product-contract normalizeSkillName 注释)。
 */
export function resolveSkillNameForWrite(
  raw: unknown,
  shortened?: string | null,
): { name: string; tooLong: boolean } {
  const nm = normalizeSkillNameMeta(raw);
  let name = nm.name || String(raw ?? "").trim();
  if (nm.tooLong) {
    const s = String(shortened ?? "").trim();
    if (s && s.length <= SKILL_NAME_MAX) name = s;
  }
  return { name, tooLong: !name || name.length > SKILL_NAME_MAX };
}

export async function writeToDatabase(
  conversation: ParsedConversation,
  extracted: ExtractedCognitiveData,
  options?: { sourceType?: string; runMode?: string }
): Promise<PipelineResult> {
  const stats = {
    memoriesCreated: 0,
    knowledgeCreated: 0,
    reflectionsCreated: 0,
    practicesCreated: 0,
    skillsCreated: 0,
    flywheelEventsCreated: 0,
    candidatesCreated: 0,
    candidatesUpdated: 0,
    candidatesMerged: 0,
    candidatesDiscarded: 0,
    // 2026-09-10: 补声明 (types.ts PipelineResult.stats 同步登记)
    memoriesDropped: 0,
    memoryTypesNormalized: 0,
    knowledgeDowngraded: 0,
    knowledgeDropped: 0,
    // 2026-09-23 uos20 #8: 降级数与成功率 (末尾 computeSkillSuccessRate 回填)
    skillsDowngraded: 0,
    resolverBreakdown: {
      memory:     { create: 0, update: 0, merge: 0, discard: 0 },
      knowledge:  { create: 0, update: 0, merge: 0, discard: 0 },
      reflection: { create: 0, update: 0, merge: 0, discard: 0 },
      practice:   { create: 0, update: 0, merge: 0, discard: 0 },
    },
  };

  const srcType = options?.sourceType || "CLAUDE_CONVERSATION";

  // 2026-07-02 STRUCTURED-V3: 认知条目走候选池 + Resolver
  // 输入: {type, content, title?, theme?} → 输出: CognitiveCandidate 落地 + Resolver 决策
  //   CREATE   → 调用方去正式表 create, 传回 finalId
  //   UPDATE   → 命中已有正式表行, reinforceCount+1, lastReinforce=now (不再新建)
  //   MERGE    → 老记录标 supersededBy=候选 id (占位), 调用方去正式表 create 新版本, 回填 supersededBy
  //   DISCARD  → 垃圾丢弃, 什么也不做
  // 返回 { action, targetId, candidateId } — 调用方按 action 分派
  async function runResolver(params: {
    type: "memory" | "knowledge" | "reflection" | "practice";
    content: string;
    title?: string | null;
    theme?: string | null;
  }): Promise<{
    action: ResolverAction;
    targetId?: string | null;
    candidateId: string;
    reason: string;
  }> {
    // O3: 主题归一化 -- 同义词映射到标准主题 (如 "卡住任务处理" -> "任务管理")
    const theme = normalizeTheme(params.theme) ?? null;
    const contentHash = resolverSha256(
      params.type === "knowledge" || params.type === "reflection"
        ? (params.title || "") + "\n" + params.content
        : params.content
    );
    // 先落候选池, 让 Resolver 决策后再回填 resolvedAt/resolverAction
    const candidate = await prisma.cognitiveCandidate.create({
      data: {
        type: params.type,
        content: params.content,
        title: params.title ?? null,
        theme: theme,  // O3: 用归一化后的 theme
        contentHash,
        agentSource: srcType,
        sourceType: srcType,
        sourceId: conversation.sessionId,
        confidence: 0.6,
        importance: 0.5,
        status: "PENDING",
        suggestedAction: "CREATE",
        evidenceId: null,
      },
    });
    const decision = await resolveCandidate(prisma as any, {
      id: candidate.id,
      type: params.type,
      content: params.content,
      title: params.title ?? null,
      contentHash,
      agentSource: srcType,
      sourceType: srcType,
      sourceId: conversation.sessionId,
      theme,  // O3: 传归一化后的 theme
    });
    // 更新候选状态
    await prisma.cognitiveCandidate.update({
      where: { id: candidate.id },
      data: {
        resolvedAt: new Date(),
        resolverAction: decision.action,
        resolvedTargetId: decision.targetId ?? null,
        status: decision.action === "DISCARD" ? "DISCARDED" : "APPLIED",
      },
    });
    // 计数
    stats.resolverBreakdown[params.type][
      decision.action === "CREATE"  ? "create"  :
      decision.action === "UPDATE"  ? "update"  :
      decision.action === "MERGE"   ? "merge"   : "discard"
    ]++;
    if (decision.action === "CREATE") stats.candidatesCreated++;
    else if (decision.action === "UPDATE") stats.candidatesUpdated++;
    else if (decision.action === "MERGE") stats.candidatesMerged++;
    else stats.candidatesDiscarded++;
    // 落 ResolverDecision 审计 (CREATE 的 finalId 后置回填)
    await recordDecision(prisma as any, {
      candidateId: candidate.id,
      type: params.type,
      action: decision.action,
      targetId: decision.targetId ?? null,
      reason: decision.reason,
    });
    // 2026-07-12 PHASE-B: UPDATE/MERGE (supersede 旧记录) → 触发版本联动
    // linkage 只覆盖 memory/knowledge/practice (reflection 不在联动网络)
    if (
      (decision.action === "UPDATE" || decision.action === "MERGE") &&
      decision.targetId &&
      (params.type === "memory" ||
        params.type === "knowledge" ||
        params.type === "practice")
    ) {
      try {
        // params.type 已收窄: memory=L1, knowledge/practice=L2
        const linkageLayer: LinkageLayer =
          params.type === "memory" ? "L1" : "L2";
        await triggerVersionLinkage(prisma as any, {
          sourceType: params.type,
          sourceId: decision.targetId,
          reason: `resolver ${decision.action}: ${decision.reason?.substring(0, 80) ?? ""}`,
          priority: 4,
        });
      } catch (linkageErr) {
        // 版本联动失败不影响主流程, 记 warn 即可
        console.warn(
          `[db-writer] triggerVersionLinkage failed for ${params.type}/${decision.targetId}:`,
          (linkageErr as Error).message
        );
      }
    }
    return {
      action: decision.action,
      targetId: decision.targetId ?? null,
      candidateId: candidate.id,
      reason: decision.reason,
    };
  }

  try {
    const sourceMeta = {
      sourceType: srcType,
      sourceId: conversation.sessionId,
    };

    // Write memories (STRUCTURED-V3: 走 Resolver 决策)
    // ===== 2026-09-03 记忆质量门槛 (用户拍板: type/theme 必填化 + 独立可理解) =====
    // ① 独立可理解: <20 字 / JSON 原文 / 系统残留前缀 → 不落库 (不算知识不算记忆)
    // ② type 规范化: 必须 DECISION/PREFERENCE/EXPERIENCE/CONTEXT, 缺失按内容启发式归类
    // ③ theme: 提取侧已 sanitizeTheme, 这里兜底置 null 走 Resolver (不强造主题)
    const MEM_TYPES = new Set(["DECISION", "PREFERENCE", "EXPERIENCE", "CONTEXT"]);
    const normMemType = (m: any): string => {
      const t = String(m.type || "").trim().toUpperCase();
      if (MEM_TYPES.has(t)) return t;
      const c = String(m.content || "");
      if (/(必须|应该|不要|避免|确保|禁止|一定要|不能|需要|务必)/.test(c)) return "DECISION";
      if (/(经验|教训|发现|导致|根因|原因是|因为|规律|模式|原则)/.test(c)) return "EXPERIENCE";
      if (/(偏好|喜欢|倾向|风格|习惯|倾向性)/.test(c)) return "PREFERENCE";
      return "CONTEXT";
    };
    const isDegenerateMemory = (m: any): boolean => {
      const c = String(m.content || "").trim();
      if (c.length < 20) return true;
      if (/^\s*\{/.test(c) && /"(summary|status|data|messages)"/.test(c)) return true; // JSON dump
      if (/^\[(反思|IMPORTANT|SYSTEM|system|cron|OpenClaw|Task:|MCP)/.test(c)) return true; // 系统残留/元日志
      return false;
    };
    for (const mem of extracted.memories) {
      // 门槛 ①: 退化内容直接丢弃 (统计上报, 不浪费 Resolver)
      if (isDegenerateMemory(mem)) {
        stats.memoriesDropped = (stats.memoriesDropped || 0) + 1;
        continue;
      }
      // 门槛 ②: type 规范化 (必填四枚举)
      const normType = normMemType(mem);
      if (normType !== (mem.type || "").trim()) {
        stats.memoryTypesNormalized = (stats.memoryTypesNormalized || 0) + 1;
        mem.type = normType;
      }
      const decision = await runResolver({
        type: "memory",
        content: mem.content,
        title: mem.title,
        theme: mem.theme ?? null,
      });
      let memoryId: string | null = null;

      if (decision.action === "DISCARD") {
        continue;
      } else if (decision.action === "UPDATE" && decision.targetId) {
        // 强化已有 Memory: reinforceCount+1, lastReinforce=now (不新建)
        await prisma.memory.update({
          where: { id: decision.targetId },
          data: {
            reinforceCount: { increment: 1 } as any,
            lastReinforce: new Date(),
            lastAccessed: new Date(),
            accessCount: { increment: 1 } as any,
          },
        });
        memoryId = decision.targetId;
        stats.memoriesCreated++; // 兼容语义: 保持老口径不变 (增强 == 一条产出)
      } else {
        // CREATE 或 MERGE 都要新建正式表; MERGE 时把老记录标 supersededBy=新 id
        // 2026-09-18 机制修复(人类决策「重复内容需要清理」): CREATE 前查近重复 ——
        //   同标题 + 正文近复述时强化既有 Memory, 不再插一行新的重复。
        const nearMemId = decision.action === "CREATE"
          ? await findNearDuplicateActiveId("memory", mem.title, mem.content)
          : null;
        if (nearMemId) {
          await prisma.memory.update({
            where: { id: nearMemId },
            data: { reinforceCount: { increment: 1 }, accessCount: { increment: 1 }, lastAccessed: new Date(), lastReinforce: new Date() },
          });
          memoryId = nearMemId;
          stats.memoriesCreated++;
        } else {
        const memory = await safeCreateMemory(prisma, {
          data: {
            content: mem.content,
            title: mem.title,
            tier: mem.tier,
            type: mem.type,
            // 2026-10-07 P4: domain 是受控 7 值, LLM 自由文本不得原样落库(归一 -> 关键词分类 -> null)
            domain: projectDomain(mem.domain, { title: mem.title, content: mem.content, theme: mem.theme }),
            tags: coerceTagsToString(mem.tags),
            valueScore: mem.valueScore,
            agentSource: srcType,
            contentHash: sha256(mem.content),
            theme: mem.theme ?? null,
            qualityScore: calcQualityScore({ type: "memory", content: mem.content, title: mem.title, theme: mem.theme, tags: mem.tags, valueScore: mem.valueScore, reinforceCount: (mem as any).reinforceCount ?? 0 }),  // O6-V2 (遗留#8: ExtractedMemory 无 reinforceCount 字段, 兼容)
            ...sourceMeta,
          },
        });
        // round 57 G4: store 的内容闸不合规会 return null(不是抛错) -> 显式跳过, 避免 TypeError
        if (!memory) { console.warn("[db-writer] memory 被 store 闸拒绝(内容不合规), 跳过: " + String(mem.title || "").slice(0, 60)); continue; }
        memoryId = memory.id;
        stats.memoriesCreated++;
        if (decision.action === "MERGE" && decision.targetId) {
          const sb = assertCuidOrNull(memory.id, "memory.MERGE " + decision.targetId);
          if (sb) {
            await prisma.memory.update({
              where: { id: decision.targetId },
              data: { supersededBy: sb, supersededAt: new Date() },
            });
          }
        }
        }
      }

      if (!memoryId) continue;

      // Auto-track MEMORIZE for each memory created/reinforced
      await prisma.flywheelEvent.create({
        data: {
          stage: "MEMORIZE",
          sourceType: srcType,
          sourceId: memoryId,
          sourceTitle: mem.title,
          targetStage: "KNOWLEDGE",
          createdAt: new Date(),
        },
      });
      stats.flywheelEventsCreated++;
    }

    // Write knowledge (STRUCTURED-V3: 走 Resolver)
    // ===== 2026-09-03 知识门禁 v1.1 (陈述式: 结论+原理+边界) =====
    // 2026-10-09 round 72-G: 本地实现抽到 knowledge-compose.ts(单一来源) ——
    //   执行器(execute-improving-task)也用它, 两处再各写一遍同一个拼装就是第三次"同一逻辑两份实现"。
    //   行为差异声明: 原实现写 "# 结论: <内容>", 共享实现写 "# 结论\n<内容>"(标题与正文分行, 更合
    //   markdown 习惯); 结构标记两者都满足认知闸, 且不传 maxLen 时**同样不截断**。
    const composeKnowledgeContent = (kn: any): string => composeKnowledgeContentShared({
      conclusion: kn.conclusion,
      principle: kn.principle,
      evidence: kn.evidence,
      boundary: kn.boundary,
      caseExample: kn.caseExample,
      fallback: kn.content,
    });
    for (const kn of extracted.knowledge) {
      const hasC = String(kn.conclusion || kn.content || "").trim().length > 0;
      const hasP = String(kn.principle || "").trim().length > 0;
      const hasB = String(kn.boundary || "").trim().length > 0;
      const legacyFormat = !kn.conclusion && !kn.principle && !kn.boundary && String(kn.content || "").trim().length > 0;
      if (!legacyFormat && (!hasC || !hasP || !hasB)) {
        const c1 = String(kn.conclusion || "").trim();
        if (c1.length >= 10) {
          // 单句判断(无原理/边界) → 降级 EXPERIENCE 记忆, 不丢
          try {
            await safeCreateMemory(prisma, {
              data: {
                content: c1,
                title: kn.title ? String(kn.title).slice(0, 80) : null,
                tier: "WARM",
                type: "EXPERIENCE",
                agentSource: srcType,
                theme: kn.theme ?? null,
                qualityScore: calcQualityScore({ type: "memory", content: c1 }),
                ...sourceMeta,
              },
            });
            stats.knowledgeDowngraded = (stats.knowledgeDowngraded || 0) + 1;
          } catch (e: any) { console.warn("[db-writer] knowledge downgrade memory failed:", e?.message); }
        } else {
          stats.knowledgeDropped = (stats.knowledgeDropped || 0) + 1;
        }
        continue;
      }
      if (!legacyFormat) kn.content = composeKnowledgeContent(kn);
      // 2026-09-10: content 可能为 undefined (extractor 放宽), 归一化以满足下游 string 契约
      kn.content = kn.content ?? "";
      const decision = await runResolver({
        type: "knowledge",
        content: kn.content,
        title: kn.title,
        theme: kn.theme ?? null,
      });

      if (decision.action === "DISCARD") continue;

      if (decision.action === "UPDATE" && decision.targetId) {
        await prisma.knowledge.update({
          where: { id: decision.targetId },
          data: {
            reinforceCount: { increment: 1 } as any,
            usageCount: { increment: 1 } as any,
            lastUsedAt: new Date(),
          },
        });
        stats.knowledgeCreated++;
      } else {
        const kHash = sha256(kn.title + "\n" + kn.content);
        // 2026-09-18 机制修复(人类决策「重复内容需要清理」): CREATE 前查近重复 ——
        //   同标题 + 正文近复述(LLM 重新措辞)时强化既有行, 不再插一行新的重复 Knowledge。
        const nearId = decision.action === "CREATE"
          ? await findNearDuplicateActiveId("knowledge", kn.title, kn.content)
          : null;
        if (nearId) {
          await prisma.knowledge.update({
            where: { id: nearId },
            data: { reinforceCount: { increment: 1 }, usageCount: { increment: 1 }, lastUsedAt: new Date() },
          });
          stats.knowledgeCreated++;
        } else {
          // 2026-09-29 round 8: V3 软验证 inline (同 Memory pattern round 7; K 有 stale 列 → 标 stale)
          if ((kn.title || "").length > 30 || /未记录|对话[中里]|对话提到|对话中|对话暗示|暂未记录|无对应知识|未明确|需调研|后[补续]|无对应[库知]/.test(kn.content || "")) {
            try {
              const _draftK = await safeCreateKnowledge(prisma, {
                data: { title: kn.title, content: kn.content, sourceType: "FLYWHEEL_STRUCTURED", sourceId: "draft:" + sha256(kn.title + "\n" + kn.content).slice(0, 12), category: projectCategory(kn.category, "knowledge") ?? "draft", agentSource: srcType, theme: kn.theme ?? null, contentHash: sha256(kn.title + "\n" + kn.content), stale: true, staleReason: "V3 格式不合规 (db-writer soft validation round 8)" },
              });
              // 2026-10-11 round 73b: store 内容闸 enforce 档会 return null(不抛错) -> 必须显式判空,
              //   否则 `_draftK.id` 就是 TypeError(质量闸变可用性事故)。主路径同款写法见 `if (!knowledge)`。
              if (!_draftK) {
                console.warn("[db-writer] K draft 被 store 闸拒绝, 跳过 stale 标记");
              } else {
                await prisma.knowledge.update({ where: { id: _draftK.id }, data: { stale: true } });
              }
            } catch (e: any) { console.warn("[db-writer] K stale 标失败:", e?.message); }
            stats.knowledgeDropped = (stats.knowledgeDropped || 0) + 1;
            continue;
          }
        const knowledge = await safeCreateKnowledge(prisma, {
          data: {
            title: kn.title,
            content: kn.content,
            qualityScore: calcQualityScore({ type: "knowledge", content: kn.content, title: kn.title, category: kn.category, tags: coerceTagsToString(kn.tags), confidence: kn.confidence }),  // 2026-08-27 补齐 5 表覆盖
            // 2026-10-08 round 54: category 过受控投影(写入侧闸门; 见 spec:enum-write-sites)
            category: projectCategory(kn.category, "knowledge") ?? "OTHER",
            tags: coerceTagsToString(kn.tags),
            confidence: kn.confidence,
            agentSource: srcType,
            theme: kn.theme ?? null,
            contentHash: kHash,
            ...sourceMeta,
          },
        });
        if (!knowledge) { console.warn("[db-writer] knowledge 被 store 闸拒绝(内容不合规), 跳过 supersede 回填"); }
        stats.knowledgeCreated++;
        if (knowledge && decision.action === "MERGE" && decision.targetId) {
          const sb = assertCuidOrNull(knowledge.id, "knowledge.MERGE " + decision.targetId);
          if (sb) {
            await prisma.knowledge.update({
              where: { id: decision.targetId },
              data: { supersededBy: sb, supersededAt: new Date() },
            });
          }
        }
        }
      }

      // Flywheel: KNOWLEDGE stage
      await prisma.flywheelEvent.create({
        data: {
          stage: "KNOWLEDGE",
          sourceType: srcType,
          sourceId: kn.title,
          sourceTitle: kn.title,
          targetStage: "PRACTICE",
          createdAt: new Date(),
        },
      });
      stats.flywheelEventsCreated++;
    }

    // Write reflections (STRUCTURED-V3: 走 Resolver)
    for (const ref of extracted.reflections) {
      const reflectionText = ref.description || ref.lesson || ref.title;
      const decision = await runResolver({
        type: "reflection",
        content: reflectionText,
        title: ref.title,
        theme: ref.theme ?? null,
      });

      if (decision.action === "DISCARD") continue;

      let reflection: { id: string } | null = null;

      if (decision.action === "UPDATE" && decision.targetId) {
        // 强化: reinforceCount+1, 保留原始 V3 字段
        reflection = await prisma.reflection.update({
          where: { id: decision.targetId },
          data: {
            reinforceCount: { increment: 1 } as any,
            updatedAt: new Date(),
          },
          select: { id: true },
        });
        stats.reflectionsCreated++;
      } else {
        const rHash = sha256(ref.title + "\n" + reflectionText);
        reflection = await safeCreateReflection(prisma, {
          data: {
            title: ref.title,
            description: ref.description,
            category: ref.category,
            priority: ref.priority,
            lesson: ref.lesson,
            improvements:
              Array.isArray(ref.improvements)
                ? JSON.stringify(ref.improvements)
                : ref.improvements ?? null,
            // 2026-09-29 (agent-d 休假期间): Reflection 加质量评分
            // 之前 ref.score 用 LLM 自评没门, 现在: 有 LLM 自评用之, 否则 calcQualityScore (与 product-quality.ts 同源)
            score: typeof ref.score === "number" && Number.isFinite(ref.score)
              ? Math.max(0, Math.min(1, ref.score))
              : calcQualityScore({
                  type: "reflection",
                  content: reflectionText,
                  title: ref.title,
                  theme: ref.theme ?? null,
                  priority: ref.priority ?? null,
                  lesson: ref.lesson ?? "",
                }),
            sourceType: srcType,
            sourceId: conversation.sessionId,
            agentSource: srcType,
            contentHash: rHash,
            // === V3 结构化字段 ===
            theme: ref.theme || "未分类",
            actionType: ref.actionType || "NONE",
            actionConfidence: ref.actionConfidence ?? 0,
            structuredImprovements: ref.structuredImprovements
              ? JSON.stringify(ref.structuredImprovements)
              : null,
            relatedMemoryIds: ref.relatedRefs?.memories?.join(",") || null,
            relatedKnowledgeIds: ref.relatedRefs?.knowledge?.join(",") || null,
            relatedSessionIds: ref.relatedRefs?.sessions?.join(",") || conversation.sessionId || null,
            relatedProblemIds: ref.relatedRefs?.problems?.join(",") || null,
            rootCauseAnalysis: ref.rootCauseAnalysis || null,
            proposedPlan: ref.proposedPlan || null,
            processingVersion: ref.processingVersion || "v3",
          },
          select: { id: true },
        });
        stats.reflectionsCreated++;
        if (reflection && decision.action === "MERGE" && decision.targetId) {
          const sb = assertCuidOrNull(reflection.id, "reflection.MERGE " + decision.targetId);
          if (sb) {
            await prisma.reflection.update({
              where: { id: decision.targetId },
              data: { supersededBy: sb, supersededAt: new Date() },
            });
          }
        }
      }

      if (!reflection) continue;

      // Flywheel: REFLECT -> MEMORIZE
      await prisma.flywheelEvent.create({
        data: {
          stage: "REFLECT",
          sourceType: srcType,
          sourceId: reflection.id,
          sourceTitle: ref.title,
          targetStage: "MEMORIZE",
          targetType: "MEMORY",
          targetId: ref.title,
          createdAt: new Date(),
        },
      });
      stats.flywheelEventsCreated++;

      // If high-value reflection, also derive a memory — 也走 Resolver 避免 lesson 重复灌入
      if (ref.score && ref.score >= 0.7 && ref.lesson) {
        const derivedDecision = await runResolver({
          type: "memory",
          content: ref.lesson,
          title: `反思: ${ref.title}`,
          theme: ref.theme ?? null,
        });
        if (derivedDecision.action === "CREATE" || derivedDecision.action === "MERGE") {
          const derived = await safeCreateMemory(prisma, {
            data: {
              content: ref.lesson,
              title: `反思: ${ref.title}`,
              tier: ref.priority === "P1" ? "HOT" : "WARM",
              type: "REFLECTION",
              // 2026-10-07 P4: ref.category 属"反思类别词表"(WORKFLOW|TECH|...), 不是 domain 词表 ——
              //   原文已完整保留在 tags 里, 这里走受控投影(命中则归一, 否则 null, 不再把类别冒充领域)
              domain: projectDomain(ref.category, { title: ref.title, content: ref.lesson, theme: ref.theme, category: ref.category }),
              tags: ref.category,
              valueScore: ref.score,
              agentSource: srcType,
              contentHash: sha256(ref.lesson),
              theme: ref.theme ?? null,
              // 2026-10-09 round 72-B: 补 qualityScore(此前只写 valueScore -> qualityScore 列默认 0 ->
              //   该行"看起来有分"却隐形于质量门; 由 check-enum-write-sites 棘轮抓出)
              qualityScore: calcQualityScore({ type: "memory", content: ref.lesson, title: `反思: ${ref.title}`, theme: ref.theme, tags: ref.category, valueScore: ref.score }),
              ...sourceMeta,
            },
          });
          if (!derived) { console.warn("[db-writer] derived memory 被 store 闸拒绝(内容不合规), 跳过 supersede 回填"); }
          stats.memoriesCreated++;
          if (derived && derivedDecision.action === "MERGE" && derivedDecision.targetId) {
            const sb = assertCuidOrNull(derived.id, "memory.DERIVED_MERGE " + derivedDecision.targetId);
            if (sb) {
              await prisma.memory.update({
                where: { id: derivedDecision.targetId },
                data: { supersededBy: sb, supersededAt: new Date() },
              });
            }
          }
        } else if (derivedDecision.action === "UPDATE" && derivedDecision.targetId) {
          await prisma.memory.update({
            where: { id: derivedDecision.targetId },
            data: {
              reinforceCount: { increment: 1 } as any,
              lastReinforce: new Date(),
            },
          });
          stats.memoriesCreated++;
        }
      }
    }

    // Write practices (STRUCTURED-V3: 走 Resolver; Output/Flywheel 副产物只在 CREATE/MERGE 生效)
    const createdPracticeIds: string[] = []; // SKILL-SPEC P1.5: 供 skill 回写 PracticeSkillLink
    for (const pr of extracted.practices) {
      const practiceText = pr.description || pr.title;
      const decision = await runResolver({
        type: "practice",
        content: practiceText,
        title: pr.title,
        theme: pr.theme ?? null,
      });

      if (decision.action === "DISCARD") continue;

      let practice: { id: string } | null = null;
      let isNew = false; // 只有 CREATE/MERGE 才落 Output + PRACTICE flywheel

      if (decision.action === "UPDATE" && decision.targetId) {
        practice = await prisma.practice.update({
          where: { id: decision.targetId },
          data: {
            reinforceCount: { increment: 1 } as any,
            updatedAt: new Date(),
          },
          select: { id: true },
        });
        stats.practicesCreated++;
      } else {
          // 2026-09-29 round 8: V3 软验证 inline (同 K pattern; P 有 stale 列 → 标 stale)
          if ((pr.title || "").length > 30 || /未记录|对话[中里]|对话提到|对话中|对话暗示|暂未记录|无对应知识|未明确|需调研|后[补续]|无对应[库知]/.test(pr.description || "")) {
            try {
              const _draftP = await safeCreatePractice(prisma, {
                // 2026-10-11 round 74: 补 qualityScore —— 本条 V3 软验证 draft 分支此前漏写,
                //   是全库仅存的 2 条 Practice.qualityScore IS NULL 的来源(实测 cmv2fs6bj…/cmv2w0t83…)。
                //   漏写后果同 check-product-quality-scored 头部: 该行隐形于 AVG/质量闸门(读数偏乐观)。
                //   draft 也许打分, 与主分支同源 calcQualityScore; 打分用投影前原值即可(draft 不落业务口径)。
                data: { title: pr.title, description: pr.description || "", type: pr.type || "PROCEDURE", outcome: "FAILED", qualityScore: calcQualityScore({ type: "practice", content: pr.description || pr.title, title: pr.title, theme: pr.theme, type2: pr.type || "PROCEDURE", outcome: "FAILED" }), startedAt: new Date(), theme: pr.theme ?? null, agentSource: srcType, stale: true, staleReason: "V3 格式不合规 (db-writer soft validation round 8)" },
              });
              // 2026-10-11 round 73b: 同 K draft —— store 闸拒绝时返回 null, 显式判空避免 _draftP.id TypeError。
              if (!_draftP) {
                console.warn("[db-writer] P draft 被 store 闸拒绝, 跳过 stale 标记");
              } else {
                await prisma.practice.update({ where: { id: _draftP.id }, data: { stale: true } });
              }
            } catch (e: any) { console.warn("[db-writer] P stale 标失败:", e?.message); }
            continue;
          }
        const pHash = sha256(pr.title + "\n" + practiceText);
        // 2026-10-07 P4: outcome 是 LLM 直出字段 -> 写入侧白名单投影(去空格/大写命中枚举, 其余 -> UNKNOWN);
        //   type 只做大小写归一(平台多路径各自用值, 不替换)。打分用投影后的值 -> 与落库值同源。
        const pOutcome = projectPracticeOutcome(pr.outcome);
        const pType = normalizeEnumToken(pr.type);
        practice = await safeCreatePractice(prisma, {
          data: {
            title: pr.title,
            description: pr.description,
            type: pType,
            outcome: pOutcome,
            qualityScore: pr.qualityScore ?? calcQualityScore({ type: "practice", content: practiceText, title: pr.title, theme: pr.theme, type2: pType, outcome: pOutcome, difficulty: pr.difficulty }),  // 2026-09-29 (agent-d): 已在写入前确保 qualityScore 有值 (O6-V2)
            difficulty: pr.difficulty,
            startedAt: conversation.startTime
              ? new Date(conversation.startTime)
              : new Date(),
            completedAt: conversation.endTime
              ? new Date(conversation.endTime)
              : new Date(),
            agentSource: srcType,
            theme: pr.theme ?? null,
            contentHash: pHash,
          },
          select: { id: true },
        });
        stats.practicesCreated++;
        isNew = true;
        if (practice) createdPracticeIds.push(practice.id); // P1.5: 记录新建 practice
        if (practice && decision.action === "MERGE" && decision.targetId) {
          const sb = assertCuidOrNull(practice.id, "practice.MERGE " + decision.targetId);
          if (sb) {
            await prisma.practice.update({
              where: { id: decision.targetId },
              data: { supersededBy: sb, supersededAt: new Date() },
            });
          }
        }
      }

      if (!practice) continue;

      // Flywheel: PRACTICE -> OUTCOME (每次都记, 强化实践跟踪信号)
      await prisma.flywheelEvent.create({
        data: {
          stage: "PRACTICE",
          sourceType: srcType,
          sourceId: pr.title,
          sourceTitle: pr.title,
          targetStage: "OUTCOME",
          createdAt: new Date(),
        },
      });
      stats.flywheelEventsCreated++;

      // Auto-track OUTCOME + create Output — 仅 CREATE/MERGE 时创建新 Output, UPDATE 不重复落
      if (
        isNew &&
        (pr.outcome === "SUCCESS" || (pr.qualityScore && pr.qualityScore >= 0.7))
      ) {
        await prisma.flywheelEvent.create({
          data: {
            stage: "OUTCOME",
            sourceType: srcType,
            sourceId: pr.title,
            sourceTitle: pr.title,
            targetStage: "EVALUATE",
            createdAt: new Date(),
          },
        });
        stats.flywheelEventsCreated++;

        const qualityScore = pr.qualityScore ?? 0.7;
        const quality =
          pr.outcome === "SUCCESS" && qualityScore >= 0.85 ? "EXCEPTIONAL" :
          pr.outcome === "SUCCESS" && qualityScore >= 0.7  ? "GOOD" :
          pr.outcome === "SUCCESS" && qualityScore >= 0.5  ? "FAIR" : "POOR";

        const output = await prisma.output.create({
          data: {
            title: pr.title,
            type: pr.type,
            quality,
            qualityScore,
            sourceId: practice.id,
          },
        });

        await prisma.practiceOutputLink.create({
          data: { practiceId: practice.id, outputId: output.id },
        });
      }

      // Auto-track EVALUATE — 分数触发, 每次都记 (反映"再次评估")
      if (pr.qualityScore && pr.qualityScore >= 0.6) {
        await prisma.flywheelEvent.create({
          data: {
            stage: "EVALUATE",
            sourceType: srcType,
            sourceId: pr.title,
            sourceTitle: pr.title,
            targetStage: "LEARN",
            createdAt: new Date(),
          },
        });
        stats.flywheelEventsCreated++;
      }
    }

    // Write skills (upsert to avoid duplicates)
    // ===== SKILL-SPEC 2026-08-28 (docs/SKILL-SPEC.md) =====
    // 铁律: 无 steps 不成 skill。extracted.skills 已在 cognitive-extractor 过滤 (content>=30字),
    // 此处再防御一层: steps 不足 30 字的跳过 Skill 表, 归入 knowledgeFromSkills 流程
    for (const sk of extracted.skills) {
      const steps = (sk.content || "").trim();
      if (steps.length < 30) {
        // 防御性降级: 不丢数据, 进 knowledge
        await safeCreateKnowledge(prisma, {
          data: {
            title: sk.name,
            content: [sk.description, steps].filter(Boolean).join("\n") || sk.name,
            qualityScore: calcQualityScore({ type: "knowledge", content: sk.description || sk.name, title: sk.name, category: "PROCESS", tags: "skill-downgraded", confidence: 0.5 }),
            category: "PROCESS",
            tags: "skill-downgraded",
            confidence: 0.5,
            agentSource: srcType,
            ...sourceMeta,
          },
        });
        stats.knowledgeCreated++;
        stats.skillsDowngraded++; // uos20 #8: 无 steps 技能 -> knowledge, 计入降级数(分母不减)
        continue;
      }
      // 2026-10-10 round 74 (agent-d, todo_47f179370e66425dbc8f): 技能名硬上限写侧收口。
      //   不变量: spec:title-length 要求新写 Skill.name <= SKILL_NAME_MAX(20);
      //   设计约束: 契约 normalizeSkillName 禁止确定性有损截断(会把 'Prisma schema设计与migration' /
      //   'Prisma ORM与DateTime处理' 塌成同名 "Prisma", 制造假技能合并 —— 见 product-contract 注释)。
      //   两条同时满足的唯一出口 = 语义压缩(LLM)。顺序: ① 净化归一; ② 仍超长 -> llmShortenOne;
      //   ③ 压缩也未收口 -> 降级为 Knowledge(保内容不丢), 绝不写超长 Skill, 也绝不截断。
      const nm = normalizeSkillNameMeta(sk.name);
      let shortened: string | null = null;
      if (nm.tooLong) {
        try {
          shortened = await llmShortenOne(nm.name || String(sk.name || "").trim(), "skill");
        } catch { /* LLM 不可用/超时 -> shortened=null, 走降级, 绝不阻断主流程 */ }
      }
      const resolved = resolveSkillNameForWrite(sk.name, shortened);
      if (resolved.tooLong) {
        const fbName = resolved.name || String(sk.name || "");
        await safeCreateKnowledge(prisma, {
          data: {
            title: fbName.slice(0, 30),
            content: [sk.description, steps].filter(Boolean).join("\n") || fbName,
            qualityScore: calcQualityScore({ type: "knowledge", content: sk.description || fbName, title: fbName.slice(0, 30), category: "PROCESS", tags: "skill-name-too-long", confidence: 0.5 }),
            category: "PROCESS",
            tags: "skill-name-too-long",
            confidence: 0.5,
            agentSource: srcType,
            ...sourceMeta,
          },
        });
        stats.knowledgeCreated++;
        stats.skillsDowngraded++; // 名称超长语义压缩未收口 -> 降级 knowledge, 计入降级数(分母不减)
        continue;
      }
      const skillName = resolved.name;
      const sHash = sha256(skillName + "\n" + steps);
      // 2026-10-26: 改为 upsertPublicSkill —— 先按 technicalName 查公共技能，有则更新、无则创建。
      //   不用 prisma.upsert 的原因：upsert 需要唯一键，technicalName 的唯一性是部分唯一索引（Prisma 不能声明）。
      const skillRec = await upsertPublicSkill(prisma, skillName, {
        // P1.5 2026-08-28: update 分支补齐 SKILL-SPEC 字段, 同名技能再次提取时更新内容
          ...skillNameFields(skillName),
          description: sk.description ?? undefined,
          content: steps || undefined,
          trigger: sk.trigger || sk.description || undefined,
          verification: sk.verification || undefined,
          pitfalls: sk.pitfalls || undefined,
          // 2026-09-03: 技能溯源 — reflect 主题提取的技能补 theme/sourceLayer (聚合闭环 STEP5 格式化)
          ...(sk.theme ? { theme: sk.theme, sourceLayer: "REFLECT_LEARN" } : {}),
          qualityScore: calcQualityScore({ type: "skill", content: steps + "\n" + sk.description, name: skillName, category: sk.category, level: sk.level, trigger: sk.trigger, verification: sk.verification }),
        }, {
          name: skillName,
          ...skillNameFields(skillName),
          category: sk.category,
          level: sk.level || "AWARENESS",
          description: sk.description,
          // SKILL-SPEC 7 字段: steps 承载于 content
          content: steps,
          trigger: sk.trigger || sk.description || "",
          verification: sk.verification || "",
          pitfalls: sk.pitfalls || "",
          version: 1,
          qualityScore: calcQualityScore({ type: "skill", content: steps + "\n" + sk.description, name: skillName, category: sk.category, level: sk.level, trigger: sk.trigger, verification: sk.verification }),  // 2026-08-28 P1.5: 以 steps/trigger/verification 为主体计分
          contentHash: sHash,
          // 2026-09-03: 技能溯源 — theme 在主题聚合提取时由调用方回填 (聚合闭环 STEP5); 会话级提取先标来源层
          theme: sk.theme ?? null,
          sourceLayer: "SESSION_EXTRACT",
          // 注意: Skill 表无 sourceType/sourceId/agentSource 字段, 不展开 sourceMeta (Prisma runtime 会拒 unknown arg)
        }
      );
      stats.skillsCreated++;

      // ===== SKILL-SPEC P1.5 实践回写: 本次新建 Practice 用到该技能 -> Link + totalUsageCount+1 =====
      // 语义: 只有新建 practice 才算一次真实使用 (UPDATE 强化不重复计数)
      if (createdPracticeIds.length > 0) {
        for (const pid of createdPracticeIds) {
          try {
            await prisma.practiceSkillLink.create({
              data: { practiceId: pid, skillId: skillRec.id, role: "USED" },
            });
          } catch {
            /* @@unique(practiceId,skillId) 冲突 = 已关联, 幂等跳过 */
          }
        }
        await prisma.skill.update({
          where: { id: skillRec.id },
          data: {
            totalUsageCount: { increment: createdPracticeIds.length },
            validatedByPracticeId: createdPracticeIds[createdPracticeIds.length - 1],
          },
        });
      }
    }

    // SKILL-SPEC 2026-08-28: extractor 降级的"无步骤技能" -> knowledge (PROCESS), 不丢数据
    for (const kn of extracted.knowledgeFromSkills || []) {
      kn.content = kn.content ?? ""; // 2026-09-10: 同上归一化
      await safeCreateKnowledge(prisma, {
        data: {
          title: kn.title,
          content: kn.content,
          qualityScore: calcQualityScore({ type: "knowledge", content: kn.content, title: kn.title, category: kn.category, tags: coerceTagsToString(kn.tags), confidence: kn.confidence }),
          category: kn.category,
          tags: coerceTagsToString(kn.tags),
          confidence: kn.confidence,
          agentSource: srcType,
          ...sourceMeta,
        },
      });
      stats.knowledgeCreated++;
      stats.skillsDowngraded++; // uos20 #8: extractor 判定的无步骤技能候选
    }

    // ===== 2026-09-23 uos20 #8 Skills 成功率 (轻量版) =====
    // 口径: 生成即成功 = 过 SKILL-SPEC 落 Skill 表 / (落表 + 降级进 knowledge),
    //       两位小数 + 原始分子分母 (skillsCreated / skillsDowngraded / skillCandidatesTotal)。
    //       独立于 totalRecordsCreated, 避免 skill=0 被聚合掩盖 (反思 cmuc5i8y600481hqrpge36ihb)。
    {
      const ssr = computeSkillSuccessRate(stats.skillsCreated, stats.skillsDowngraded);
      // Object.assign: stats 的静态推断类型不含成功率字段, 运行时挂上 (返回时 extra props 兼容 PipelineResult)
      Object.assign(stats, ssr);
    }
    const hasContent =
      stats.memoriesCreated > 0 ||
      stats.knowledgeCreated > 0 ||
      stats.reflectionsCreated > 0;

    if (hasContent) {
      await prisma.flywheelEvent.create({
        data: {
          stage: "LEARN",
          sourceType: srcType,
          sourceId: conversation.sessionId,
          sourceTitle: conversation.title || extracted.summary || "对话",
          targetStage: stats.reflectionsCreated > 0 ? "REFLECT" : "MEMORIZE",
          createdAt: new Date(),
        },
      });
      stats.flywheelEventsCreated++;
    }

    // Create sync log (upsert to handle re-runs cleanly)
    await prisma.syncLog.upsert({
      where: { sourcePath: conversation.sessionId },
      update: { status: "COMPLETED", lastSyncAt: new Date(), recordsSynced: stats.memoriesCreated + stats.knowledgeCreated + stats.reflectionsCreated + stats.practicesCreated + stats.skillsCreated },
      create: {
        sourceType: srcType,
        sourcePath: conversation.sessionId,
        status: "COMPLETED",
        recordsSynced:
          stats.memoriesCreated +
          stats.knowledgeCreated +
          stats.reflectionsCreated +
          stats.practicesCreated +
          stats.skillsCreated,
        messageCount: conversation.messageCount,
        runMode: options?.runMode || "AUTO",
        completedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.syncLog.upsert({
      where: { sourcePath: conversation.sessionId },
      update: { status: "FAILED", lastSyncAt: new Date(), errorMessage: error instanceof Error ? error.message : "Unknown error" },
      create: {
        sourceType: srcType,
        sourcePath: conversation.sessionId,
        status: "FAILED",
        errorMessage:
          error instanceof Error ? error.message : "Unknown error",
        runMode: options?.runMode || "AUTO",
      },
    });
    throw error;
  }
  // P2 修复 2026-08-28: 删除 finally 里的 prisma.$disconnect()
  // writeToDatabase 跑在 Next.js 服务进程 (tRPC processPipeline / API 路由) 内,
  // disconnect 全局共享 PrismaClient 会让后续所有 prisma 调用报 "Engine is not yet connected"。
  // 进程退出时连接自动清理, 无需手动断开。
  // 2026-08-21 leo: 写 SyncLog (让后续 getAlreadyProcessedConversations 能正确识别)
  //   之前: pipeline 写完 5 表但完全不写 SyncLog, 导致 next tick 又把同一 session 当 new
  //   之前 SyncLog 只在 hermes-session-scanner.ts 写, key 是 UUID; 这里统一用 filePath
  try {
    const msgCount = conversation.messages?.length || 0;
    await prisma.syncLog.upsert({
      where: { sourcePath: conversation.filePath },
      create: {
        sourceType: srcType,
        sourcePath: conversation.filePath,
        status: "COMPLETED",
        messageCount: msgCount,
        recordsSynced: stats.memoriesCreated + stats.knowledgeCreated + stats.reflectionsCreated + stats.practicesCreated + stats.skillsCreated,
        recordsSkipped: 0,
        runMode: options?.runMode || "MANUAL",
        startedAt: new Date(),
        completedAt: new Date(),
        lastSyncAt: new Date(),
      },
      update: {
        status: "COMPLETED",
        messageCount: msgCount,
        recordsSynced: stats.memoriesCreated + stats.knowledgeCreated + stats.reflectionsCreated + stats.practicesCreated + stats.skillsCreated,
        completedAt: new Date(),
        lastSyncAt: new Date(),
      },
    });
  } catch (e) {
    // SyncLog 写入失败不阻塞主流程, 仅记录
    console.error("[writeToDatabase] SyncLog upsert failed:", e instanceof Error ? e.message : String(e));
  }

  return { conversation, extracted, stats };
}
