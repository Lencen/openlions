"use client";
// flywheel/flow 页 · 实时日志面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
/** 2026-10-13 round 76-DX: 加 ready —— 数据未到时原来显示「暂无日志」,
 *  那是**假空态**(实测门把它列为候选)。 */
export default function FlowLogsPanel({ logs, ready }: { logs?: string[]; ready?: boolean }) {
  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">飞轮实时日志 (尾部)</span></div>
      <pre style={{ maxHeight: 260, overflowY: "auto", fontSize: "var(--fs-sm)", lineHeight: 1.5, color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
        {ready === false ? "…" : (logs || []).join("\n") || "暂无日志"}
      </pre>
    </div>
  );
}
