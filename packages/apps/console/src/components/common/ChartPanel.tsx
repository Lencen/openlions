"use client";
// 公共控件 (2026-09-14 页面瘦身): 图表卡片 = PanelCard + 加载/空态 + EChart。
// 抽取动机: cost / 首页 / lineage 的每张图都在重复 "loading ? Skeleton : empty ? Empty : <EChart/>" 三段式。
import type { ReactNode } from "react";
import EChart from "@/components/EChart";
import { PanelCard, StateBlock } from "@/components/ui";

export default function ChartPanel({
  title,
  extra,
  tone,
  loading,
  empty,
  emptyTitle,
  height = 260,
  option,
  footer,
}: {
  title: ReactNode;
  extra?: ReactNode;
  tone?: string;
  loading?: boolean;
  empty?: boolean;
  emptyTitle?: string;
  height?: number;
  option: any;
  footer?: ReactNode;
}) {
  return (
    <PanelCard title={title} extra={extra} tone={tone}>
      {loading ? (
        <StateBlock loading rows={4} />
      ) : empty ? (
        <StateBlock title={emptyTitle} rows={2} />
      ) : (
        <EChart height={height} option={option} />
      )}
      {footer}
    </PanelCard>
  );
}
