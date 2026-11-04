import { NextRequest, NextResponse } from "next/server";
import { parseStructuredFindings } from "@/server/pipeline/findings-parse";
import { prisma } from "@/lib/prisma";
import { rangeFromRequest } from "@/lib/range";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const pageSize = Math.min(parseInt(params.get("pageSize") || "20"), 100);
  const status = params.get("status");
  const category = params.get("category");

  // 2026-10-13 round 76-CA: **opt-in** 时间窗(③) —— 只有显式传 ?range= 才按 reflection.createdAt 过滤。
  const rf = rangeFromRequest(req);
  const where: any = { structuredFindings: { not: null } };
  if (rf && rf.since > 0) where.createdAt = { gte: new Date(rf.since) };

  const reflections = await prisma.flywheelReflection.findMany({
    where,
    select: { id: true, structuredFindings: true, createdAt: true, theme: true },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize * 3, // fetch more since findings are nested
  });

  let allFindings: any[] = [];
  for (const r of reflections) {
    try {
      const parsed = parseStructuredFindings(
        typeof r.structuredFindings === "string" ? r.structuredFindings : JSON.stringify(r.structuredFindings ?? null)
      );
      if (Array.isArray(parsed)) {
        for (const f of parsed) {
          allFindings.push({ ...f, reflectionId: r.id, agent: r.theme, time: r.createdAt });
        }
      }
    } catch {}
  }

  if (status) allFindings = allFindings.filter(f => f.status === status);
  if (category) allFindings = allFindings.filter(f => f.category === category);

  // 注意(2026-10-13 round 76-CA): findings 是**嵌套在 reflection 里的 JSON**, 全库 4780 期 / 19MB,
  //   不可能为了一个 total 全量解包。所以这里的 total 只代表"**本次扫描到的**那批反思里展开出的发现数",
  //   不是全库真值 —— 故额外回传 reflectionsScanned 让调用方**如实**展示。
  const total = allFindings.length;
  const reflectionsScanned = reflections.length;
  const paged = allFindings.slice(0, pageSize);

  return NextResponse.json({
    success: true,
    data: paged,
    meta: { total, reflectionsScanned, page, pageSize, ...(rf ? { range: rf.key, rangeLabel: rf.label } : {}) },
  });
}
