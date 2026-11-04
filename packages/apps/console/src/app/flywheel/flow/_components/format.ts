// flywheel/flow 页 · 展示格式化 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
export const fmtAge = (sec: number) =>
  sec < 90 ? sec + "s" : sec < 5400 ? Math.round(sec / 60) + "min" : Math.round(sec / 3600) + "h";

export const fmtN = (n: number | undefined) => (n === undefined || n === null ? "—" : Number(n).toLocaleString());
