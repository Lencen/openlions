"use client";
import { ERROR_COLORS, QUALITY_COLORS, QUALITY_LABELS, fmt } from "./shared";
import { t } from "@/i18n";
import { entityLabel } from "@/config/artifactTypes";
import type { DashboardData } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";

/** Section 5: 数据质量 (堆叠条) + LLM 调用观测 + 错误分类 */
export default function FlywheelQualityGrid({
  d,
  llmTotal,
  llmOkRate,
  totalErrors,
}: {
  d: DashboardData;
  llmTotal: number;
  llmOkRate: number;
  totalErrors: number;
}) {
  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-header"><span className="panel-title">数据质量分布</span></div>
        <div className="stack-legend">
          {(["high","mid","low","zero"] as const).map(k => (
            <span key={k} style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)" }}>
              <span className="dot" style={{ background: QUALITY_COLORS[k] }} />
              {QUALITY_LABELS[k]}
            </span>
          ))}
        </div>
        {(["memory","knowledge","reflection","practice"] as const).map(type => {
          const items = d.qualityByType[type] || [];
          const total = items.reduce((s: number, x: any) => s + x.c, 0) || 1;
          const byBand: Record<string, number> = { high: 0, mid: 0, low: 0, zero: 0 };
          items.forEach((q: any) => { byBand[q.b] = q.c; });
          return (
            <div key={type} style={{ marginBottom: "var(--sp-2-5)" }}>
              <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600, marginBottom: "var(--sp-0-5)" }}>
                {entityLabel(type)} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>· {fmt(total)}</span>
              </div>
              <div className="stack-bar">
                {(["high","mid","low","zero"] as const).map(k => (
                  byBand[k] > 0 && (
                    <div key={k} className="stack-seg" style={{ width: `${(byBand[k] / total) * 100}%`, background: QUALITY_COLORS[k] }} />
                  )
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">LLM 调用观测 (24h)</span></div>
        {llmTotal === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-md)" }}>暂无 CALL_LLM 事件 (P1-C 打点待首次 LLM 调用)</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: "var(--sp-6)", marginBottom: "var(--sp-3)" }}>
              <div><span style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>总调用</span><div style={{ fontSize: "var(--fs-2xl)", fontWeight: 700 }}>{fmt(llmTotal)}</div></div>
              <div><span style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>成功</span><div style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--status-ok)" }}>{fmt(d.llmStats.ok24h)}</div></div>
              <div><span style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>失败</span><div style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: "var(--status-crit)" }}>{fmt(d.llmStats.fail24h)}</div></div>
              <div><span style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>成功率</span><div style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: llmOkRate >= 90 ? "var(--status-ok)" : llmOkRate >= 60 ? "var(--status-warn)" : "var(--status-crit)" }}>{llmOkRate}%</div></div>
            </div>
            <TableCopyButton />
            <table className="tbl">
              <thead><tr><th>入口</th><th>调用</th><th>成功</th><th>平均耗时</th></tr></thead>
              <tbody>
                {d.llmStats.byEntry.map(en => (
                  <tr key={en.entry}>
                    <td>{en.entry}</td>
                    <td>{en.calls}</td>
                    <td>{en.ok}</td>
                    <td>{Math.round(en.avgMs)}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">错误分类 (24h)</span></div>
        {d.errors.length === 0 ? (
          <div style={{ color: "var(--status-ok)", fontSize: "var(--fs-md)" }}>✅ 无错误</div>
        ) : (
          <>
            {d.errors.map(e => (
              <div key={e.errorType} className="theme-row" style={{ marginBottom: "var(--sp-1-5)" }}>
                <span className="theme-name" style={{ color: ERROR_COLORS[e.errorType] || "var(--err-unknown)" }}>{e.errorType}</span>
                <div className="theme-bar-wrap">
                  <div className="theme-bar" style={{ width: `${(e.cnt / totalErrors) * 100}%`, background: ERROR_COLORS[e.errorType] || "var(--err-unknown)" }} />
                </div>
                <span className="theme-cnt">{e.cnt}</span>
              </div>
            ))}
            <div style={{ marginTop: "var(--sp-4)", fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>
              {t('biz.resolver.decision1h')}
              {d.resolverStats.length === 0 ? <span> 无数据</span> : d.resolverStats.map(r => (
                <span key={r.resolverAction} style={{ marginLeft: "var(--sp-2-5)" }}>
                  <strong style={{ color: r.resolverAction === "CREATE" ? "var(--info)" : r.resolverAction === "UPDATE" ? "var(--status-ok)" : "var(--text-muted)" }}>{r.cnt}</strong> {r.resolverAction}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
