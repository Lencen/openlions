"use client";
// 2026-11-05 KPI 收敛 phase2（ord-027 裁决 A）：本件不再自带卡片解剖，改为 KpiCard variant="business" 的薄封装。
//   入参仍是业务口径规格 { m, s }（m.status(s)/m.value(s) 这种函数式），口径逻辑一行没动；
//   卡片 DOM/样式由 components/KPICard.tsx 的 business 档 + KPICard.module.css 承载。
//   当前调用点已直接渲染 KpiCard；保留本文件只是给存量调用点留一个发布周期的回退面（不参与判据使用面）。
import KpiCard from "@/components/KPICard";
import type { MetricSpec } from "./types";
import { businessKpiProps } from "./businessKpi";

export default function MetricCard({ m, s }: { m: MetricSpec; s: any }) {
  return <KpiCard {...businessKpiProps(m, s)} />;
}
