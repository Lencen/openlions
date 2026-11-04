"use client";
import DataMoment from "@/components/DataMoment";
// todo 页 · 页脚数据源说明 (从 page.tsx 抽出)
// 2026-10-16 round 77-AA（平台恢复后第一个页面改动, 决策③逐源 + 77-M 机检清单）:
//   本页有 **2 个数据源** —— /api/todos（待办本体）与 /api/agent-list（页头"智能体"那组数字）。
//   此前页脚只显示 **todos 的** asOf ✗ -> 智能体数字戴着待办的时刻（又一次"借时刻"）。
//   改法与首页(77-N)一致: **保留**原有出处说明, 在其后**追加**逐源 <DataMoment>;
//   由于该说明本身以「· 数据时间」结尾, 用 showPrefix={false} 避免"数据时间 数据时刻:"重复 ✓（77-N 加的属性在这里复用）。
export default function TodoFooter({ asOf, agentAsOf }: { asOf?: any; agentAsOf?: any }) {
  return (
    <div className="tiny" style={{ textAlign: "right" }}>
      数据源: mind <code>/api/v1/flywheel/todos</code> (console 代理 <code>/api/todos</code>) · 只读展示 + 人类操作会记 HUMAN_INTERVENTION (保证"真实自主率"诚实) · 数据时间{" "}
      <DataMoment showPrefix={false} items={[{ label: "待办", at: asOf }, { label: "智能体", at: agentAsOf }]} style={{ marginLeft: 0 }} />
    </div>
  );
}
