"use client";
// lineage 页 · 未提炼会话积压 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { PanelCard, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum } from "@/lib/format";

export default function LineageBacklogPanel({ backlog, loadingAll }: { backlog: any; loadingAll: boolean }) {
  return (
    <PanelCard title="未提炼会话积压" tone="var(--status-warn)" extra={<span className="tiny">全量口径</span>}>
      {loadingAll ? <StateBlock loading rows={3} /> : (
        <>
          <div className="stat-inline" style={{ gap: "var(--sp-4)" }}>
            <div>
              <div className="tiny">已跳过会话</div>
              <div className="mono" style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, color: "var(--status-warn)" }}>{fmtNum(backlog?.skippedSessions)}</div>
              <div className="tiny">{fmtNum(backlog?.skippedMessages)} 条消息</div>
            </div>
            <div>
              <div className="tiny">待处理会话</div>
              <div className="mono" style={{ fontSize: "var(--fs-2xl)", fontWeight: 600 }}>{fmtNum(backlog?.pendingSessions)}</div>
              <div className="tiny">{fmtNum(backlog?.pendingMessages)} 条消息</div>
            </div>
            <div>
              <div className="tiny">失败会话</div>
              <div className="mono" style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, color: (backlog?.failedSessions || 0) ? "var(--status-crit)" : "var(--text)" }}>{fmtNum(backlog?.failedSessions)}</div>
              <div className="tiny">处理中 {fmtNum(backlog?.processingSessions)}</div>
            </div>
          </div>
          {(backlog?.skippedByAgent ?? []).length ? (
            <div style={{ marginTop: "var(--sp-3)" }}>
              <div className="tiny" style={{ marginBottom: "var(--sp-1-5)" }}>{t('lineage.byAgent')}</div>
              {(backlog.skippedByAgent ?? []).slice(0, 6).map((a: any) => (
                <div key={a.agentId || "unknown"} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--fs-sm)", marginBottom: "var(--sp-1)" }}>
                  <span className="truncate" style={{ width: 130 }}>{a.agentId || t('lineage.unknownAgent')}</span>
                  <div className="mini-bar" style={{ flex: 1 }}>
                    <div className="mini-bar-fill" style={{ width: `${Math.min(100, (a.sessions / Math.max(backlog.skippedSessions, 1)) * 100 * 3)}%`, background: "var(--status-warn)" }} />
                  </div>
                  <span className="mono nowrap">{fmtNum(a.sessions)} 会话 / {fmtNum(a.messages)} 消息</span>
                </div>
              ))}
              <div className="tiny" style={{ marginTop: "var(--sp-1-5)" }}>{backlog.reasonHint}</div>
            </div>
          ) : null}
        </>
      )}
    </PanelCard>
  );
}
