"use client";
// todo 页 · 页头 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Button } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import Icon from "@/components/Icon";
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PageHero, Pill } from "@/components/ui";
import { t as tr } from "@/i18n";
import { fmtNum } from "@/lib/format";

export default function TodoHero({
  openCount,
  humanOpen,
  overdueCount,
  doneTodayCount,
  rowsCount,
  asOf,
  onRefresh,
}: {
  openCount: number;
  humanOpen: number;
  overdueCount: number;
  doneTodayCount: number;
  rowsCount: number;
  asOf?: any;
  onRefresh: () => void;
}) {
  return (
    <PageHero
      title="待办中心"
      subtitle={tr('todo.subtitle')}
      tags={
        <>
          <Pill tone="info">未完成 {fmtNum(openCount)}</Pill>
          <Pill tone="warn">需要人决策 {fmtNum(humanOpen)}</Pill>
          {overdueCount ? <Pill tone="crit">逾期 {fmtNum(overdueCount)}</Pill> : <Pill tone="ok">无逾期</Pill>}
          <Pill tone="ok">今日完成 {fmtNum(doneTodayCount)}</Pill>
        </>
      }
      meta={
        <>
          数据时间 {asOf ? new Date(asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
          <br />
          共 {fmtNum(rowsCount)} 条 · 明细上限 500
          <br />
          {/* 2026-09-24 [可见性缺口 todo_bdce470195d94307abff]: 按来源聚合的改进结果(待办/任务/验收)。
              按 IA 规则不占菜单(子页), 走深链; 页面 /flywheel/improvement-results。 */}
          <a href="/flywheel/improvement-results" className="tiny tiny-link" style={{ marginTop: "var(--sp-1)" }}><Icon name="search" size={14} /> 按来源看改进结果（待办 / 任务 / 验收）→</a>
          <br />
          <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} style={{ marginTop: "var(--sp-1-5)" }}>刷新</Button>
        </>
      }
    />
  );
}
