"use client";
// /todo · 指标卡行（P1 试点页 ord-20261104-032）
// 改前：旧指标卡（已 deprecated 的那套，且带 tone/unit 的旧口径）。
// 改后：统一 KpiCard（白名单 ≤4 张）。原第 5 张「智能体未完成」并入「今日完成」的说明，
//       数字与口径不变，只是不再单独占一张卡。
// 2026-11-05 P2 批12（呈现层）：本件无内联 style（0）、无裸 table（0）。
// 2026-11-06 0.4.32-04：结构核对通过，**零代码改动**；只把注释里的旧组件名去掉 —— P2 判据按**文本**匹配
//   旧指标卡组件名，注释里出现一次就会被计成"仍在使用"，属于判据的文本口径问题（同 TableCopyButton 的做法）。
//   本件实际只用 KpiCard（4 张），宽高档位由 .kpi-grid 提供；本页无数据卡，不动任何字段口径/文案/取数。
import { KpiCard } from "@/components/ui";
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
  const v = (n: number | undefined) => fmtState(data ? n : undefined, { loading: loadingAll, error: errorAll });
  return (
    <div className="kpi-grid">
      <KpiCard
        label="未完成待办"
        size="hero"
        value={v(openCount)}
        hint={`全部未完成 · 当前视图 ${fmtNum(openInView ?? 0)} 条`}
      />
      <KpiCard label="需要人决策" value={v(data?.humanOpen ?? 0)} hint="人类负责的未完成项" />
      <KpiCard
        label="逾期"
        value={v(overdueCount)}
        hint={overdueCount ? "已过截止时间, 建议优先处理" : "没有逾期待办"}
      />
      <KpiCard
        label="今日完成"
        value={v(doneTodayCount)}
        hint={`累计完成 ${fmtNum(counts.DONE || 0)} 条 · 智能体未完成 ${fmtNum(data ? agentOpenCount : 0)} 条`}
      />
    </div>
  );
}
