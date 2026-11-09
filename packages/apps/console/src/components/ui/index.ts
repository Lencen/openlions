"use client";
/**
 * 组件白名单（ord-20261104-025）
 * ---------------------------------------------------------------------------
 * 规则：console 页面只允许从这里导入基础件。
 *   · 新增白名单项 = 改这个文件 + 在 WHITELIST.md 写清理由，评审通过才合并；
 *   · 非白名单组件（页面里自写的 page-header / <table> / 手搓 KPI）在 P2 判据里报红。
 * 说明：老的 '@/components/ui' 仍然可用（本文件就是它），导出面与迁移前一致。
 */
// 2026-11-05（ord-027 裁决 A）：指标卡收口到 KpiCard 一套 —— KpiCard 是唯一实现（超集），
//   MetricCard 只是 deprecated 再导出别名，导出面再保留一个发布周期（判据 scripts/check-kpi-convergence.cjs）。
/** @deprecated 用 KpiCard（同一实现）。两者都在这里导出，旧调用点无需改 import 也能继续工作。 */
export { MetricCard, StateBlock, ErrorBlock, PanelCard, PageHero, Pill } from "./primitives";
export { default as KpiCard } from "../KPICard";
export type { Props as KpiCardProps } from "../KPICard";
export { default as DataTable, StateChip } from "../DataTable";
export type { DataColumn, DataTableProps } from "../DataTable";
export { PageHeader, PageTitle } from "./PageHeader";
export { default as FilterBar } from "./FilterBar";
export type { FilterItem, FilterBarProps } from "./FilterBar";
