"use client";
import type { ReactNode } from "react";
import type { Status } from "./types";

export const STATUS_META: Record<Status, { label: string; color: string; bg: string }> = {
  ok: { label: "达标", color: "var(--status-ok)", bg: "color-mix(in srgb, var(--status-ok) 12%, transparent)" },
  warn: { label: "关注", color: "var(--status-warn)", bg: "color-mix(in srgb, var(--status-warn) 14%, transparent)" },
  crit: { label: "未达标", color: "var(--status-crit)", bg: "color-mix(in srgb, var(--status-crit) 14%, transparent)" },
  nodata: { label: "无数据", color: "var(--text-muted)", bg: "color-mix(in srgb, var(--text-muted) 12%, transparent)" },
  info: { label: "参考", color: "var(--info)", bg: "color-mix(in srgb, var(--info) 12%, transparent)" },
};

export function Pill({ status, children }: { status: Status; children?: ReactNode }) {
  const m = STATUS_META[status] || STATUS_META.info;
  return (
    <span className="badge" style={{ color: m.color, background: m.bg, border: "1px solid " + m.color }}>
      {children || m.label}
    </span>
  );
}

export function Panel({ title, extra, children, style, testId }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; style?: React.CSSProperties; testId?: string }) {
  return (
    <section className="panel" data-testid={testId} style={style}>
      {title || extra ? (
        <div className="panel-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-2)" }}>
          <span className="panel-title">{title}</span>
          {extra ? <span className="tiny">{extra}</span> : null}
        </div>
      ) : null}
      <div style={{ padding: "var(--sp-3)" }}>{children}</div>
    </section>
  );
}

export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "crit" }) {
  const color = tone === "warn" ? "var(--status-warn)" : tone === "crit" ? "var(--status-crit)" : "var(--text-muted)";
  return <div className="tiny" style={{ color, lineHeight: 1.6 }}>{children}</div>;
}

export function SimpleTable({ head, rows, empty = "无数据", testId }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string; testId?: string }) {
  if (!rows.length) return <div className="tiny" style={{ color: "var(--text-muted)", padding: "var(--sp-2) 0" }}>{empty}</div>;
  return (
    <div style={{ overflowX: "auto" }} data-testid={testId}>
      <table className="tbl">
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function MetricLine({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span className="tiny" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ textAlign: "right", fontWeight: 500 }}>{value}{hint ? <span className="tiny" style={{ color: "var(--text-muted)" }}> {hint}</span> : null}</span>
    </div>
  );
}
