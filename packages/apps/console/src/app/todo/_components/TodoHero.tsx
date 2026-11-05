"use client";
// /todo · 页头内容（P1 试点页 ord-20261104-032）
// 改前：PageHero（自写 h1 层级，不在白名单的「唯一标题」约束里）。
// 改后：页头容器与标题由 page.tsx 的 PageHeader/PageTitle 负责，本文件只提供口径 / 权限与计数 chips /
//       数据时刻 / 刷新与互链 —— 全部走类名，无内联样式。
import Link from "next/link";
import { Button, ReloadOutlined } from "@/components/primitives";
import { Pill } from "@/components/ui";
import { t as tr } from "@/i18n";
import { fmtNum } from "@/lib/format";
import styles from "../page.module.css";

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
    <>
      <div className="page-subtitle">{tr("todo.subtitle")}</div>
      <div className={styles.headTags}>
        <Pill tone="info">未完成 {fmtNum(openCount)}</Pill>
        <Pill tone="warn">需要人决策 {fmtNum(humanOpen)}</Pill>
        {overdueCount ? <Pill tone="crit">逾期 {fmtNum(overdueCount)}</Pill> : <Pill tone="ok">无逾期</Pill>}
        <Pill tone="ok">今日完成 {fmtNum(doneTodayCount)}</Pill>
      </div>
      <div className={styles.headMeta}>
        <span className="tiny">数据时间 {asOf ? new Date(asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}</span>
        <span className="tiny">共 {fmtNum(rowsCount)} 条 · 明细上限 500</span>
        {/* 2026-09-24 [可见性缺口 todo_bdce470195d94307abff]: 按来源聚合的改进结果(待办/任务/验收)。
            按 IA 规则不占菜单(子页), 走深链; 页面 /flywheel/improvement-results。 */}
        <Link href="/flywheel/improvement-results" className={styles.inlineLink}>按来源看改进结果（待办 / 任务 / 验收）→</Link>
        <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button>
      </div>
    </>
  );
}
