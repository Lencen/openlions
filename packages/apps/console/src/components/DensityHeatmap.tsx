"use client";
// Phase3 屏07/08/10 等的『密度热力』(D 型): 一种关系一种图型 (规范 §7)
// 语义: 单一关系 = 密度 (行 × 列), 语义色 = --brand 单色深浅 (ramp 由组件内派生, 不用外部传色)。
// 实现: 自研 SVG, 不依赖 echarts; 行标签放左, 单元格右下方注小角数字 (字体 9px, --text-3)。
// 可访问性: 容器 role="img" + aria-label 概述关键结论; 视觉隐藏的 <table> 等效数据 (规范 §10)。
// 主题: 通过 CSS 变量 --brand / --brand-soft / --bg-surface / --text-3 取色, 三主题跟随。

import { useEffect, useMemo, useState } from "react";

export interface DensityHeatmapCell {
  /** 列标题 (X 标签) */
  col: string;
  /** 行标题 (Y 标签) */
  row: string;
  /** 数值, 用于计算色阶 */
  value: number;
}

export interface DensityHeatmapProps {
  /** 行标签 (Y 轴), 顺序即自上而下 */
  rows: string[];
  /** 列标签 (X 轴), 顺序即自左而右 */
  cols: string[];
  /** 单元格, 必须覆盖 rows × cols 的笛卡尔积 (缺则视为 0) */
  cells: DensityHeatmapCell[];
  /** 高度 (像素), 默认根据行数推算 */
  rowHeight?: number;
  /** 列宽 (像素), 默认 56 */
  colWidth?: number;
  /** 可访问性标签, 描述"这个图在讲什么" */
  ariaLabel?: string;
}

function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function rampColor(t: number, brand: string, brandSoft: string): string {
  // t ∈ [0, 1] -> 颜色从浅 (soft) 渐变到品牌色 (深)
  // 在没有 OKLCH 工具时, 用 mix 思路手算: 0..1 透明度叠加。
  // 实现: 返回一个带 alpha 的品牌色 (覆盖在白底上 = 视觉渐深)。
  const clamped = Math.max(0, Math.min(1, t));
  return `color-mix(in srgb, ${brand} ${Math.round(clamped * 100)}%, ${brandSoft})`;
}

export default function DensityHeatmap({
  rows,
  cols,
  cells,
  rowHeight = 28,
  colWidth = 56,
  ariaLabel,
}: DensityHeatmapProps) {
  // 主题色: client-only 取 CSS 变量, SSR 取兜底
  const [palette, setPalette] = useState({ brand: "#6366f1", brandSoft: "#e0e7ff", border: "rgba(0,0,0,0.08)", text: "#475569", labelDim: "#94a3b8" });
  useEffect(() => {
    setPalette({
      brand: readVar("--brand", "#6366f1"),
      brandSoft: readVar("--brand-soft", "#e0e7ff"),
      border: readVar("--border", "rgba(0,0,0,0.08)"),
      text: readVar("--text", "#475569"),
      labelDim: readVar("--text-dim", "#94a3b8"),
    });
    // 监听 data-theme 变化, 主题切换即更新色板 (规范 §7.1: 只更新 option, 不销毁实例)
    const obs = new MutationObserver(() => {
      setPalette({
        brand: readVar("--brand", "#6366f1"),
        brandSoft: readVar("--brand-soft", "#e0e7ff"),
        border: readVar("--border", "rgba(0,0,0,0.08)"),
        text: readVar("--text", "#475569"),
        labelDim: readVar("--text-dim", "#94a3b8"),
      });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // 索引化 cells -> [row][col] -> value
  const grid = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) m.set(`${c.row}\u0000${c.col}`, c.value);
    return m;
  }, [cells]);

  // 找最大, 用于归一化
  const max = useMemo(() => {
    let m = 0;
    for (const c of cells) if (c.value > m) m = c.value;
    return m;
  }, [cells]);

  // 若 max = 0, 给一个最小可见度
  const labelLeft = 96;
  const width = labelLeft + cols.length * colWidth;
  const height = rows.length * rowHeight;

  return (
    <div role="img" aria-label={ariaLabel || `${rows.length} 行 × ${cols.length} 列 密度热力图`}>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", maxWidth: width }}
      >
        {/* 行标签 */}
        {rows.map((r, ri) => (
          <text
            key={`r-${ri}`}
            x={labelLeft - 8}
            y={ri * rowHeight + rowHeight / 2 + 3}
            fontSize={10}
            textAnchor="end"
            fill={palette.labelDim}
            fontFamily="-apple-system, 'PingFang SC', sans-serif"
          >
            {r}
          </text>
        ))}
        {/* 列标签 (顶上一行) */}
        {cols.map((c, ci) => (
          <text
            key={`c-${ci}`}
            x={labelLeft + ci * colWidth + colWidth / 2}
            y={-2}
            fontSize={10}
            textAnchor="middle"
            fill={palette.labelDim}
            fontFamily="-apple-system, 'PingFang SC', sans-serif"
          >
            {c}
          </text>
        ))}
        {/* 单元格 */}
        {rows.map((r, ri) =>
          cols.map((c, ci) => {
            const v = grid.get(`${r}\u0000${c}`) ?? 0;
            const t = max > 0 ? v / max : 0;
            // 颜色: 留一个最小可见度 (0.05), 避免 0 计数看不见
            const fill = rampColor(Math.max(t, 0.05), palette.brand, palette.brandSoft);
            return (
              <g key={`${ri}-${ci}`}>
                <rect
                  x={labelLeft + ci * colWidth}
                  y={ri * rowHeight}
                  width={colWidth}
                  height={rowHeight}
                  fill={fill}
                  stroke={palette.border}
                  strokeWidth={0.5}
                />
                {v > 0 ? (
                  <text
                    x={labelLeft + ci * colWidth + colWidth - 4}
                    y={ri * rowHeight + rowHeight - 4}
                    fontSize={9}
                    textAnchor="end"
                    fill={t > 0.5 ? "#fff" : palette.text}
                    fontFamily="-apple-system, 'PingFang SC', sans-serif"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {v}
                  </text>
                ) : null}
              </g>
            );
          })
        )}
      </svg>

      {/* 视觉隐藏的等效数据表 (规范 §10: 状态不能只靠颜色) */}
      <table style={{ position: "absolute", left: -9999, top: 0, width: 1, height: 1, overflow: "hidden" }} aria-hidden={false}>
        <caption>{ariaLabel || "密度热力数据"}</caption>
        <thead>
          <tr>
            <th></th>
            {cols.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th scope="row">{r}</th>
              {cols.map((c) => <td key={c}>{grid.get(`${r}\u0000${c}`) ?? 0}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}