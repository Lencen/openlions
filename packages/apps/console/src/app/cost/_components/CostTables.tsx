"use client";
// cost 页 · 明细表 (调用入口明细 + 未计量调用), 从 page.tsx 抽出 (2026-09-14 页面瘦身)
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import DataTable from "@/components/common/DataTable";
import { PanelCard, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum, fmtPct, fmtTokens, relTime } from "@/lib/format";
import styles from "./CostTables.module.css";

// 2026-11-05 P2 批8：内联 style 清零 —— 入口名字号、成功率/估算令牌的动态色、间距全部下沉 CostTables.module.css。
export default function CostTables({ data, byEntry, loadingAll }: { data: any; byEntry: any[]; loadingAll: boolean }) {
  return (
    <div className="card-grid cols-2">
      <PanelCard title="调用入口明细" extra={<span className="tiny">窗口内</span>}>
        <DataTable
          rowKey="entry"
          loading={loadingAll}
          dataSource={byEntry}
          emptyTitle="窗口内没有调用记录"
          columns={[
            { title: "入口", dataIndex: "entry", render: (v: string, row: any) => (
              <div>
                {/* 2026-11-05 P2 批8：入口名字号/字重下沉到 module.css */}
                <div className={styles.entryName}>{v}</div>
                <div className="tiny">{row.model}</div>
              </div>
            ) },
            { title: "调用", dataIndex: "calls", width: 62, render: (v: number) => <span className="mono">{fmtNum(v)}</span> },
            { title: "成功", dataIndex: "successRate", width: 66, render: (v: number) => <span className={"mono " + styles.rate} data-ok={v >= 0.95}>{fmtPct(v, 0)}</span> },
            {
              title: <Tooltip title={t("cost.col.measured.tip")}><span>{t("cost.col.measured")}</span></Tooltip>,
              dataIndex: "tokens",
              width: 96,
              render: (v: number) => <span className="mono">{fmtTokens(v)}</span>,
            },
            {
              title: <Tooltip title={t("cost.col.estimated.tip")}><span>{t("cost.col.estimated.short")}</span></Tooltip>,
              dataIndex: "estimatedTokens",
              width: 104,
              render: (v: number, row: any) => (
                <span className={"mono " + styles.estimated} data-on={v > 0}>
                  {v > 0 ? fmtTokens(v) : "—"}
                  {row.unmeasured ? <span className={"tiny " + styles.unmeasuredNote}>{t("cost.extraUnmeasured", { n: fmtNum(row.unmeasured) })}</span> : null}
                </span>
              ),
            },
            { title: "单次均", dataIndex: "avgTokensPerCall", width: 80, render: (v: number) => <span className="mono tiny">{v ? fmtTokens(v) : "-"}</span> },
            { title: "平均耗时", dataIndex: "avgMs", width: 82, render: (v: number) => <span className="mono tiny">{(v / 1000).toFixed(1)}s</span> },
            { title: "最近", dataIndex: "lastAt", width: 78, render: (v: number) => <span className="tiny nowrap">{relTime(v)}</span> },
          ]}
        />
      </PanelCard>

      <PanelCard title={t("cost.unmeasured.table")} tone="var(--status-warn)" extra={<span className="tiny">{t("cost.unmeasured.onlyChars")}</span>}>
        {loadingAll ? <StateBlock loading rows={3} /> : (data?.unmeasured ?? []).length === 0 ? (
          <StateBlock title={t("cost.unmeasured.allMeasured")} rows={2} />
        ) : (
          <DataTable
            rowKey={(r: any) => String(r.at) + r.raw}
            dataSource={data.unmeasured}
            columns={[
              { title: "入口", dataIndex: "entry", width: 130 },
              { title: "原始记录", dataIndex: "raw", render: (v: string) => <span className="mono tiny">{v}</span> },
              { title: "字符数", dataIndex: "chars", width: 80, render: (v: number) => <span className="mono">{v ? fmtNum(v) : "-"}</span> },
              { title: "时间", dataIndex: "at", width: 84, render: (v: number) => <span className="tiny nowrap">{relTime(v)}</span> },
            ]}
          />
        )}
        <div className={"tiny " + styles.desc}>
          {t("cost.unmeasured.desc")}
        </div>
      </PanelCard>
    </div>
  );
}
