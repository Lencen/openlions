"use client";
import type { DailyReport } from "./shared";
import Link from "next/link";

/** 服务状态 */
export default function DailyServices({ services }: { services: DailyReport["services"] }) {
  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">服务状态</span>
          {/* 2026-10-19 B5: 服务异常时没有出口 ✗ -> 链到健康检查(它会逐个 ping 并给延迟) ✓ */}
          <Link href="/system/health" className="tiny" style={{ marginLeft: "auto" }}>健康检查详情 →</Link></div>
      <div style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", padding: "var(--sp-2) 0" }}>
        {services.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: "var(--sp-1-5)" }}>
            <span className="dot" style={{ background: s.status === "online" ? "var(--status-ok)" : "var(--status-crit)" }} />
            <span style={{ fontSize: "var(--fs-md)" }}>{s.name}</span>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>:{s.port}</span>
            <span style={{ fontSize: "var(--fs-sm)", color: s.status === "online" ? "var(--status-ok)" : "var(--status-crit)" }}>{s.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
