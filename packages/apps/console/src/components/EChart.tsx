"use client";
// 统一 echarts 封装: 关闭 SSR + 统一网格/字体/提示样式, 页面只传 option
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useThemeColors } from "./useThemeColors";
import styles from "./EChart.module.css";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export interface EChartProps {
  option: any;
  /** 画布高度（px 数值；取整到 10px 档位后由 .h* 类承担）。
   *  收窄为 number：字符串高度（如 "100%"）无法表达成档位类，全仓库也无字符串调用点。 */
  height?: number;
  /** 附加在**外层定高盒子**上（画布本身不接样式，见下方说明） */
  className?: string;
}

/** 高度档位：echarts-for-react 在画布 div 上硬写内联 height:300，内联样式只能被 !important 覆盖，
 *  所以高度一律落到外层盒子的 .h* 档位类（10px 一档，100–1500；越界夹到端点）。 */
function heightClass(height: number): string {
  const n = isFinite(height) ? height : 240;
  const v = Math.min(1500, Math.max(100, Math.round(n / 10) * 10));
  return styles["h" + v] || styles.h240;
}

/** 平台常见色值 -> 令牌键: canvas 不解析 var(), 由 EChart 在渲染时把这些 hex 解析成当前主题的真实色。 */
const HEX_TO_KEY: Record<string, string> = {
  "#94a3b8": "textMuted", "#475569": "textDim", "#1e293b": "text",
  "#2563eb": "primary", "#d97706": "statusWarn", "#16a34a": "statusOk",
  "#dc2626": "statusCrit", "#0d9488": "tableMemory", "#7c3aed": "tableKnowledge",
  "#db2777": "tableReflection", "#5eead4": "tableMemory", "#a78bfa": "tableKnowledge",
  "#f472b6": "tableReflection", "#fbbf24": "tablePractice", "#60a5fa": "tableSkill",
  // 2026-10-13 round 76-CH: 这 4 个是**画布色但此前未入表** -> 在 canvas 里是**固定色、不跟随主题**
  //   (与周围跟随主题的图元不一致)。按"最接近的现有令牌"补齐 —— 不新造取值:
  "#cbd5e1": "bgSurface2",     // 成本图里的**占位条(track)** —— 要的是"淡", 不是一种文字色
  "#2b6cb0": "info",           // 飞轮流程 ①/② 阶段色(蓝)
  "#805ad5": "tableKnowledge", // 飞轮流程 ③/④ 阶段色(紫)
  "#dd6b20": "tablePractice",  // (飞轮流程阶段色已改为直接返回 var(), 见 flywheel-flow/route.ts)
  "#64748b": "textDim",        // 成本归属图第 6 个模型色(灰)
  "#fff": "bgSurface",         // 画布里的"白"(如甜甜圈分段描边) -> 应随卡片底色
  "#ffffff": "bgSurface",
};
/** 把主题色(通常是 #rrggbb)与一个 alpha 合成为 rgba —— canvas 需要**具体颜色**, 不能用 color-mix/var()。 */
export function withAlpha(base: string, alpha: string): string {
  const m = String(base).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return base; // 已经是 rgba()/color() 等 -> 原样返回(至少不更坏)
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function resolveCanvasColors(v: any, C: Record<string, string>): any {
  if (typeof v === "string") {
    const k = HEX_TO_KEY[v.toLowerCase()];
    if (k) return C[k];
    // 2026-10-13 round 76-DC: **rgba(...) 也要跟随主题**。原来这里只认 #rrggbb, 于是
    //   rgba(37,99,235,.35)(旧品牌蓝)、rgba(217,119,6,.14)(旧琥珀) 之类**照旧**渲染色, 不随主题。
    //   这里把 rgba 的 rgb 部分按**同一张表**解析, 并**保留原 alpha**。
    const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m) {
      const hex = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      const k2 = HEX_TO_KEY[hex];
      if (k2) return withAlpha(C[k2], m[4] ?? "1");
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveCanvasColors(x, C));
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = resolveCanvasColors(v[k], C); return o; }
  return v;
}

