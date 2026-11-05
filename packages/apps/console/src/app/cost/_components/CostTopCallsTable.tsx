"use client";
// cost 页 · Top 单次调用表 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 呈现层改造：三处内联样式改为 page.module.css 的类（.entryCell/.entryName/.tokens）。
//   词元「估算 vs 实测」的颜色改由 data-estimated 属性选择器表达；取数/字段/列一行未改。
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import DataTable from "@/components/common/DataTable";
import { PanelCard, Pill } from "@/components/ui";
import { t } from "@/i18n";
import { fmtTime, fmtTokens } from "@/lib/format";
import styles from "../page.module.css";

export default function CostTopCallsTable({ data, loadingAll }: { data: any; loadingAll: boolean }) {
  return (
    <PanelCard title={t("cost.top.title")} extra={<span className="tiny">{t("cost.top.extra")}</span>}>
      <DataTable
        rowKey={(r: any) => String(r.at) + r.entry}
        loading={loadingAll}
        dataSource={data?.topCalls ?? []}
        emptyTitle={t("cost.top.empty")}
        columns={[
          {
            title: "入口 / 主体",
            dataIndex: "entry",
            width: 160,
            render: (v: string, row: any) => (
              <span className={styles.entryCell}>
                <Pill tone={row.kind === "agent" ? "info" : "mute"}>{row.kind === "agent" ? t("common.agent") : "平台"}</Pill>
                <span className={styles.entryName}>{row.kind === "agent" ? row.agentId : v}</span>
              </span>
            ),
          },
          {
            title: t("cost.col.tokens"),
            dataIndex: "tokens",
            width: 104,
            render: (v: number, row: any) => (
              <b className={"mono " + styles.tokens} data-estimated={row.estimated ? "true" : "false"}>{fmtTokens(v)}</b>
            ),
          },
          {
            title: t("cost.caliber"),
            dataIndex: "estimated",
            width: 76,
            render: (v: boolean) => (
              <Tooltip title={v ? t("cost.caliber.tipEstimated") : t("cost.caliber.tipMeasured")}>
                <span><Pill tone={v ? "warn" : "mute"}>{v ? t("cost.caliber.estimated") : t("cost.caliber.measured")}</Pill></span>
              </Tooltip>
            ),
          },
          { title: "耗时", dataIndex: "durationMs", width: 80, render: (v: number) => <span className="mono tiny">{(v / 1000).toFixed(1)}s</span> },
          { title: "结果", dataIndex: "ok", width: 70, render: (v: boolean) => <Tag color={v ? "success" : "error"}>{v ? "成功" : "失败"}</Tag> },
          { title: "时间", dataIndex: "at", width: 150, render: (v: number) => <span className="tiny">{fmtTime(v)}</span> },
        ]}
      />
    </PanelCard>
  );
}
