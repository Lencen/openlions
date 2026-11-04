"use client";
import Link from "next/link";
import MetricCard from "./MetricCard";
import { Pill } from "./ui";
import type { MetricSpec } from "./types";

export function OverviewCards({ metrics, s }: { metrics: MetricSpec[]; s: any }) {
  return (
    <div className="card-grid cols-4" data-testid="overview-cards">
      {metrics.map((m) => <MetricCard key={m.key} m={m} s={s} />)}
    </div>
  );
}

export function RedLines({ lines }: { lines: any[] }) {
  return (
    <div>
      <div className="tiny" style={{ color: "var(--text-muted)", marginBottom: 6 }}>三条守门线：验收 / 隔离 / 外部故障</div>
      <div className="card-grid cols-3" data-testid="red-lines">
      {lines.map((l, i) => {
        const tone = l.status === "ok" ? "var(--status-ok)" : l.status === "warn" ? "var(--status-warn)" : l.status === "nodata" ? "var(--text-muted)" : "var(--status-crit)";
        return (
        <Link key={l.key} href={l.href} className="panel" data-redline={l.key}
          style={{ padding: "var(--sp-3)", textDecoration: "none", color: "inherit", borderLeft: "3px solid " + tone }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <span className="tiny" style={{ color: "var(--text-muted)" }}>守门 {i + 1} · {l.title}</span>
            <Pill status={l.status} />
          </div>
          <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, margin: "4px 0" }}>{l.value}</div>
          <div className="tiny" style={{ color: "var(--text-dim)" }}>{l.sub}</div>
          <div className="tiny" style={{ color: "var(--text-muted)", marginTop: 6 }}>动作：{l.action} · 责任人：{l.owner}</div>
        </Link>
        );
      })}
      </div>
    </div>
  );
}
