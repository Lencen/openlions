"use client";
// 任务详情页 · 关联产物表 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批12 呈现层：3 处内联 style 下沉到 ./TaskProductsPanel.module.css；
//   产物类型色 PRODUCT_COLOR -> data-table 属性选择器，质量分 qualityTone().color -> data-tone。
//   表格仍是既有的 E1 例外 @/components/common/DataTable（本文件原本就在用它，未新增引用）。
//   列/字段、取数、跳转、文案未动。
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard, StateBlock } from "@/components/ui";
import DataTable from "@/components/common/DataTable";
import { fmtScore, qualityTone, relTime, truncate } from "@/lib/format";
import { PRODUCT_LABEL, PRODUCT_LINK } from "./constants";
import styles from "./TaskProductsPanel.module.css";

export default function TaskProductsPanel({ data }: { data: any }) {
  return (
    <PanelCard title="关联产物（认知表 sourceId = 本任务）" extra={<span className="tiny">这条任务产出了什么认知</span>}>
      <DataTable
        rowKey={(r: any) => r.table + r.id}
        dataSource={data?.products ?? []}
        locale={{ emptyText: <StateBlock title="没有直接落库的认知产物（结论型任务产出在执行记录里）" rows={2} /> }}
        columns={[
          {
            title: "类型",
            dataIndex: "table",
            width: 76,
            render: (v: string) => <span className={styles.prodType} data-table={v}>{PRODUCT_LABEL[v] || v}</span>,
          },
          {
            title: "产物",
            dataIndex: "title",
            render: (v: string, row: any) => (
              <Tooltip title={v}>
                <a href={(PRODUCT_LINK[row.table] || "#") + row.id} className={styles.prodLink}>{truncate(v, 60)}</a>
              </Tooltip>
            ),
          },
          {
            title: "质量",
            dataIndex: "qualityScore",
            width: 70,
            render: (v: number) => <span className={"mono " + styles.qualityNum} data-tone={qualityTone(v).cls}>{v ? fmtScore(v) : "-"}</span>,
          },
          { title: "验证", dataIndex: "verification", width: 110, render: (v: string, row: any) => (v ? <Tag>{v}</Tag> : <span className="tiny">{row.stale ? "已过期" : "未验证"}</span>) },
          { title: "创建", dataIndex: "createdAt", width: 84, render: (v: number) => <span className="tiny nowrap">{relTime(v)}</span> },
        ]}
      />
    </PanelCard>
  );
}
