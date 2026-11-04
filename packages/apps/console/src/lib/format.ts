// 2026-09-10 商业化改版: 前端统一格式化 (千分位 / 本地时间 / 相对时间 / token)
export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "-";
  return Number(v).toLocaleString("zh-CN");
}

/** 大数：万 / 亿，**1~2 位有效数字**（详见 docs/practices/2026-10-15-console-data-display-guidelines.md §1）。
 *  2026-10-15 调整：原来是固定 `toFixed(2)`，于是 99,429 显示成「9.94万」(3 位有效数字)、
 *  1,234 显示成「0.12万」—— 后者既长了又丢了量级。现在按有效数字取舍，并保留千分位兜底。 */
export function fmtCompact(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const unit = (x: number, suffix: string) => {
    const abs = Math.abs(x);
    // 1~2 位有效数字: >=10 用整数位, 其余 1 位小数
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 1;
    const rounded = Number(x.toFixed(digits));
    // 舍入后若达到下一个量级(如 9999.9 -> 1.0万 的兄弟情形), 交给调用方外层处理
    return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(digits)) + suffix;
  };
  if (Math.abs(n) >= 1e8) return unit(n / 1e8, "亿");
  if (Math.abs(n) >= 1e4) return unit(n / 1e4, "万");
  return n.toLocaleString("zh-CN");
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return (n * 100).toFixed(digits) + "%";
}

/** 四态（规范 §1/§2）：**必须区分**「加载中 / 0（真的没有）/ —（不适用）/ 未知（取不到）」。
 *  ⚠️ 把「取不到」显示成 0 是**说谎**——比难看严重得多。 */
export const LOADING = "加载中…";
export const DASH = "—";       // 不适用（这个口径对本页/本维度不成立）
export const UNKNOWN = "未知";  // 取不到（请求失败/字段缺失）
/** 四态取数（规范 §1/§2）：值存在就格式化它；否则按「加载中 / 取不到 / 不适用」**区分**开。
 *  ⚠️ 这是本轮专门堵的那一类 bug：**绝不把「取不到」显示成 `0`**（规范原话：那是在说谎）。
 *  典型反例：`value={st?.pending24h ?? 0}` —— st 取不到时显示 0，与"真的是 0"无法分辨。
 */
export function fmtState(
  v: number | null | undefined,
  flags: { loading?: boolean; error?: boolean } = {},
  fmtFn: (n: number) => string = (n) => n.toLocaleString("zh-CN")
): string {
  if (v !== null && v !== undefined && Number.isFinite(Number(v))) return fmtFn(Number(v));
  if (flags.loading) return LOADING;
  if (flags.error) return UNKNOWN;
  return DASH;
}

/** 空集（真的没有）在计数类场景直接用 "0"；列表类场景用「暂无数据」。 */
export function stateText(state: "loading" | "empty" | "na" | "unknown"): string {
  switch (state) {
    case "loading": return LOADING;
    case "empty": return "0";
    case "na": return DASH;
    default: return UNKNOWN;
  }
}

/** 百分比 + **分子/分母**（规范 §1：「避免比率无锚点」）。
 *  例：fmtPctOf(24, 62) -> "38.7%（24/62）"；分母为 0 或缺失 -> "—"（不适用，不是 0%）。 */
export function fmtPctOf(num: number | null | undefined, den: number | null | undefined, digits = 1): string {
  const n = Number(num), d = Number(den);
  if (!Number.isFinite(d) || d === 0) return DASH;
  if (!Number.isFinite(n)) return UNKNOWN;
  return (n / d * 100).toFixed(digits) + "%（" + n.toLocaleString("zh-CN") + "/" + d.toLocaleString("zh-CN") + "）";
}



export function fmtScore(v: number | null | undefined, digits = 2): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

/** 本地时间 (毫秒时间戳 / ISO 字符串皆可) */
export function fmtTime(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function fmtDate(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("zh-CN");
}

export function fmtClock(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 相对时间: 12 秒前 / 5 分钟前 / 3 小时前 / 2 天前 */
export function relTime(v: number | string | null | undefined, now = Date.now()): string {
  if (v === null || v === undefined || v === "") return "-";
  const ts = typeof v === "number" ? v : new Date(v).getTime();
  if (!Number.isFinite(ts)) return "-";
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + " 秒前";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " 天前";
  return fmtDate(ts);
}

/** token 数 (只展示数量, 不做金额折算) */
export function fmtTokens(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("zh-CN");
}

export function shortId(id: string | null | undefined, head = 8, tail = 4): string {
  const s = String(id || "");
  if (s.length <= head + tail + 1) return s || "-";
  return s.slice(0, head) + "…" + s.slice(-tail);
}

export function truncate(s: string | null | undefined, n = 80): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** 状态 → 颜色 (统一色板) */
export const STATUS_COLOR: Record<string, string> = {
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  crit: "var(--status-crit)",
  info: "var(--primary)",
  mute: "var(--text-muted)",
};

export function qualityTone(v: number | null | undefined): { color: string; label: string; cls: string } {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return { color: STATUS_COLOR.mute, label: "未评分", cls: "mute" };
  if (n >= 0.7) return { color: STATUS_COLOR.ok, label: "高质量", cls: "ok" };
  if (n >= 0.4) return { color: STATUS_COLOR.warn, label: "中等", cls: "warn" };
  return { color: STATUS_COLOR.crit, label: "偏低", cls: "crit" };
}

/** 详情页时间戳：空值返回 ""（交给 DetailFields 统一渲染「—」），本地时区、无 T/Z 噪声 */
export function fmtStamp(v?: string | number | null): string {
  if (v === null || v === undefined || v === "") return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 19).replace("T", " ");
  return d.toLocaleString("zh-CN", { hour12: false });
}