/** 把主题色注入 echarts option: canvas 不解析 CSS var(), 必须给真实色值 (axisLabel / tooltip / 轴线)。 */
function withTheme(option: any, C: Record<string, string>) {
  const out: any = { ...option };
  out.textStyle = { ...(option?.textStyle || {}), color: C.textDim };
  out.tooltip = {
    ...(option?.tooltip || {}),
    backgroundColor: C.bgSurface,
    borderColor: C.border,
    textStyle: { ...((option?.tooltip || {}).textStyle || {}), color: C.text },
  };
  const fixAxis = (ax: any) => {
    if (!ax) return ax;
    if (Array.isArray(ax)) return ax.map(fixAxis);
    return {
      ...ax,
      axisLabel: { ...(ax.axisLabel || {}), color: C.text3 },
      nameTextStyle: { ...(ax.nameTextStyle || {}), color: C.text3 },
      axisLine: { ...(ax.axisLine || {}), lineStyle: { ...((ax.axisLine || {}).lineStyle || {}), color: C.border } },
      splitLine: { ...(ax.splitLine || {}), lineStyle: { ...((ax.splitLine || {}).lineStyle || {}), color: C.border } },
    };
  };
  out.xAxis = fixAxis(option?.xAxis);
  out.yAxis = fixAxis(option?.yAxis);
  if (out.legend) out.legend = { ...out.legend, textStyle: { ...(out.legend.textStyle || {}), color: C.textDim } };
  return resolveCanvasColors(out, C);
}

export default function EChart({ option, height = 240, className }: EChartProps) {
  const C = useThemeColors();
  const themed = useMemo(() => withTheme(option, C), [option, C]);
  // 外层盒子定高（.h* 档位）+ 内层画布铺满 —— 组件内不再拼内联 style，说明见 EChart.module.css
  return (
    <div className={[styles.box, heightClass(height), className].filter(Boolean).join(" ")}>
      <ReactECharts
        option={themed}
        className={styles.canvas}
        opts={{ renderer: "canvas" }}
        notMerge
        lazyUpdate
      />
    </div>
  );
}

/** 通用图表底座样式 (与 console 色板一致) */
export const chartBase = {
  textStyle: { fontFamily: "-apple-system, 'PingFang SC', sans-serif", color: "#475569", fontSize: "var(--fs-sm)" },
  grid: { left: 44, right: 16, top: 24, bottom: 24, containLabel: true },
  tooltip: {
    trigger: "axis" as const,
    backgroundColor: "rgba(255,255,255,0.98)",
    borderColor: "rgba(0,0,0,0.08)",
    borderWidth: 1,
    textStyle: { color: "#1e293b", fontSize: "var(--fs-base)" },
    extraCssText: "box-shadow:0 4px 12px rgba(0,0,0,0.1);border-radius:8px;",
  },
  xAxis: {
    type: "category" as const,
    axisLine: { lineStyle: { color: "rgba(0,0,0,0.12)" } },
    axisTick: { show: false },
    axisLabel: { color: "#94a3b8", fontSize: "var(--fs-xs)" },
  },
  yAxis: {
    type: "value" as const,
    splitLine: { lineStyle: { color: "rgba(0,0,0,0.06)" } },
    axisLabel: { color: "#94a3b8", fontSize: "var(--fs-xs)" },
  },
};

/** 2026-10-15（round 76-FK，规范 §5 ⑤）**把主题色真正接到图表底座上**。
 *  背景: useThemeColors 早就建好了(它的注释里就写着"EChart.tsx 原本硬编码亮色主题值"),
 *        但 chartBase 一直是**写死的亮色常量** ✗ —— 暗色下坐标轴/图例文字因此偏暗、看不清。
 *  做法: 以 chartBase 为底, 把**文字/网格/提示框**这些随主题变的色替换成当前主题真实色。
 *  用法: const base = useChartBase(); 然后 ...base.xAxis 等;
 *        各面板**不要再自己写 color: "#94a3b8"** —— 那会把这里的主题适配盖掉 ✗。
 */
export function useChartBase() {
  const c = useThemeColors();
  return {
    ...chartBase,
    /** 2026-11-09 轮 A2：把当前主题的真实色值**显式暴露**给面板。
     *  为什么：面板里原来写 "#d97706"/"#0d9488" 这类 hex，靠 HEX_TO_KEY 在渲染时偷偷换成 token ——
     *  源码看着是硬编码，实际跟随主题，两边都难读。改成 base.colors.x 后，源码即 token，且取值不变。 */
    colors: c,
    textStyle: { ...chartBase.textStyle, color: c.textDim },
    tooltip: {
      ...chartBase.tooltip,
      backgroundColor: c.bgSurface,
      borderColor: c.border,
      textStyle: { ...chartBase.tooltip.textStyle, color: c.text },
    },
    xAxis: {
      ...chartBase.xAxis,
      axisLine: { lineStyle: { color: c.border } },
      axisLabel: { ...chartBase.xAxis.axisLabel, color: c.textMuted },
    },
    yAxis: {
      ...chartBase.yAxis,
      splitLine: { lineStyle: { color: c.border } },
      axisLabel: { ...chartBase.yAxis.axisLabel, color: c.textMuted },
    },
  };
}
