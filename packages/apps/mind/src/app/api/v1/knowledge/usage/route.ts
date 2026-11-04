/**
 * POST /api/v1/knowledge/usage — 端口读计数回写 (2026-10-15 portal 写转发改造)
 *
 * 背景: portal 的 `GET /api/portal/knowledge`(五表一站式检索)返回前会对命中行批量 +1:
 *   Memory.accessCount(+lastAccessed) / Knowledge.usageCount(+lastUsedAt) / Practice.reinforceCount
 *   / Reflection.reinforceCount / Skill.totalUsageCount。原先是 portal 直连 `updateMany` 写 mind 生产库
 *   (第 3 个写点), 现改由 mind 承接。
 *
 * 语义与 portal 原实现**逐条等价**(同 5 张表、同 5 组字段、同 increment 1, 时间字段同为"现在"):
 *   · 文档口径: docs/platform-logic 的 north-star-b-plan Phase 1(端口读计入);
 *   · **失败非致命**: 与 portal 侧 `.catch(() => {})` 一致 —— 单表失败不影响其它表, 端点仍返 200,
 *     失败明细放 `failed` 供调用方观测(不改变"计数是 fire-and-forget 的非关键路径"这一定位)。
 *
 * 鉴权: X-API-Key = AgentServicePermission 的 service key(见 @/server/lib/service-auth)。
 * body: { slices: { Memory: string[], Knowledge: string[], Practice: string[], Reflection: string[], Skill: string[] } }
 * 返回: 200 { ok, applied: {表: 命中行数}, failed: {表: 错误} }
 *
 * 注: 本端点刻意**不**新造"计数写入服务" —— 平台五表计数本来就是 Prisma 模型层 updateMany
 *   (portal 原实现同款), 除 Knowledge 外各 module store 没有 increment 出口
 *   (唯一存在的 PrismaKnowledgeStore.incrementUsage 只按单 id、且不写 lastUsedAt, 与本处批量子集语义不等价)。
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireServiceAuth } from "@/server/lib/service-auth";
import { recordContextQueried } from "@/server/lib/context-queried-event";

export const dynamic = "force-dynamic";

/** 单表单次最多处理的行数(portal 检索 limit 上限 100, 500 留足余量并挡住滥用) */
const MAX_IDS_PER_TABLE = 500;

type TableName = "Memory" | "Knowledge" | "Practice" | "Reflection" | "Skill";

/** 去重 + 只留非空字符串 + 截断 */
function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const id = String(v ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS_PER_TABLE) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const auth = await requireServiceAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await req.json().catch(() => ({} as any));
  const raw = body?.slices;
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ ok: false, error: "slices required" }, { status: 400 });
  }

  const now = new Date();
  const applied: Record<string, number> = {};
  const failed: Record<string, string> = {};

  // 每张表独立 try/catch: 单表失败不影响其它表(调用方"失败非致命"语义)
  const jobs: Array<[TableName, () => Promise<{ count: number }>]> = [
    ["Memory", () => prisma.memory.updateMany({
      where: { id: { in: normalizeIds(raw.Memory) } },
      data: { accessCount: { increment: 1 }, lastAccessed: now },
    })],
    ["Knowledge", () => prisma.knowledge.updateMany({
      where: { id: { in: normalizeIds(raw.Knowledge) } },
      data: { usageCount: { increment: 1 }, lastUsedAt: now },
    })],
    ["Practice", () => prisma.practice.updateMany({
      where: { id: { in: normalizeIds(raw.Practice) } },
      data: { reinforceCount: { increment: 1 } },
    })],
    ["Reflection", () => prisma.reflection.updateMany({
      where: { id: { in: normalizeIds(raw.Reflection) } },
      data: { reinforceCount: { increment: 1 } },
    })],
    ["Skill", () => prisma.skill.updateMany({
      where: { id: { in: normalizeIds(raw.Skill) } },
      data: { totalUsageCount: { increment: 1 } },
    })],
  ];

  for (const [table, run] of jobs) {
    try {
      const r = await run();
      applied[table] = r.count;
    } catch (e: any) {
      failed[table] = (e?.message || String(e)).slice(0, 200);
      console.error(`[knowledge-usage] ${table} 计数失败(非致命): ${failed[table]}`);
    }
  }

  // 2026-10-20 需求单: 跨表检索计数回写也留 CONTEXT_QUERIED（身份来自 service key；去噪同 memory/search）。
  const totalApplied = Object.values(applied).reduce((a, b) => a + b, 0);
  const primaryTable = Object.entries(applied).sort((a, b) => b[1] - a[1])[0]?.[0];
  recordContextQueried({
    agentId: auth.agentId,
    query: "usage:" + Object.keys(applied).join(","),
    targetType: primaryTable === "Memory" ? "MEMORY" : "KNOWLEDGE",
    hits: totalApplied,
  });

  return NextResponse.json({ ok: true, applied, failed });
}
