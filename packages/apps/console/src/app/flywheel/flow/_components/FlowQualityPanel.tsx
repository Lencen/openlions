"use client";
// flywheel/flow 页 · 24h 产出质量面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批6（B/飞轮业务）：内联 style 清零（8 → 0）+ 裸表格标签清零（1 → 0）。
//   六列表格 -> 白名单 @/components/DataTable：列与表头逐条对应（产物类型 / 24h 产出 / 未打分 /
//   均分(有分) / 高质 ≥0.7 / 低质 <0.4），右对齐改用 columns.align；
//   单元格的动态色改为 [data-tone] 属性选择器；复制按钮仍在表前，DataTable 不转发 ref，
//   故沿用 TableCopyButton 的自动定位模式（取其后第一张表）。
//   取数（d.quality）、字段名与文案未动。
import type { FlowData } from "./types";
import { t } from "@/i18n";
import { entityLabel } from "@/config/artifactTypes";
import { fmtN } from "./format";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./FlowQualityPanel.module.css";

/** 一行 = [产物类型, 质量计数] */
type QualityRow = [string, FlowData["quality"][string]];

export default function FlowQualityPanel({ d }: { d: FlowData | null }) {
  const rows = Object.entries(d?.quality ?? {}) as QualityRow[];
  const columns: DataColumn<QualityRow>[] = [
    { key: "name", title: "产物类型", render: ([name]) => <strong>{entityLabel(name)}</strong> },
    { key: "n", title: "24h 产出", align: "right", render: ([, v]) => fmtN(v?.n) },
    {
      key: "unscored", title: "未打分", align: "right",
      render: ([, v]) => <span className={styles.tone} data-tone={(v?.unscored ?? 0) > 0 ? "crit" : "dim"}>{fmtN(v?.unscored)}</span>,
    },
    {
      key: "avgQ", title: "均分(有分)", align: "right",
      render: ([, v]) => (
        <span className={styles.avg + " " + styles.tone}
          data-tone={(v?.avgQ ?? 0) >= 0.7 ? "ok" : (v?.avgQ ?? 0) >= 0.4 ? "text" : "crit"}>
          {v?.avgQ ?? "—"}
        </span>
      ),
    },
    {
      key: "highQ", title: "高质 ≥0.7", align: "right",
      render: ([, v]) => <span className={styles.tone} data-tone="ok">{fmtN(v?.highQ)}</span>,
    },
    {
      key: "lowQ", title: "低质 <0.4", align: "right",
      render: ([, v]) => <span className={styles.tone} data-tone={(v?.lowQ ?? 0) > 0 ? "crit" : "dim"}>{fmtN(v?.lowQ)}</span>,
    },
  ];

  return (
    <div className={"panel " + styles.wrap}>
      <div className="panel-header"><span className="panel-title">24h 产出质量</span></div>
      <TableCopyButton />
      <DataTable columns={columns} rows={rows} rowKey={([name]) => name} empty={{ title: "无数据" }} />
      <div className={styles.foot}>
        <span>{t('biz.resolver.decision24h')} {(d?.resolver || []).map((r) => r.action + " " + r.c).join(" · ") || "—"}</span>
        <span>主题反思 24h: {(d?.reflectStatus || []).map((r) => r.status + " " + r.c).join(" · ") || "—"}</span>
        <span>错误 24h: {(d?.errToday || []).map((r) => r.errorType + " " + r.c).join(" · ") || "无"}</span>
      </div>
    </div>
  );
}
