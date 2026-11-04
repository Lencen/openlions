"use client";
/**
 * asyncState —— 四态判定与文案（纯函数，便于用 node 直接断言）
 *
 * 由来（2026-11-02 UI/UX 审计 P0-②）：comm 页只判 `d.error`，
 *   上游返回 401 空体或 {ok:false,detail} 时会被当成"没有数据"渲染成空列表。
 *   这里把"加载中/失败/空/有数据"四态显式化，并给每态固定文案。
 */
export type AsyncPhase = "loading" | "error" | "empty" | "ready";

export interface ApiOutcome<T = unknown> {
  phase: AsyncPhase;
  data?: T;
  error?: { status?: number; code?: string; message?: string };
}

/** 把一次 fetch 结果归类成四态之一（fail-closed：非 2xx 或 body.ok===false 一律 error） */
export function classify(status: number, body: any, isEmpty: (d: any) => boolean): ApiOutcome {
  if (status === 0) return { phase: "error", error: { status: 0, message: "网络不可达" } };
  if (status < 200 || status >= 300 || (body && body.ok === false)) {
    return {
      phase: "error",
      error: { status, code: body?.code, message: body?.error || body?.message || "请求失败（状态码 " + status + "）" },
    };
  }
  return isEmpty(body) ? { phase: "empty", data: body } : { phase: "ready", data: body };
}

/** 四态各自的标题/说明（判据：四段必须互不相同） */
export function textFor(phase: AsyncPhase, err?: { status?: number; message?: string }): { title: string; hint: string } {
  switch (phase) {
    case "loading":
      return { title: "正在加载…", hint: "数据正在取回，请稍候（这不是空数据）" };
    case "error": {
      const s = err?.status;
      if (s === 401) return { title: "未登录或密钥无效（401）", hint: "请重新登录或确认管理密钥；这不代表没有数据" };
      if (s === 403) return { title: "无权限（403）", hint: "当前身份无权查看，请联系管理员" };
      return { title: "取数失败（" + (s || "网络") + "）", hint: err?.message || "请稍后重试" };
    }
    case "empty":
      return { title: "还没有数据", hint: "接口正常但返回为空，先从别处产生一条或检查筛选条件" };
    default:
      return { title: "", hint: "" };
  }
}
