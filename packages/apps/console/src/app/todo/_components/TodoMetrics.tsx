"use client";
// todo 页 · 指标卡行 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { MetricCard } from "@/components/ui";
import { t as tr } from "@/i18n";
import { fmtNum, fmtState } from "@/lib/format";

export default function TodoMetrics({
  data,
  counts,
  loadingAll,
  openCount,
  openInView,
  overdueCount,
  doneTodayCount,
  agentOpenCount,
  errorAll,
}: {
  data: any;
  counts: Record<string, number>;
  loadingAll: boolean;
  openCount: number;
  openInView?: number;
  overdueCount: number;
  doneTodayCount: number;
  agentOpenCount: number;
  /** 2026-10-15（round 76-ER，规范铁律 2）：整包取不到时 KPI 原来显示 **0** ✗（与"真的 0"分不清）。
   *  分层判据：**整包缺失** -> 未知；**包在、只是没有这个字段/键** -> 真的 0。 */
  errorAll?: boolean;
}) {
  return (
    <div className="metric-row">
      <MetricCard label="未完成待办" size="hero" tone="info" value={fmtState(data ? openCount : undefined, { loading: loadingAll, error: errorAll })} unit="条"
        hint={`全部未完成 · 当前视图 ${fmtNum(openInView ?? 0)} 条`} />
      <MetricCard label="需要人决策" tone={(data?.humanOpen ?? 0) > 0 ? "warn" : "ok"} value={fmtState(data ? (data.humanOpen ?? 0) : undefined, { loading: loadingAll, error: errorAll })} unit="条"
        hint="人类负责的未完成项" />
      <MetricCard label="逾期" tone={overdueCount ? "crit" : "ok"} value={fmtState(data ? overdueCount : undefined, { loading: loadingAll, error: errorAll })} unit="条"
        hint={overdueCount ? "已过截止时间, 建议优先处理" : "没有逾期待办"} />
      <MetricCard label="今日完成" tone="ok" value={fmtState(data ? doneTodayCount : undefined, { loading: loadingAll, error: errorAll })} unit="条"
        hint={`累计完成 ${fmtNum(counts.DONE || 0)} 条`} />
      <MetricCard label={tr('todo.agentCard.label')} tone="mute" value={fmtState(data ? agentOpenCount : undefined, { loading: loadingAll, error: errorAll })} unit="条"
        hint={tr('todo.agentCard.hint')} />
    </div>
  );
}