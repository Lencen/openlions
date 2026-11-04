import { NextResponse } from "next/server";

// 2026-10-27：BFF 侧的功能授权判据（S2 门禁）。
// 规则（LICENSE-GATE-MATRIX §3）：**不能只隐藏 UI 而 API 放行** —— 未授权时 BFF 也必须 402。
//
// 三条设计约束：
//   1. 不自己算 license：状态与 feature.ok 由 mind `/api/v1/platform/license` 判定；
//   2. 与本项目 BFF 一致的上游写法：**有界超时 + 失败不静默放行**（fail-closed）；
//   3. 只返回 402 + 可读原因，不泄露敏感字段（指纹/路径/licenseId 一律不出现）。
// 2026-10-27：**在函数内读 env，不要在模块顶层固化** ——
//   顶层读取会让这个助手不可测（测试无法在导入后指向 stub），也不支持运行时改配置。
function upstreamUrl(): string {
  return process.env.LICENSE_URL || "http://localhost:3000/api/v1/platform/license";
}
function timeoutMs(): number {
  return Number(process.env.LICENSE_TIMEOUT_MS || 2500);
}

export interface GateResult {
  ok: boolean;
  feature: string;
  reason: string;
  state: string;
}

export async function checkFeature(feature: string): Promise<GateResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const r = await fetch(upstreamUrl(), { cache: "no-store", signal: ac.signal });
    if (!r.ok) {
      // 上游坏了 ≠ 已授权：fail-closed（否则"license 服务挂掉"就成了免费解锁）
      return { ok: false, feature, state: "unknown", reason: "授权服务返回 " + r.status };
    }
    const j = (await r.json()) as { state?: string; features?: { key?: string; ok?: boolean; reason?: string }[] };
    const f = (j.features || []).find((x) => x.key === feature);
    // 上游没返回该 feature → 我们**无法确认**它的授权状态，不能沿用平台的 state（valid）冒充"已确认"，
    //   否则页面会显示"未授权"而实际可能是没列出来。这里统一报 unknown，让文案说"无法确认"。
    if (!f) return { ok: false, feature, state: "unknown", reason: "授权服务未返回该功能状态" };
    return {
      ok: f.ok === true,
      feature,
      state: j.state || "unknown",
      reason: typeof f.reason === "string" ? f.reason : f.ok === true ? "已授权" : "该功能未授权",
    };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return { ok: false, feature, state: "unknown", reason: aborted ? "授权服务读取超时" : "授权服务暂时不可用" };
  } finally {
    clearTimeout(timer);
  }
}

/** 返回 null 表示放行；返回 NextResponse 表示应当直接回 402 */
export async function requireFeature(feature: string): Promise<NextResponse | null> {
  const g = await checkFeature(feature);
  if (g.ok) return null;
  // 2026-10-27：区分两种拒绝——"查不到授权"与"没有授权"。
  //   前者是环境/上游问题（应重试或报障），后者是商业状态（应升级）。
  //   混成同一个码会让排障与客服都做错判断。
  const unknown = g.state === "unknown";
  return NextResponse.json(
    {
      ok: false,
      error: unknown ? "LICENSE_CHECK_UNAVAILABLE" : "LICENSE_REQUIRED",
      state: g.state,
      feature: g.feature,
      detail:
        unknown
          ? "无法确认授权状态，暂不提供该功能（这不是未购买，请稍后重试或联系管理员）：" + g.reason
          : "该功能需要 Pro 授权：" + g.reason,
    },
    { status: 402 }
  );
}
