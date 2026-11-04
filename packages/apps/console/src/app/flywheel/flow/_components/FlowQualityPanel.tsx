"use client";
// flywheel/flow 页 · 24h 产出质量面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import type { FlowData } from "./types";
import { t } from "@/i18n";
import { entityLabel } from "@/config/artifactTypes";
import { fmtN } from "./format";
import TableCopyButton from "@/components/TableCopyButton";

export default function FlowQualityPanel({ d }: { d: FlowData | null }) {
  return (
    <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
      <div className="panel-header"><span className="panel-title">24h 产出质量</span></div>
      <TableCopyButton />
      <table className="tbl">
        <thead><tr><th>产物类型</th><th style={{ textAlign: "right" }}>24h 产出</th><th style={{ textAlign: "right" }}>未打分</th><th style={{ textAlign: "right" }}>均分(有分)</th><th style={{ textAlign: "right" }}>高质 ≥0.7</th><th style={{ textAlign: "right" }}>低质 &lt;0.4</th></tr></thead>
        <tbody>
          {Object.entries(d?.quality ?? {}).map(([name, v]) => (
            <tr key={name}>
              <td><strong>{entityLabel(name)}</strong></td>
              <td style={{ textAlign: "right" }}>{fmtN(v?.n)}</td>
              <td style={{ textAlign: "right", color: (v?.unscored ?? 0) > 0 ? "var(--status-crit)" : "var(--text-dim)" }}>{fmtN(v?.unscored)}</td>
              <td style={{ textAlign: "right", fontWeight: 700, color: (v?.avgQ ?? 0) >= 0.7 ? "var(--status-ok)" : (v?.avgQ ?? 0) >= 0.4 ? "var(--text)" : "var(--status-crit)" }}>{v?.avgQ ?? "—"}</td>
              <td style={{ textAlign: "right", color: "var(--status-ok)" }}>{fmtN(v?.highQ)}</td>
              <td style={{ textAlign: "right", color: (v?.lowQ ?? 0) > 0 ? "var(--status-crit)" : "var(--text-dim)" }}>{fmtN(v?.lowQ)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: "var(--sp-6)", marginTop: "var(--sp-2-5)", fontSize: "var(--fs-base)", color: "var(--text-dim)", flexWrap: "wrap" }}>
        <span>{t('biz.resolver.decision24h')} {(d?.resolver || []).map((r) => r.action + " " + r.c).join(" · ") || "—"}</span>
        <span>主题反思 24h: {(d?.reflectStatus || []).map((r) => r.status + " " + r.c).join(" · ") || "—"}</span>
        <span>错误 24h: {(d?.errToday || []).map((r) => r.errorType + " " + r.c).join(" · ") || "无"}</span>
      </div>
    </div>
  );
}
