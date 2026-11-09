"use client";
// lineage 页 · 未提炼会话积压 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批6：内联 style 清零（样式下沉 LineageBacklogPanel.module.css）；
//   失败态配色走 data-tone 属性选择器，占比条宽度走 5% 档位类；取数/字段/文案未动。
import { PanelCard, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum } from "@/lib/format";
import styles from "./LineageBacklogPanel.module.css";

/** 占比 -> 5% 档位类（0/5/…/100），与 DataTable 骨架宽度同口径 */
function pctClass(pct: number): string {
  // 非有限值（数据缺失）不套档位类，保持改前「宽度声明失效 -> 由浏览器自适应」的行为
  if (!Number.isFinite(pct)) return "";
  const step = Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
  return styles["p" + step] || "";
}

export default function LineageBacklogPanel({ backlog, loadingAll }: { backlog: any; loadingAll: boolean }) {
  return (
    <PanelCard title="未提炼会话积压" tone="var(--status-warn)" extra={<span className="tiny">全量口径</span>}>
      {loadingAll ? <StateBlock loading rows={3} /> : (
        <>
          <div className={"stat-inline " + styles.statGap}>
            <div>
              <div className="tiny">已跳过会话</div>
              <div className={"mono " + styles.bigNum} data-tone="warn">{fmtNum(backlog?.skippedSessions)}</div>
              <div className="tiny">{fmtNum(backlog?.skippedMessages)} 条消息</div>
            </div>
            <div>
              <div className="tiny">待处理会话</div>
              <div className={"mono " + styles.bigNum}>{fmtNum(backlog?.pendingSessions)}</div>
              <div className="tiny">{fmtNum(backlog?.pendingMessages)} 条消息</div>
            </div>
            <div>
              <div className="tiny">失败会话</div>
              <div className={"mono " + styles.bigNum} data-tone={(backlog?.failedSessions || 0) ? "crit" : "default"}>{fmtNum(backlog?.failedSessions)}</div>
              <div className="tiny">处理中 {fmtNum(backlog?.processingSessions)}</div>
            </div>
          </div>
          {(backlog?.skippedByAgent ?? []).length ? (
            <div className={styles.mt3}>
              <div className={"tiny " + styles.mb1_5}>{t('lineage.byAgent')}</div>
              {(backlog.skippedByAgent ?? []).slice(0, 6).map((a: any) => (
                <div key={a.agentId || "unknown"} className={styles.agentRow}>
                  <span className={"truncate " + styles.agentName}>{a.agentId || t('lineage.unknownAgent')}</span>
                  <div className={"mini-bar " + styles.barFlex}>
                    <div className={"mini-bar-fill " + styles.warnFill + " " + pctClass((a.sessions / Math.max(backlog.skippedSessions, 1)) * 100 * 3)} />
                  </div>
                  <span className="mono nowrap">{fmtNum(a.sessions)} 会话 / {fmtNum(a.messages)} 消息</span>
                </div>
              ))}
              <div className={"tiny " + styles.mt1_5}>{backlog.reasonHint}</div>
            </div>
          ) : null}
        </>
      )}
    </PanelCard>
  );
}
