/**
 * POST /api/v1/ingest — portal 写转发入口 (2026-10-15 架构收敛: portal 不再直连写 mind 生产库)
 *
 * 背景: portal 的 `/api/portal/ingest` 原先**直连 Prisma 写** mind 生产库(Knowledge/Reflection/
 *   FlywheelEvent + PrismaMemoryStore), 使 `scripts/mind-db-recover.cjs` 的"除 mind 外 0 持有者"
 *   硬闸常态 exit 4, 库损坏连续数周无法修复(见 scripts/DB-ACCESS-RULE.md §1/§3.1)。
 *   本端点承接 portal 的转发: portal 不再写库, 由 **mind 自己**走平台既有写入路径落库。
 *
 * 语义等价(逐条对齐 portal 原实现 packages/apps/portal/src/app/api/portal/ingest/route.ts):
 *   · contentHash 去重(命中即返回已有行, 不重复写) —— 知识/反思的 hash 公式与 portal 逐字相同,
 *     故对**历史 portal 数据**追加同样的 hash 仍能命中(见下方 sha256 注释);
 *   · memory 走**平台单点写入服务** `safeCreateMemory` -> PrismaMemoryStore.create
 *     (contentHash 自动计算 + 标题归一 + 域投影 + qualityScore 兜底 + 认知闸);
 *   · knowledge 走 `safeCreateKnowledge` -> PrismaKnowledgeStore.create
 *     (标题归一 + category 受控投影 + qualityScore 兜底 + 认知闸 + 关系抽取);
 *   · reflection 走 `safeCreateReflection` -> PrismaReflectionStore.create(平台既有出口),
 *     score 用平台天平 `calcQualityScore`(与 db-writer.ts:570 / global-organizer.ts:1403 同口径);
 *   · 落一条 FlywheelEvent(stage=`PORTAL_INGEST`), 观测口径不丢。
 *
 * 鉴权: `X-API-Key = <AgentServicePermission 的 sk-mind-* service key>`, 复用 mind 既有服务鉴权
 *   (src/server/lib/service-auth.ts, 判据 = flywheel/memory/feedback + agent/refresh-service-key)。
 *   body.agentId 是**被代表的终端 agent**(portal 已用其 Bearer token 反查 AgentRegistry 鉴权);
 *   本端点额外校验该 agentId 确实在 AgentRegistry 中, 防 portal 误传(trust boundary 见交付说明)。
 *
 * ⚠ 与 portal 原行为的**必要差异**(诚实登记, 均为"闸真的生效"的后果):
 *   1) 生产 COGNITIVE_GATE_MODE=enforce(packages/apps/mind/.env.local): memory 必须带
 *      title/sourceId/summary|scenario 才落库; 本端点从 content 派生 title(前 30 字)与
 *      summary(前 200 字, **抽取式摘要, 不编造语义**), sourceId 记为 `PORTAL:<agentId>`。
 *      knowledge 必须含 markdown 结构标记(标题/列表/表格任一), 否则认知闸**拒绝** -> 422。
 *   2) FlywheelEvent 原先**一条都没落成**: portal 的 INSERT 漏了 NOT NULL 列 `targetStage`
 *      (实测 dev.db: `targetStage TEXT NOT NULL` 且无默认值; `SELECT COUNT(*) ... stage='PORTAL_INGEST'` = 0)。
 *      本端点补上 targetStage(= type 大写), 事件**真的**会落库。
 *   3) qualityScore/score 不再写死 0.5, 改由平台天平 calcQualityScore 计算(portal 的 0.5 是占位常量,
 *      会让所有 portal 行在排序上并列)。
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireServiceAuth } from "@/server/lib/service-auth";
import { safeCreateMemory, safeCreateKnowledge, safeCreateReflection } from "@/server/pipeline/safe-create";
// 2026-10-23 R3: 资产归属（owner 由已鉴权的 agentId 推导）
import { memoryWriteFields } from "@/server/pipeline/asset-scope";
import { resolveWriteVisibility } from "@/server/pipeline/asset-policy";

/** body.visibility 只接受三值枚举；其余一律按 private（保守）。 */
function visibilityOf(body: any): "private" | "shared" | "global" {
  const v = String(body?.visibility || "").toLowerCase();
  return v === "shared" || v === "global" ? (v as "shared" | "global") : "private";
}
import { validateFlywheelProduct } from "@/server/pipeline/flywheel-prompt-constraints";
import { calcQualityScore } from "@lions/product-contract";

export const dynamic = "force-dynamic";

