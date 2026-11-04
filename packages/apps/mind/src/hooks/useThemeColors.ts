"use client";

/**
 * useThemeColors - 把 CSS var (var(--xxx)) 解析成真实颜色, 给 echarts/Canvas API 用
 *
 * 根因 (2026-06-17 P3 修复): echarts axisLabel.color 不解析 CSS var,
 * 传 "var(--ink-tertiary)" 字符串会被 echarts 当作非法色, fallback 黑色 → 雷达图/堆叠图黑屏
 *
 * 用法:
 *   const C = useThemeColors();
 *   axisLabel: { color: C.inkTertiary }
 *
 * 兼容 4 主题切换 (dark/light/glass/mono), 切换后 useMemo 自动 invalidate
 */

import { useEffect, useState } from "react";

export interface ThemeColors {
  // text
  inkPrimary: string;
  inkSecondary: string;
  inkTertiary: string;
  inkDim: string;
  // bg / surface
  bgBase: string;
  bgElevated: string;
  surface: string;
  surfaceHi: string;
  // border
  border: string;
  borderHi: string;
  borderSoft: string;
  // brand
  brandMind: string;
  brandMindSoft: string;
  brandAxon: string;
  brandSynapse: string;
  brandFlow: string;
  // status
  statusOk: string;
  statusWarn: string;
  statusErr: string;
  statusFrozen: string;
  statusInfo: string;
}

function readVar(name: string): string {
  if (typeof window === "undefined") return "#000";
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || "#000";
}

function readAll(): ThemeColors {
  return {
    inkPrimary: readVar("--ink-primary"),
    inkSecondary: readVar("--ink-secondary"),
    inkTertiary: readVar("--ink-tertiary"),
    inkDim: readVar("--ink-dim"),
    bgBase: readVar("--bg-base"),
    bgElevated: readVar("--bg-elevated"),
    surface: readVar("--surface"),
    surfaceHi: readVar("--surface-hi"),
    border: readVar("--border"),
    borderHi: readVar("--border-hi"),
    borderSoft: readVar("--border-soft"),
    brandMind: readVar("--brand-mind"),
    brandMindSoft: readVar("--brand-mind-soft"),
    brandAxon: readVar("--brand-axon"),
    brandSynapse: readVar("--brand-synapse"),
    brandFlow: readVar("--brand-flow"),
    statusOk: readVar("--status-ok"),
    statusWarn: readVar("--status-warn"),
    statusErr: readVar("--status-err"),
    statusFrozen: readVar("--status-frozen"),
    statusInfo: readVar("--status-info"),
  };
}

const DEFAULTS: ThemeColors = {
  inkPrimary: "#e2e8f0",
  inkSecondary: "#cbd5e1",
  inkTertiary: "#94a3b8",
  inkDim: "#64748b",
  bgBase: "#0a0f1c",
  bgElevated: "#111827",
  surface: "#0f172a",
  surfaceHi: "#1e293b",
  border: "rgba(148, 163, 184, 0.12)",
  borderHi: "rgba(148, 163, 184, 0.24)",
  borderSoft: "rgba(148, 163, 184, 0.06)",
  brandMind: "#5eead4",
  brandMindSoft: "#14b8a6",
  brandAxon: "#a78bfa",
  brandSynapse: "#fbbf24",
  brandFlow: "#60a5fa",
  statusOk: "#10b981",
  statusWarn: "#f59e0b",
  statusErr: "#ef4444",
  statusFrozen: "#6b7280",
  statusInfo: "#38bdf8",
};

export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(DEFAULTS);

  useEffect(() => {
    setColors(readAll());

    // 监听主题切换 (data-theme 属性变化)
    const observer = new MutationObserver(() => {
      setColors(readAll());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}