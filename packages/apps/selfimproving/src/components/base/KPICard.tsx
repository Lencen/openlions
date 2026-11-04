"use client";

/**
 * KPI 卡片 (KPICard)
 * 统一 6 KPI 样式: 顶 label / 中央大数字 / 底部 sub / 左侧品牌色条
 *
 * 跨 mind + task 复用
 */

import { BigNumber } from "./BigNumber";

export type KPICardTone = "mind" | "axon" | "synapse" | "flow" | "ok" | "warn" | "err" | "frozen";

export interface KPICardProps {
  label: string;
  value: number | null | undefined;
  sub?: string | React.ReactNode;
  tone?: KPICardTone;
  format?: "thousand" | "compact" | "raw" | "percent";
  precision?: number;
  size?: "sm" | "md" | "lg";
  href?: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  extra?: React.ReactNode;
}

const TONE_TO_COLOR: Record<KPICardTone, string> = {
  mind: "var(--brand-mind)",
  axon: "var(--brand-axon)",
  synapse: "var(--brand-synapse)",
  flow: "var(--brand-flow)",
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  err: "var(--status-err)",
  frozen: "var(--status-frozen)",
};

export function KPICard({
  label,
  value,
  sub,
  tone = "mind",
  format = "thousand",
  precision = 0,
  size = "md",
  href,
  onClick,
  icon,
  extra,
}: KPICardProps) {
  const toneColor = TONE_TO_COLOR[tone];

  const paddingMap = { sm: 14, md: 18, lg: 24 } as const;
  const padding = paddingMap[size];

  const content = (
    <div
      className="card"
      style={{
        position: "relative",
        padding,
        cursor: onClick || href ? "pointer" : "default",
        overflow: "hidden",
        transition: "all 0.2s var(--ease-out)",
      }}
    >
      {/* 左侧 tone 色条 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: 3,
          background: toneColor,
          opacity: 0.8,
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-tertiary)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 500,
          }}
        >
          {label}
        </div>
        {icon && (
          <div style={{ color: toneColor, opacity: 0.7, fontSize: 16 }}>{icon}</div>
        )}
      </div>
      <BigNumber
        value={value}
        format={format}
        precision={precision}
        size={size === "lg" ? "lg" : size === "sm" ? "sm" : "md"}
        style={{ color: "var(--ink-primary)" }}
      />
      {sub && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-tertiary)",
            marginTop: 8,
            fontFamily: "var(--font-body)",
          }}
        >
          {sub}
        </div>
      )}
      {extra && <div style={{ marginTop: 8 }}>{extra}</div>}
    </div>
  );

  if (href) {
    return (
      <a href={href} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
        {content}
      </a>
    );
  }
  if (onClick) {
    return <div onClick={onClick}>{content}</div>;
  }
  return content;
}
