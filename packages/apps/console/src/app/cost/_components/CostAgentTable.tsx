"use client";
// cost 页 · 按智能体聚合表 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 呈现层（批8）：内联 style 清零。
//   展开区字号/行高、告警色、任务链接左间距、智能体 ID 字号下沉到 CostAgentTable.module.css；
//   估算 token 列「有值/无值」两态改用 data-est 属性选择器。
//   可展开表沿用 @/components/common/DataTable（本文件原本就用它，未新增 E1 例外），列定义与取数未动。
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import DataTable from "@/components/common/DataTable";
import { PanelCard, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum, fmtTokens, relTime } from "@/lib/format";
import styles from "./CostAgentTable.module.css";

export default function CostAgentTable({ data, byAgent, loadingAll }: { data: any; byAgent: any[]; loadingAll: boolean }) {
  const s = data?.summary ?? {};
  return (
    <PanelCard
      title={t("cost.byAgentTable.title")}
      tone="var(--status-ok)"
      extra={<span className="tiny">{t("cost.byAgentTable.extra")}</span>}
    >
      {loadingAll ? <StateBlock loading rows={3} /> : byAgent.length === 0 ? (
        <StateBlock
          title={t("cost.byAgentTable.empty")}
          desc={<span className="tiny">{t("cost.byAgentTable.explain")}</span>}
          rows={2}
        />
      ) : (
        <DataTable
          rowKey="agentId"
          dataSource={byAgent}
          expandable={{
            expandedRowRender: (row: any) => (
              <div className={styles.expandBody}>
                <div>
                  模型分布(实测)：{row.models.length ? row.models.map((m: any) => `${m.model} ${fmtTokens(m.tokens)}`).join(" · ") : "-"}
                </div>
                {(row.estimatedModels || []).length ? (
                  <div className={styles.warnText}>
                    模型分布(估算, 未并入)：{row.estimatedModels.map((m: any) => `${m.model} ${fmtTokens(m.tokens)}`).join(" · ")}
                  </div>
                ) : null}
                <div>
                  涉及任务 {fmtNum(row.taskCount)} 个：
                  {row.tasks.slice(0, 6).map((t: any) => (
                    <a key={t.taskId} href={`/flywheel/tasks/${t.taskId}`} className={styles.taskLink}>
                      {String(t.taskId).slice(0, 10)}… {fmtTokens(t.tokens)}
                    </a>
                  ))}
                </div>
                {(row.estimatedTasks || []).length ? (
                  <div className={"tiny " + styles.warnText}>
                    估算任务 {row.estimatedTasks.length} 个（未并入）：
                    {row.estimatedTasks.slice(0, 4).map((t: any) => (
                      <a key={t.taskId} href={`/flywheel/tasks/${t.taskId}`} className={styles.taskLink}>
                        {String(t.taskId).slice(0, 10)}… {fmtTokens(t.tokens)}
                      </a>
                    ))}
                  </div>
                ) : null}
                <div className="tiny">首次上报 {row.firstAt ? relTime(row.firstAt) : "-"} · 最近 {row.lastAt ? relTime(row.lastAt) : "-"}</div>
              </div>
            ),
          }}
          columns={[
            { title: t("cost.col.agent"), dataIndex: "agentId", render: (v: string) => <a href={`/agents/detail?agentId=${v}`} className={styles.agentLink}>{v}</a> },
            { title: "上报次数", dataIndex: "calls", width: 84, render: (v: number) => <span className="mono">{fmtNum(v)}</span> },
            { title: t("cost.col.measured"), dataIndex: "totalTokens", width: 104, render: (v: number) => <b className="mono">{fmtTokens(v)}</b> },
            {
              title: <Tooltip title={t("cost.col.estimated.tip")}><span>{t("cost.col.estimated.short")}</span></Tooltip>,
              dataIndex: "estimatedTokens",
              width: 104,
              render: (v: number, row: any) => (
                <Tooltip title={row.combinedTokens ? `参考合计(实测+估算): ${fmtTokens(row.combinedTokens)}` : undefined}>
                  <span className={"mono " + styles.estCell} data-est={v > 0}>{v > 0 ? fmtTokens(v) : "—"}</span>
                </Tooltip>
              ),
            },
            {
              title: "占总量(实测)",
              dataIndex: "totalTokens",
              width: 96,
              key: "share",
              render: (v: number) => <span className="mono tiny">{s.totalTokens ? ((v / s.totalTokens) * 100).toFixed(2) + "%" : "-"}</span>,
            },
            { title: "主要模型", dataIndex: "primaryModel", width: 130, render: (v: string) => <span className="tiny">{v || "-"}</span> },
            { title: "单次均", dataIndex: "avgTokensPerCall", width: 84, render: (v: number) => <span className="mono tiny">{v ? fmtTokens(v) : "-"}</span> },
            { title: "任务数", dataIndex: "taskCount", width: 72, render: (v: number) => <span className="mono">{fmtNum(v)}</span> },
            { title: "最近上报", dataIndex: "lastAt", width: 90, render: (v: number) => <span className="tiny nowrap">{v ? relTime(v) : "-"}</span> },
          ]}
        />
      )}
    </PanelCard>
  );
}
