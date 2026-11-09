"use client";
// 2026-11-05 P2 批6（B/飞轮业务）：内联 style 清零（9 → 0）+ 裸表格标签清零（1 → 0）。
//   · Pill 的按状态配色改由 [data-status] 属性选择器承载（STATUS_META 仍导出且标签仍从它取，形状未改）；
//   · Panel 的 style 入参沿用上一批 DataMoment 的先例保留在类型里但不再消费（@deprecated），
//     以免打断既有调用点（本仓库当前无调用点传 style）；
//   · SimpleTable 内部的裸表格标签（class="tbl"）换成白名单 @/components/DataTable：
//     表头逐项 ↔ 列标题、每行逐项 ↔ 同下标单元格，即列与数据一条不少；
//     head/rows/empty/testId 四个 props 的形状与空态文案一字未改。
import type { ReactNode } from "react";
import type { Status } from "./types";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./ui.module.css";

export const STATUS_META: Record<Status, { label: string; color: string; bg: string }> = {
  ok: { label: "达标", color: "var(--status-ok)", bg: "color-mix(in srgb, var(--status-ok) 12%, transparent)" },
  warn: { label: "关注", color: "var(--status-warn)", bg: "color-mix(in srgb, var(--status-warn) 14%, transparent)" },
  crit: { label: "未达标", color: "var(--status-crit)", bg: "color-mix(in srgb, var(--status-crit) 14%, transparent)" },
  nodata: { label: "无数据", color: "var(--text-muted)", bg: "color-mix(in srgb, var(--text-muted) 12%, transparent)" },
  info: { label: "参考", color: "var(--info)", bg: "color-mix(in srgb, var(--info) 12%, transparent)" },
};

export function Pill({ status, children }: { status: Status; children?: ReactNode }) {
  const m = STATUS_META[status] || STATUS_META.info;
  return (
    <span className={"badge " + styles.pill} data-status={status}>
      {children || m.label}
    </span>
  );
}

export function Panel({ title, extra, children, testId }: {
  title?: ReactNode; extra?: ReactNode; children: ReactNode; testId?: string;
  /** @deprecated 2026-11-05 P2 批6：内联样式清零后本件不再消费 style（传了不生效）；
   *  需要额外样式请包一层用类控制。保留该属性只为不打断既有调用点。 */
  style?: React.CSSProperties;
}) {
  return (
    <section className="panel" data-testid={testId}>
      {title || extra ? (
        <div className={"panel-header " + styles.panelHead}>
          <span className="panel-title">{title}</span>
          {extra ? <span className="tiny">{extra}</span> : null}
        </div>
      ) : null}
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "crit" }) {
  return <div className={"tiny " + styles.note} data-tone={tone}>{children}</div>;
}

export function SimpleTable({ head, rows, empty = "无数据", testId }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string; testId?: string }) {
  if (!rows.length) return <div className={"tiny " + styles.emptyNote}>{empty}</div>;
  // DataTable 的 title 声明为 string，但实际渲染进 <th>{title}</th>；本组调用点的 head 全是字符串，原样透传。
  const columns: DataColumn<ReactNode[]>[] = head.map((h, i) => ({
    key: "c" + i,
    title: h as unknown as string,
    render: (r) => r[i],
  }));
  return (
    <div data-testid={testId}>
      <DataTable columns={columns} rows={rows} rowKey={(_r, i) => i} />
    </div>
  );
}

export function MetricLine({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className={styles.metricLine}>
      <span className="tiny">{label}</span>
      <span className={styles.metricValue}>{value}{hint ? <span className="tiny"> {hint}</span> : null}</span>
    </div>
  );
}
