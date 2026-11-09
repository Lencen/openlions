"use client";
// flywheel/flow 页 · 队列与堆积面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { fmtN } from "./format";
import styles from "./FlowQueuesPanel.module.css";

/** 2026-10-13 round 76-DW: 加 ready —— 此前数据未到时 q() 一律返回 0,
 *  面板在加载期显示 8 个 0(实测 6 个被探针抓到), 属假计数。 */
// 2026-11-05 P2 批8：内联 style 清零；阈值色/未就绪弱化改 data-tone / data-loading 属性选择器。
type QueueTone = "crit" | "ok" | "dim" | "normal";

export default function FlowQueuesPanel({ q, ready }: { q: (k: string) => number; ready?: boolean }) {
  return (
    <div className={"panel " + styles.panelMb}>
      <div className="panel-header"><span className="panel-title">队列与堆积</span></div>
      <div className={styles.queueGrid}>
        {([
          ["待提炼会话", q("sessionPending"), q("sessionPending") > 300 ? "crit" : "normal"],
          ["处理中", q("sessionProcessing"), "normal"],
          ["失败会话(可重试)", q("sessionFailed"), q("sessionFailed") > 100 ? "crit" : "normal"],
          ["24h 自动跳过", q("sessionSkipped24"), "dim"],
          ["待聚合主题组", q("groupPending"), q("groupPending") > 500 ? "crit" : "normal"],
          ["飞轮作业排队", q("jobPending"), "normal"],
          ["飞轮作业运行中", q("jobRunning"), "ok"],
          ["DLQ", q("dlq"), q("dlq") > 20 ? "crit" : "normal"],
        ] as Array<[string, number, QueueTone]>).map(([label, v, tone]) => (
          <div key={label} className={styles.tile}>
            <div className={styles.tileLabel}>{label}</div>
            <div className={styles.tileValue} data-tone={tone} data-loading={ready === false}>{ready === false ? "…" : fmtN(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
