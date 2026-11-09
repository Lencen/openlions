// 2026-11-05 KPI 收敛 phase2（ord-027 裁决 A）：业务口径规格 {m, s} -> KpiCard variant="business" 的 props 适配器。
//   为什么保留这一层：业务卡的值/状态/副行是函数式口径（m.value(s)/m.status(s)/m.sub(s)），
//   收敛只换渲染组件、不重写口径。此文件只做形状转换，取数/文案/字段名/路由一字未改。
//   业务调用点（[dim] / OverviewParts；总览由 OverviewParts 承载）与 MetricCard 薄封装都走这里，避免各写一遍。
import type { KpiCardProps } from "@/components/ui";
import type { MetricSpec } from "./types";
import { STATUS_META } from "./ui";

export function businessKpiProps(m: MetricSpec, s: any): KpiCardProps {
  const st = m.status(s);
  return {
    variant: "business",
    metricKey: m.key,
    label: m.label,
    value: m.value(s),
    sub: m.sub ? m.sub(s) : undefined,
    // chip 文案沿用业务 STATUS_META（达标/关注/未达标/无数据/参考），色档沿用同一 status。
    // 与原 Pill 的兜底一致：未知 status 落 info，不抛错。
    status: { label: (STATUS_META[st] || STATUS_META.info).label, tone: st },
    threshold: m.threshold,
    caliber: m.caliber,
    source: m.source,
    owner: m.owner,
    note: m.note,
    verify: m.verify,
    href: m.href,
  };
}
