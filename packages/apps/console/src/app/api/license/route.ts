import { NextResponse } from "next/server";

// 2026-10-27：授权状态的只读取数口（console BFF）。S2 门禁用，不阻塞 S1。
//
// 契约（LICENSE-GATE-MATRIX §3）：
//   - **不自己算 license**：状态/宽限/机器绑定全由 mind 的 /api/v1/platform/license 判定，本路由只取数与投影；
//   - **白名单投影**：上游含 machineFingerprint / source(本机路径) / licenseId / customer，
//     这些**一律不返回浏览器**（指纹可用于追踪设备、路径泄露部署结构）；
//   - 上游不可用 → state="unknown" + reason（页面显示"授权状态未知"，**不静默放行**）；
//   - 只读：无写接口。
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.LICENSE_URL || "http://localhost:3000/api/v1/platform/license";
const TIMEOUT_MS = Number(process.env.LICENSE_TIMEOUT_MS || 2500);

interface Feature {
  key?: string;
  ok?: boolean;
  reason?: string;
}

export async function GET() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(UPSTREAM, { cache: "no-store", signal: ac.signal });
    if (!r.ok) {
      return NextResponse.json({ ok: false, state: "unknown", reason: "授权服务返回 " + r.status, features: [] });
    }
    const raw = (await r.json()) as {
      state?: string;
      reason?: string | null;
      daysLeft?: number | null;
      required?: boolean;
      expiresAt?: string | null;
      edition?: string | null;
      features?: Feature[];
    };
    const features = (raw.features || [])
      .filter((f) => typeof f.key === "string")
      .map((f) => ({ key: String(f.key), ok: f.ok === true, reason: typeof f.reason === "string" ? f.reason : null }));
    return NextResponse.json({
      ok: true,
      state: typeof raw.state === "string" ? raw.state : "unknown",
      reason: typeof raw.reason === "string" ? raw.reason : null,
      daysLeft: typeof raw.daysLeft === "number" ? raw.daysLeft : null,
      required: raw.required === true,
      expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
      edition: typeof raw.edition === "string" ? raw.edition : null,
      features,
    });
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return NextResponse.json({
      ok: false,
      state: "unknown",
      reason: aborted ? "授权服务读取超时" : "授权服务暂时不可用",
      features: [],
    });
  } finally {
    clearTimeout(timer);
  }
}
