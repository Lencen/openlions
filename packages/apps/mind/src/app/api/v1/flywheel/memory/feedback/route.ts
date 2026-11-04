/**
 * POST /api/v1/flywheel/memory/feedback —— agent 用过注入数据后的**回写**入口(目标⑦)
 *
 * 为什么需要它: `GET /api/v1/flywheel/memory/context` 早已把对象 id 交给 agent(hits[].id),
 *   但平台**没有任何地方**能让 agent 把"用过之后怎么样"写回来 -> "存过却没人用/用了没人说"。
 *
 * 设计(见 .changeset/round73-m/-x/-y/-ae):
 *   · **append-only 事件**, 不直接改 qualityScore —— 分由治理管线重算, 防单方篡改;
 *   · 复用既有 FlywheelEvent + 新 stage `AGENT_FEEDBACK`(不新建表/不迁移);
 *   · 鉴权沿用仓库既有写法(见 agent/refresh-service-key): X-API-Key -> sha256 -> AgentServicePermission。
 *
 * 本步(第 1 步)只做「鉴权 + 写事件」, 落库是**唯一副作用**; 计数直写与治理消费是后续两步。
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 2026-10-15 钥匙治理: 服务身份鉴权的**单一实现**(原文件内联的第二份判据已删)
import { requireServiceAuth } from "@/server/lib/service-auth";

export const dynamic = "force-dynamic";

const KINDS = new Set(["memory", "knowledge", "skill", "practice"]);
const VERDICTS = new Set(["USED_OK", "USED_BAD", "CORRECTED"]);

/** 解析 sourceTitle 里的结构化载荷(agent 回写时由 POST 写入) */
function parsePayload(sourceTitle: unknown) {
  const m = /verdict=([^;]*);score=([^;]*);agent=([^;]*);note=(.*)$/.exec(String(sourceTitle || ""));
  if (!m) return { verdict: "", score: null as number | null, agent: "", note: "" };
  return { verdict: m[1], score: m[2] === "" ? null : Number(m[2]), agent: m[3], note: m[4] };
}

export async function POST(req: NextRequest) {
  try {
    // ① 鉴权: 必须自带(整个 /api/v1/flywheel/* 面当前**无鉴权** —— 见 round73-w)
    // 2026-10-15 钥匙治理: 判据改走**单一实现** src/server/lib/service-auth.ts(原先是本文件内联的第二份
    //   同款判据 —— 两份判据迟早分叉); 顺带获得"到期前自动续期"(item 2, 不换密钥值, 客户端无感)。
    const auth = await requireServiceAuth(req);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error || "无效/过期/已撤销的 key" }, { status: auth.status });
    }
    const authAgentId = auth.agentId as string;

    // ② 入参校验(白名单, 不做任何"猜测式"放行)
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind || "");
    const id = String(body.id || "");
    const verdict = String(body.verdict || "");
    if (!KINDS.has(kind) || !id || !VERDICTS.has(verdict)) {
      return NextResponse.json({ ok: false, error: "kind/id/verdict 不合法" }, { status: 400 });
    }

    // ③ 写 append-only 事件(唯一副作用); id/createdAt 交给 @default
    await prisma.flywheelEvent.create({
      data: {
        stage: "AGENT_FEEDBACK",
        sourceType: kind,
        sourceId: id,
        sourceTitle:
          "verdict=" + verdict + ";score=" + (body.score ?? "") + ";agent=" + authAgentId +
          ";note=" + String(body.note || "").slice(0, 200),
        targetStage: verdict,
        targetType: kind,
        targetId: id,
      },
    });

    return NextResponse.json({ ok: true, stage: "AGENT_FEEDBACK", kind, id, verdict, agent: authAgentId });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message || e).slice(0, 200) },
      { status: 500 },
    );
  }
}

/**
 * GET /api/v1/flywheel/memory/feedback —— ⑦ 回写的**只读**视图(让反馈可见, round 73-AL)
 *
 * 为什么需要它: 端点与消费者已落地, 但反馈**在控制台上完全看不到** ——
 *   控制台不直连库(走 safeFetchJson 代理 mind 的 API), 所以必须先在这里把反馈按对象暴露出来。
 *
 * 只读。参数: kind(memory|knowledge|skill|practice)、id(对象 id)、limit(默认 50, 上限 200)。
 * 刻意**不返回**被评对象正文, 只返回反馈元数据。
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const kind = sp.get("kind") || undefined;
    const id = sp.get("id") || undefined;
    const limit = Math.min(Math.max(parseInt(sp.get("limit") || "50", 10) || 50, 1), 200);

    const scope: Record<string, unknown> = {};
    if (kind) scope.targetType = kind;
    if (id) scope.targetId = id;

    const rows = await prisma.flywheelEvent.findMany({
      where: { stage: "AGENT_FEEDBACK", ...scope },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const applied = await prisma.flywheelEvent.findMany({
      where: { stage: "AGENT_FEEDBACK_APPLIED", ...scope },
      select: { sourceId: true },
    });
    const consumed = new Set(applied.map((a) => a.sourceId));

    const items = rows.map((r) => {
      const p = parsePayload(r.sourceTitle);
      return {
        id: r.id,
        kind: r.targetType,
        targetId: r.targetId,
        verdict: p.verdict || r.targetStage,
        agent: p.agent,
        score: p.score,
        note: p.note,
        at: r.createdAt,
        consumed: consumed.has(r.id),
      };
    });

    const count = (v: string) => items.filter((i) => i.verdict === v).length;
    return NextResponse.json({
      ok: true,
      summary: {
        total: items.length,
        usedOk: count("USED_OK"),
        usedBad: count("USED_BAD"),
        corrected: count("CORRECTED"),
        distinctAgents: new Set(items.map((i) => i.agent).filter(Boolean)).size,
        pendingConsume: items.filter((i) => !i.consumed).length,
      },
      items,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String((e as Error)?.message || e).slice(0, 200) },
      { status: 500 },
    );
  }
}
