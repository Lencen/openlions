import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

// 2026-10-13 round 76-BU: 把 selfimproving /health 页的**写操作** cleanupStuck 搬进 console。
//   上游(selfimproving/src/server/routers/dashboard.ts): 把 startedAt 早于阈值的 IN_PROGRESS 执行标为
//   FAILED(reason=STUCK_MANUAL_CLEANUP), 把关联 Task 重置 PENDING 让调度器重跑, 并写 FlywheelEvent 留痕。
//   支持 dryRun=true **预演**(只统计不写), console 界面据此提供"先预演再执行"。
const SI = "http://localhost:3001/api/trpc/dashboard.cleanupStuck";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const raw = Number(body?.thresholdMin);
  const thresholdMin = Number.isFinite(raw) ? Math.min(1440, Math.max(5, Math.trunc(raw))) : 30;
  const dryRun = body?.dryRun === true;
  const guard = requirePlatformWrite(req, "ops.write", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body || { ok: false, error: "写操作未授权" }, { status: guard.status || 401 });
  const r = await safeFetchJson(SI, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 2026-10-13 round 76-BU: **裸 body**, 不要包 {json:...} ——
    //   实测这个端点(未加 ?batch=1)期望的就是原始输入; 包一层会被 zod strip 掉,
    //   导致 thresholdMin 恒为 30、dryRun 恒为 false(selfimproving 原页就是这么写的, 所以它**一直是坏的**)。
    body: JSON.stringify({ thresholdMin, dryRun }),
  });
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });

  // 0.4.40-03 批3：平台审计。ops 类操作无法回滚，审计失败如实返回 500（不假装没发生）。
  //   dryRun 不算写操作 -> 不写审计（避免把预演记成真实清理）。
  if (!dryRun) {
    try {
      await writeAudit({
        entityType: "PlatformConfig",
        entityId: "stuck-executions",
        action: "platform.ops.cleanup_stuck",
        before: { thresholdMin },
        after: { thresholdMin, cleaned: true },
        actor: { id: guard.actorId || "console-admin", type: "human" },
        changeType: "update",
        confirmed: true,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: "操作已执行，但审计写入失败（fail-closed 上报）", detail: String((e as Error)?.message || e).slice(0, 200) }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, data: (r.data as any)?.result?.data ?? null });
}