const TYPES = new Set(["memory", "knowledge", "reflection"]);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * 落一条 FlywheelEvent(stage=`PORTAL_INGEST`)。
 * 与 portal 原实现一致: **失败非致命**(原为 `.catch(() => {})`) —— 事件是观测, 不该阻断写入。
 * targetStage 是补上的 NOT NULL 列(原实现漏写 -> 事件从未落库, 见文件头注释)。
 */
async function logIngest(agentId: string, type: string, targetId: string) {
  try {
    await prisma.flywheelEvent.create({
      data: {
        stage: "PORTAL_INGEST",
        sourceType: `PORTAL:${agentId}`,
        sourceId: agentId,
        sourceTitle: `portal ingest ${type}`,
        targetStage: type.toUpperCase(),
        targetType: type.toUpperCase(),
        targetId,
      },
    });
    return true;
  } catch (e) {
    console.error(`[portal-ingest] FlywheelEvent 写入失败(非致命): ${(e as Error)?.message || e}`);
    return false;
  }
}

export async function POST(req: NextRequest) {
  // ① 服务身份鉴权(portal 用它自己的 service key 调用)
  const auth = await requireServiceAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // ② 入参校验(与 portal 原实现的校验逐条一致, 便于 portal 直接透传错误)
  const body = await req.json().catch(() => ({} as any));
  const type = String(body?.type || "");
  const content = typeof body?.content === "string" ? body.content : "";
  const title = body?.title != null ? String(body.title) : "";
  const theme = body?.theme != null ? String(body.theme) : "";
  const tags = body?.tags != null ? String(body.tags) : "";
  const agentId = String(body?.agentId || "").trim();

  if (!TYPES.has(type)) {
    return NextResponse.json(
      { ok: false, error: "type must be one of: memory, knowledge, reflection" },
      { status: 400 },
    );
  }
  if (!content || content.trim().length < 10) {
    return NextResponse.json({ ok: false, error: "content required (min 10 chars)" }, { status: 400 });
  }
  if (!agentId) {
    return NextResponse.json({ ok: false, error: "agentId required" }, { status: 400 });
  }

  // ③ 防误传: agentId 必须真的是平台注册过的 agent(portal 已鉴权, 这里是转发链的第二道)
  const agent = await prisma.agentRegistry.findUnique({
    where: { agent_id: agentId },
    select: { agent_id: true },
  });
  if (!agent) {
    return NextResponse.json({ ok: false, error: `unknown agentId: ${agentId}` }, { status: 400 });
  }

  const agentSource = `PORTAL:${agentId}`;

  try {
    // ================= memory =================
    if (type === "memory") {
      // 与 portal 一致: contentHash = sha256(content); PrismaMemoryStore 内部同式自动计算
      const contentHash = sha256(content);
      // 2026-10-23 R3: 去重按**同一归属**收敛（contentHash 语义本来就是"同 agent + 24h"）。
      //   全局 findFirst 会把 A 的私有记忆判给 B（deduped 返回他人 id = 泄露"存在性"）。
      // 2026-10-26 策略：可见性由平台策略/agent 注册选择决定（平台 public/private 强制）
      const policy = await resolveWriteVisibility({ agentId }, "memory", visibilityOf(body));
      const ownerFields = { ownerAgentId: policy.ownerAgentId, memoryScope: policy.visibility };
      // asset-scope-exempt: contentHash 去重探针（已按归属收敛，只返回 id，不返回内容）
      const dup = await prisma.memory.findFirst({ where: { contentHash, ownerAgentId: ownerFields.ownerAgentId }, select: { id: true } });
      if (dup) {
        return NextResponse.json({
          ok: true, deduped: true, type, id: dup.id, contentHash, agent: agentId,
          message: "同内容已存在 (contentHash 命中), 未重复写入",
        });
      }
      // 单点写入出口: 标题归一 + domain 投影 + qualityScore 兜底 + 认知闸都在 store 内
      const mem = await safeCreateMemory(prisma, {
        data: {
          content,
          // 认知闸(enforce)要求 title/sourceId/(summary|scenario) 齐备; 缺省时从 content 派生(抽取式, 不编造)
          title: title || content.slice(0, 30),
          summary: content.slice(0, 200),
          sourceId: agentSource,
          type: "GENERAL",
          theme: theme || null,
          tags: tags || null,
          agentSource,
          sourceType: "PORTAL_INGEST",
          importance: 0.6,
          // 2026-10-23 R3: 归属 = 被代表的终端 agent（portal 已鉴权并校验其存在）
          ownerAgentId: ownerFields.ownerAgentId,
          memoryScope: ownerFields.memoryScope,
        },
      });
      if (!mem) {
        return NextResponse.json(
          { ok: false, error: "memory_rejected_by_write_gate", message: "平台写入闸拒绝该 memory(内容短而空/逃避式, 或认知闸 enforce)" },
          { status: 422 },
        );
      }
      const eventWritten = await logIngest(agentId, "memory", mem.id);
      return NextResponse.json({
        ok: true, type, id: mem.id, contentHash, agent: agentId, eventWritten,
        message: "memory 已写入统一记忆",
      });
    }

    // ================= knowledge =================
    if (type === "knowledge") {
      // 与 portal 逐字同式: sha256(kTitle + "\n" + content) —— 保持与历史 portal 行的去重兼容
      const kTitle = String(title || content.slice(0, 60));
      const kHash = sha256(kTitle + "\n" + content);
      // asset-scope-exempt: contentHash 去重探针（只返回 id；Knowledge 归属列待 R5）
      const dup = await prisma.knowledge.findFirst({ where: { contentHash: kHash }, select: { id: true } });
      if (dup) {
        return NextResponse.json({
          ok: true, deduped: true, type, id: dup.id, contentHash: kHash, agent: agentId,
          message: "同内容已存在, 未重复写入",
        });
      }
      // 平台格式判据(单一来源)只做 observe: reflection/knowledge 的历史教训是硬拒会静默丢整批
      // (见 flywheel-prompt-constraints.ts:190-205); 真拦写的是 store 内的认知闸。
      const seen = validateFlywheelProduct({ title: kTitle, content }, { kind: "knowledge", maxTitle: 30 });
      if (!seen.ok) console.warn(`[portal-ingest/format-observe] knowledge: ${seen.reasons.join("; ")}`);

      const kn = await safeCreateKnowledge(prisma, {
        data: {
          title: kTitle,
          content,
          category: theme || "PORTAL", // store 内 projectCategory 受控投影
          agentSource,
          theme: theme || null,
          contentHash: kHash,
          // qualityScore 不写死: 交给 store 的 calcQualityScore 兜底(平台天平)
        },
      });
      if (!kn) {
        return NextResponse.json(
          {
            ok: false,
            error: "knowledge_rejected_by_cognitive_gate",
            message: "认知闸拒绝: knowledge 内容需含 markdown 结构标记(标题/列表/表格任一); 见 COGNITIVE_GATE_MODE=enforce",
            reasons: seen.reasons,
          },
          { status: 422 },
        );
      }
      const eventWritten = await logIngest(agentId, "knowledge", kn.id);
      return NextResponse.json({
        ok: true, type, id: kn.id, contentHash: kHash, agent: agentId, rows: 1, eventWritten,
        message: "knowledge 已写入",
      });
    }

    // ================= reflection =================
    const rTitle = String(title || content.slice(0, 60));
    // 与 portal 逐字同式: sha256(rTitle + content)(无分隔符)
    const rHash = sha256(rTitle + content);
    const dup = await prisma.reflection.findFirst({ where: { contentHash: rHash }, select: { id: true } });
    if (dup) {
      return NextResponse.json({
        ok: true, deduped: true, type, id: dup.id, contentHash: rHash, agent: agentId,
        message: "同内容已存在, 未重复写入",
      });
    }
    const seen = validateFlywheelProduct({ title: rTitle, content }, { kind: "reflection", maxTitle: 30 });
    if (!seen.ok) console.warn(`[portal-ingest/format-observe] reflection: ${seen.reasons.join("; ")}`);

    const rf = await safeCreateReflection(prisma, {
      data: {
        title: rTitle,
        description: content,
        category: "PORTAL",
        status: "OPEN",
        priority: "P2",
        // 平台天平(与 db-writer.ts:570 / global-organizer.ts:1403 同口径), 不再写死 0.5
        score: calcQualityScore({ type: "reflection", content, title: rTitle, theme: theme || null, priority: "P2", lesson: "" }),
        agentSource,
        sourceType: "PORTAL_INGEST",
        contentHash: rHash,
        theme: theme || null,
      },
    });
    // 写入结果必须判空(spec:gate-null-guards): store 出口在写入闸下可能 return null
    if (!rf) {
      return NextResponse.json(
        { ok: false, error: "reflection_rejected_by_write_gate", message: "平台写入闸未返回 reflection 记录(未落库)" },
        { status: 422 },
      );
    }
    const eventWritten = await logIngest(agentId, "reflection", rf.id);
    return NextResponse.json({
      ok: true, type, id: rf.id, contentHash: rHash, agent: agentId, eventWritten,
      message: "reflection 已写入",
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: (e?.message || "ingest failed").slice(0, 200) },
      { status: 500 },
    );
  }
}
