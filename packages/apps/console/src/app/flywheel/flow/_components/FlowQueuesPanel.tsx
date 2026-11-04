"use client";
// flywheel/flow 页 · 队列与堆积面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { fmtN } from "./format";

/** 2026-10-13 round 76-DW: 加 ready —— 此前数据未到时 q() 一律返回 0,
 *  面板在加载期显示 8 个 0(实测 6 个被探针抓到), 属假计数。 */
export default function FlowQueuesPanel({ q, ready }: { q: (k: string) => number; ready?: boolean }) {
  return (
    <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
      <div className="panel-header"><span className="panel-title">队列与堆积</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--sp-2)" }}>
        {([
          ["待提炼会话", q("sessionPending"), q("sessionPending") > 300 ? "var(--status-crit)" : "var(--text)"],
          ["处理中", q("sessionProcessing"), "var(--text)"],
          ["失败会话(可重试)", q("sessionFailed"), q("sessionFailed") > 100 ? "var(--status-crit)" : "var(--text)"],
          ["24h 自动跳过", q("sessionSkipped24"), "var(--text-dim)"],
          ["待聚合主题组", q("groupPending"), q("groupPending") > 500 ? "var(--status-crit)" : "var(--text)"],
          ["飞轮作业排队", q("jobPending"), "var(--text)"],
          ["飞轮作业运行中", q("jobRunning"), "var(--status-ok)"],
          ["DLQ", q("dlq"), q("dlq") > 20 ? "var(--status-crit)" : "var(--text)"],
        ] as Array<[string, number, string]>).map(([label, v, color]) => (
          <div key={label} style={{ background: "var(--bg-surface2,#16212b)", borderRadius: "var(--radius-md)", padding: "var(--sp-2-5)" }}>
            <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{label}</div>
            <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, color: ready === false ? "var(--text-dim)" : color }}>{ready === false ? "…" : fmtN(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
