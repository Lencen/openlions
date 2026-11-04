"use client";
// 任务详情页 · 指标卡行 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { MetricCard } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { STATUS_TAG } from "./constants";

export default function TaskMetrics({
  task,
  stats,
  loading,
}: {
  task: any;
  stats: any;
  loading: boolean;
}) {
  return (
    <div className="metric-row">
      <MetricCard label="状态" tone={task.status === "DONE" ? "ok" : task.status === "FAILED" ? "crit" : "info"} value={STATUS_TAG[task.status]?.label || task.status} hint={task.improvementType || "未分类"} />
      <MetricCard label="全流程耗时" tone="mute" value={stats?.durationMs ? Math.round(stats.durationMs / 1000) : "-"} unit="秒" hint={task.completedAt ? "创建 → 完成" : "尚未完成"} />
      <MetricCard label="状态流转" tone="info" value={loading ? "…" : fmtNum(stats?.transitions)} unit="次" hint="任务状态流转审计链" />
      <MetricCard label="智能体执行" tone="info" value={loading ? "…" : fmtNum(stats?.executions)} unit="次" hint={`产出 ${fmtNum(stats?.outputChars)} 字`} />
      <MetricCard label="关联产物" tone="ok" value={loading ? "…" : fmtNum(stats?.products)} unit="条" hint="认知表 sourceId = 本任务" />
      <MetricCard label="平台裁定" tone={(stats?.verdicts || 0) > 0 ? "warn" : "mute"} value={loading ? "…" : fmtNum(stats?.verdicts)} unit="次" hint={`上下文注入 ${fmtNum(stats?.injections)} 次`} />
      <MetricCard label="相关待办" tone={(stats?.todos || 0) > 0 ? "warn" : "mute"} value={loading ? "…" : fmtNum(stats?.todos)} unit="条" hint="由本任务引发的待办" />
    </div>
  );
}
