import { NextResponse } from "next/server";
import { licenseStatus, machineFingerprint, hasFeature } from "@/lib/license";

export const dynamic = "force-dynamic";

// GET /api/v1/platform/license — 授权状态(控制台/交付验收可见)
export async function GET() {
  try {
    const st = licenseStatus(true);
    const catalog = ["flywheel.reflect", "flywheel.improve", "goal.autopilot", "platform.review", "macs.collab", "console.analytics", "security.audit"];
    return NextResponse.json({
      ok: true,
      state: st.state,
      source: st.source,
      reason: st.reason ?? null,
      daysLeft: st.daysLeft ?? null,
      required: st.required,
      customer: st.payload?.customer ?? null,
      edition: st.payload?.platform?.edition ?? null,
      licenseId: st.payload?.licenseId ?? null,
      expiresAt: st.payload?.expiresAt ?? null,
      maxAgents: st.payload?.platform?.maxAgents ?? null,
      machineFingerprint: machineFingerprint(),
      features: catalog.map((k) => ({ key: k, ...hasFeature(k) })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
