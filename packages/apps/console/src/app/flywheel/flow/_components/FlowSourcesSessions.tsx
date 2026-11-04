"use client";
// flywheel/flow 页 · LLM 入口 + session 处理面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { t } from "@/i18n";
import type { FlowData } from "./types";
import { fmtN } from "./format";
import TableCopyButton from "@/components/TableCopyButton";

export default function FlowSourcesSessions({ d }: { d: FlowData | null }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-4)", marginBottom: "var(--sp-4)" }}>
      <div className="panel">
        <div className="panel-header"><span className="panel-title">LLM 调用入口 + 反思→任务 (24h)</span></div>
        {(d?.sources?.length ?? 0) ? (
          <>
          <TableCopyButton />
          <table className="tbl"><tbody>
            {d!.sources.slice(0, 12).map((s) => (
              <tr key={s.source}>
                <td><code style={{ fontSize: "var(--fs-base)" }}>{s.source}</code></td>
                <td style={{ textAlign: "right" }}>{fmtN(s.events)}</td>
              </tr>
            ))}
          </tbody></table>
          </>
        ) : <div style={{ padding: "var(--sp-5)", color: "var(--text-muted)", textAlign: "center" }}>{d ? "暂无" : "…"}</div>}
      </div>
      <div className="panel">
        <div className="panel-header"><span className="panel-title">{t('flow.sessByAgent')}</span></div>
        {(d?.sessByAgent?.length ?? 0) ? (
          <>
          <TableCopyButton />
          <table className="tbl">
            <thead><tr><th>{t('flow.col.agent')}</th><th style={{ textAlign: "right" }}>同步</th><th style={{ textAlign: "right" }}>已提炼</th><th style={{ textAlign: "right" }}>待处理</th><th style={{ textAlign: "right" }}>失败</th></tr></thead>
            <tbody>
              {d!.sessByAgent.slice(0, 10).map((a) => (
                <tr key={a.agentId}>
                  <td className="nowrap"><strong>{String(a.agentId).replace("agent-", "")}</strong></td>
                  <td style={{ textAlign: "right" }}>{fmtN(a.total)}</td>
                  <td style={{ textAlign: "right", color: "var(--status-ok)" }}>{fmtN(a.doneN)}</td>
                  <td style={{ textAlign: "right" }}>{fmtN(a.pendingN)}</td>
                  <td style={{ textAlign: "right", color: (a.failedN || 0) > 3 ? "var(--status-crit)" : "var(--text-dim)" }}>{fmtN(a.failedN)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        ) : <div style={{ padding: "var(--sp-5)", color: "var(--text-muted)", textAlign: "center" }}>{d ? "暂无" : "…"}</div>}
        {(d?.recentProcessed?.length ?? 0) > 0 && (
          <div style={{ marginTop: "var(--sp-2-5)", fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>
            最近已提炼:
            {d!.recentProcessed.slice(0, 5).map((s) => (
              <div key={s.sessionUid} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ color: "var(--text)" }}>{String(s.agentId).replace("agent-", "")}</span> · {String(s.sessionUid).split(":").pop()} · {s.messageCount}msgs · {s.t}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
