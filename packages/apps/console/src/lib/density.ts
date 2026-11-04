// 2026-10-25 R8：界面密度（P2 收尾项）
// 由来：评审 §1「密度是用户设置，不是一个哲学」——常看的人要紧凑、偶尔看的人要宽松。
// 做法：html[data-density="compact"] + 一组 CSS 覆盖（行高/内边距），偏好存 localStorage，
//   首屏由 DensityInit 挂载后应用（服务端不知道用户偏好，故不作为 SSR 属性，避免 hydration 不一致）。
export type Density = "comfortable" | "compact";
const KEY = "lions-console-density";

export function readDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  try { return (localStorage.getItem(KEY) === "compact" ? "compact" : "comfortable"); } catch { return "comfortable"; }
}

export function applyDensity(d: Density) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.density = d;
  try { localStorage.setItem(KEY, d); } catch { /* 隐私模式下忽略 */ }
}
