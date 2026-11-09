"use client";
// lineage 页 · 使用情况 (被认领注入) (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批9（呈现层）：内联 style 清零 → 同名 CSS Module；取数/文案/字段名未动。
import { PanelCard, StateBlock } from "@/components/ui";
import { fmtNum, relTime, truncate } from "@/lib/format";
import styles from "./LineageConsumptionPanel.module.css";

export default function LineageConsumptionPanel({ consumption, loadingAll }: { consumption: any; loadingAll: boolean }) {
  return (
    <PanelCard title="使用情况（被认领注入）" tone="var(--status-ok)">
      {loadingAll ? <StateBlock loading rows={3} /> : (
        <div className={styles.stack}>
          <div className={"stat-inline " + styles.statGap}>
            <div>
              <div className="tiny">注入事件</div>
              <div className={"mono " + styles.statValue}>{fmtNum(consumption?.injectionEvents)}</div>
            </div>
            <div>
              <div className="tiny">涉及产物</div>
              <div className={"mono " + styles.statValue}>{fmtNum(consumption?.injectedArtifacts)}</div>
            </div>
            <div>
              <div className="tiny">认领任务</div>
              <div className={"mono " + styles.statValue}>{fmtNum(consumption?.consumedTasks)}</div>
            </div>
          </div>
          <div className={"tiny " + styles.note}>
            知识累计被引用 <b>{fmtNum(consumption?.knowledgeUsage?.usageTotal)}</b> 次 ·
            有引用记录的知识 <b>{fmtNum(consumption?.knowledgeUsage?.usedRows)}</b> 条 ·
            最近引用 {consumption?.knowledgeUsage?.lastUsedAt ? relTime(consumption.knowledgeUsage.lastUsedAt) : "-"}
            <br />
            标记为过期 (stale) 的知识 <b>{fmtNum(consumption?.knowledgeUsage?.staleRows)}</b> 条
          </div>
          {(consumption?.recent ?? []).length ? (
            <div className={styles.recentList}>
              {(consumption.recent ?? []).slice(0, 4).map((c: any) => (
                <div key={c.taskId} className={styles.recentRow}>
                  <div className="truncate"><b>{c.agentId || "-"}</b> 注入 {c.count} 条 → {truncate(c.task?.title || c.taskId, 34)}</div>
                  <div className="tiny">{relTime(c.at)} · {c.task?.status || "-"}</div>
                </div>
              ))}
            </div>
          ) : <div className="tiny">窗口内暂无注入记录</div>}
        </div>
      )}
    </PanelCard>
  );
}
