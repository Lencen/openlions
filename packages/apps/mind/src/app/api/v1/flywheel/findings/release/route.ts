import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseStructuredFindings } from "@/server/pipeline/findings-parse";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/findings/release — 人工复核放行 (2026-09-10 建议2)
 * Body: { theme: string, findingId?: string }  findingId 省略 = 放行该主题全部 NEEDS_REVIEW
 * 效果: status NEEDS_REVIEW -> NEW, 清除复核标记; 下一轮生成任务时才会再纳入。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const theme: string = String(body?.theme || "").trim();
    const findingId: string | undefined = body?.findingId ? String(body.findingId) : undefined;
    if (!theme) return NextResponse.json({ error: "theme 必填" }, { status: 400 });

    const refl = await prisma.flywheelReflection.findUnique({ where: { theme }, select: { structuredFindings: true } });
    if (!refl?.structuredFindings) return NextResponse.json({ error: "该主题无结构化发现", theme }, { status: 404 });

    const findings: any[] = parseStructuredFindings(refl.structuredFindings);
    let released = 0;
    for (const f of findings) {
      if (f.status !== "NEEDS_REVIEW") continue;
      if (findingId && f.id !== findingId) continue;
      f.status = "NEW";
      f.releasedAt = new Date().toISOString();
      f.releasedBy = "admin";
      delete f.needsReviewAt;
      delete f.needsReviewReason;
      released++;
    }
    if (released === 0) return NextResponse.json({ ok: true, released: 0, message: "没有待复核项" }, { status: 200 });

    await prisma.flywheelReflection.update({ where: { theme }, data: { structuredFindings: JSON.stringify(findings) } });
    return NextResponse.json({ ok: true, theme, findingId: findingId ?? null, released });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
