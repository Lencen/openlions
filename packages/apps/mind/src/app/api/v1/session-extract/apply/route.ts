/**
 * POST /api/v1/session-extract/apply — session-extract worker 的**唯一落库入口** (round 77 写入链收口)
 *
 * 背景: `packages/apps/mind/scripts/session-extract.ts`(systemd timer 每 20 分钟一轮)原先用
 *   better-sqlite3 **直连生产库**写 14 处/9 张表 —— 它是 mind 核心库的第二个写进程, 且把同一份写入
 *   契约(标题归一/受控投影/qualityScore/contentHash 去重/认知闸)在脚本里又实现了一遍。本端点承接
 *   脚本的"算完提交": 脚本只保留 LLM 调用/解析/归一/去重判定/批次组装, 写入全部在 mind 内执行。
 *
 * 鉴权: 与 `POST /api/v1/ingest` **完全一致** —— 复用 `src/server/lib/service-auth.ts` 的
 *   `requireServiceAuth`(X-API-Key 明文 -> sha256 -> AgentServicePermission 命中 + ACTIVE + 未过期)。
 *   注意(诚实登记): 与既有 v1 端点同口径, 该判据**不校验 service_name**; body.agentId 是会话所属
 *   agent 的**元数据**(来自 session 库), 不是鉴权主体, 因此**不**做 AgentRegistry 存在性校验
 *   (session 库里的 agentId 可能是 taskexec:/platform: 这类非注册通道)。
 *
 * Body(覆盖 9 张表; 具体字段见 src/server/pipeline/session-extract-apply.ts):
 *   {
 *     sessionUid: "…",
 *     agentId: "…" | null,
 *     products: { memory: [...], knowledge: [...], practice: [...], skill: [...] },
 *     links:    { practiceUsedMemory: [...], practiceKnowledge: [...], practiceSkill: [...] },
 *     tasks:    [ … ],          // Task(PENDING, GOAL_GAP 遗留改进单)
 *     events:   [ … ],          // FlywheelEvent(会话去重事件 / 轮次事件)
 *     retractions: [ { knowledgeId, reason } ]   // Knowledge 撤回(stale+REJECTED+AuditLog+FlywheelEvent)
 *   }
 *
 * ⚠ 未收口项(刻意不接收, 传了即 400, 见 `UNSUPPORTED_SECTIONS`): `todos` / `sessionStatus` / `state`。
 *   · todos: 仅存在于 `--selftest` 的 fixture(事务内跑完即回滚), 生产路径不写; mind schema 无 Todo 模型。
 *   · sessionStatus: 目标是 **session 服务的库**, 不是 mind 核心库; 官方 PATCH API 已是服务调用, 且
 *     其状态机不接受 SKIPPED(预筛否决落终态只能直连 SQL)。
 *   · state: `SessionExtractionState` 是脚本自建运行期表, **Prisma schema 无此模型**(用 raw DDL 建),
 *     且 lastMessageAt 是 epoch ms(超出 Prisma Int 32 位)。硬收口需改 schema+migration+重生成 client,
 *     超出本轮范围; 用裸 SQL 在 mind 里再实现一遍 UPSERT 恰是本次要消除的"第二套实现"。
 *   见交付说明「未收口项与理由」。
 *
 * 返回(HTTP 200, 便于脚本记日志并逐类判成败):
 *   { ok, sessionUid, applied:{…}, deduped:{…}, downgraded:{skillNameTooLong}, rejected:[…], errors:[…] }
 *   · rejected = 平台写入闸/认知闸**确定性拒收**(重试无意义)
 *   · errors   = 基础设施异常(可重试; 幂等键保证重放不重复)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireServiceAuth } from "@/server/lib/service-auth";
import {
  applySessionExtractBatch,
  validateSessionExtractBatch,
  type SessionExtractBatch,
} from "@/server/pipeline/session-extract-apply";

export const dynamic = "force-dynamic";

/** 刻意不支持的三段(见文件头注): 出现非空值即 400, 绝不静默吞掉 */
const UNSUPPORTED_SECTIONS: Record<string, string> = {
  todos: "Todo 仅存在于 --selftest fixture(事务回滚), 生产路径不写; mind schema 无 Todo 模型",
  sessionStatus: "Session 属 session 服务的库(非 mind 核心库), 且其状态机不接受 SKIPPED; 见已保留的直连兜底",
  state: "SessionExtractionState 无 Prisma 模型(raw DDL 建表, lastMessageAt 超 Int32), 见交付说明未收口项",
};

function nonEmpty(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return String(v).length > 0;
}

export async function POST(req: NextRequest) {
  // ① 服务身份鉴权(与 /api/v1/ingest 同一实现)
  const auth = await requireServiceAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // ② 入参
  const body = (await req.json().catch(() => ({}))) as SessionExtractBatch & Record<string, unknown>;
  const batch: SessionExtractBatch = {
    sessionUid: String(body?.sessionUid || "").trim(),
    agentId: body?.agentId == null ? null : String(body.agentId),
    products: body?.products || {},
    links: body?.links || {},
    tasks: Array.isArray(body?.tasks) ? body.tasks : [],
    events: Array.isArray(body?.events) ? body.events : [],
    retractions: Array.isArray(body?.retractions) ? body.retractions : [],
  };
  if (!batch.sessionUid) {
    return NextResponse.json({ ok: false, error: "sessionUid required" }, { status: 400 });
  }
  const unsupported = Object.keys(UNSUPPORTED_SECTIONS).filter((k) => nonEmpty((body as any)?.[k]));
  if (unsupported.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "unsupported_sections",
        sections: unsupported.map((k) => ({ section: k, reason: UNSUPPORTED_SECTIONS[k] })),
      },
      { status: 400 },
    );
  }
  const issues = validateSessionExtractBatch(batch);
  if (issues.length > 0) {
    return NextResponse.json({ ok: false, error: "batch_invalid", issues }, { status: 400 });
  }

  // ③ 落库(所有写入服务在 mind 内: safe-create -> modules store / Prisma 模型层)
  try {
    const result = await applySessionExtractBatch(prisma, batch);
    return NextResponse.json({ ok: result.errors.length === 0, agentId: batch.agentId ?? null, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || "session-extract apply failed").slice(0, 300) },
      { status: 500 },
    );
  }
}
