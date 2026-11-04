import { NextResponse } from "next/server";
import { asOf, num, one, openMind, safeClose } from "@/lib/server/lions-db";

// GET /api/reflection-detail?id=<id>
// 反思详情有两个 id 体系 (2026-09-10 明确并存):
//   1) 旧 Reflection 表   —— mind tRPC reflection.get (本路由透传, 仍在 result.data)
//   2) 主题反思 FlywheelReflection —— 飞轮引擎按主题聚合的反思 (本轮反思), 由本路由从 mind 库只读补出 (flywheel 字段)
// 两者 id 不通用, 页面会用各自的 id 挂讨论面板, 并标注"当前讨论挂在哪个反思上"。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const wantFlywheel = url.searchParams.get("kind") === "flywheel";
  if (!id) return NextResponse.json({ flywheel: null, asOf: asOf() });

  let upstream: any = null;
  const warnings: string[] = [];
  // 明确指定是主题反思时不必打 tRPC (省一次上游往返), 但仍保持容错
  if (!wantFlywheel) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(
        `http://localhost:3000/api/trpc/reflection.get?input=${encodeURIComponent(JSON.stringify(id))}`,
        { cache: "no-store", signal: ctrl.signal }
      );
      clearTimeout(timer);
      if (res.ok) upstream = await res.json();
      else warnings.push("mind reflection.get 返回 " + res.status);
    } catch {
      warnings.push("mind 服务 (3000) 不可达: 旧反思记录未取到");
    }
  }

  // 主题反思 FlywheelReflection (直读库, 只读+容错)
  const mind = openMind();
  const row = await one(mind, "SELECT * FROM FlywheelReflection WHERE id = ? LIMIT 1", id);
  safeClose(mind);

  const parse = (v: any) => {
    if (v == null || v === "") return null;
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return v; }
  };

  const flywheel = row
    ? {
        id: row.id,
        theme: row.theme,
        reflectionGranularity: row.reflectionGranularity || "theme",
        status: row.status,
        coverageScore: row.coverageScore == null ? null : num(row.coverageScore),
        coverageDelta: row.coverageDelta == null ? null : num(row.coverageDelta),
        attempts: num(row.attempts),
        summary: row.summary ?? null,
        missedTopics: parse(row.missedTopics),
        improvements: parse(row.improvements),
        conflicts: parse(row.conflicts),
        productCounts: parse(row.productCounts),
        sourceStats: parse(row.sourceStats),
        triggerReason: parse(row.triggerReason),
        dayStats: parse(row.dayStats),
        lastErrors: row.lastErrors ?? null,
        structuredFindingsCount: (() => {
          const f = parse(row.structuredFindings);
          return Array.isArray(f) ? f.length : f ? 1 : 0;
        })(),
        structuredFindings: (() => {
          const f = parse(row.structuredFindings);
          return Array.isArray(f) ? f.slice(0, 20) : f;
        })(),
        createdAt: row.createdAt == null ? null : num(row.createdAt),
        updatedAt: row.updatedAt == null ? null : num(row.updatedAt),
      }
    : null;

  const legacy = upstream?.result?.data ?? null;

  return NextResponse.json({
    ...(upstream || {}),
    asOf: asOf(),
    id,
    warnings,
    // 两个 id 体系的命中情况 (页面据此决定展示与讨论面板挂载)
    found: { legacy: !!legacy, flywheel: !!flywheel },
    flywheel,
  });
}
