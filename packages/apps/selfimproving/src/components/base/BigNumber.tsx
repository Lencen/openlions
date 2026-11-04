"use client";

/**
 * 统一大数字组件 (BigNumber)
 *
 * 4 统一:
 *  - 千分位: 1,247 (1,000+)
 *  - 缩写: 11.8k / 1.2M (>= 10,000)
 *  - 等宽数字: font-feature-settings: tnum
 *  - 字号响应式: clamp(36px, 5vw, 80px)
 *
 * 跨 mind + task 复用
 */

import { useMemo } from "react";

export type BigNumberFormat = "thousand" | "compact" | "raw" | "percent";

export interface BigNumberProps {
  value: number | null | undefined;
  format?: BigNumberFormat;
  size?: "hero" | "lg" | "md" | "sm";
  precision?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  style?: React.CSSProperties;
}

function formatValue(value: number, format: BigNumberFormat, precision: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";

  if (format === "raw") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(precision);
  }

  if (format === "percent") {
    return `${(value * 100).toFixed(precision)}%`;
  }

  if (format === "compact") {
    if (Math.abs(value) >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (Math.abs(value) >= 10_000) {
      return `${(value / 1_000).toFixed(1)}k`;
    }
    if (Math.abs(value) >= 1_000) {
      return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
    }
    return value.toString();
  }

  // thousand (默认)
  return value.toLocaleString("en-US", { maximumFractionDigits: precision });
}

export function BigNumber({
  value,
  format = "thousand",
  size = "md",
  precision = 0,
  prefix = "",
  suffix = "",
  className = "",
  style,
}: BigNumberProps) {
  const display = useMemo(
    () => formatValue(value ?? NaN, format, precision),
    [value, format, precision]
  );

  const sizeClass =
    size === "hero" ? "kpi-value-lg" : size === "lg" ? "kpi-value" : size === "sm" ? "kpi-value-md" : "kpi-value-md";

  const baseStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontFeatureSettings: '"tnum" 1',
    letterSpacing: size === "hero" ? "-0.04em" : "-0.02em",
  };

  const sizeStyle: React.CSSProperties = {
    hero: { fontSize: "var(--text-hero)", fontWeight: 800, lineHeight: 0.9 },
    lg: { fontSize: "var(--text-3xl)", fontWeight: 700, lineHeight: 1 },
    md: { fontSize: "var(--text-2xl)", fontWeight: 700, lineHeight: 1.1 },
    sm: { fontSize: "var(--text-xl)", fontWeight: 600, lineHeight: 1.2 },
  }[size];

  return (
    <span
      className={`${sizeClass} ${className}`}
      style={{ ...baseStyle, ...sizeStyle, ...style }}
    >
      {prefix}
      {display}
      {suffix}
    </span>
  );
}
