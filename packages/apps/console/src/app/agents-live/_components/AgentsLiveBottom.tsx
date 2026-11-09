"use client";
// agents-live 页 · 最近执行流水 + 判定规则 + 数据来源 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";
import DataTable from "@/components/common/DataTable";
import { PanelCard } from "@/components/ui";
import { fmtNum, relTime } from "@/lib/format";
import { STATUS_TAG } from "./constants";
// 2026-11-05 P2 批9（呈现层）：内联 style 清零 → 同名 CSS Module；列/文案/取数未动；
//   本文件表格仍是既有的 @/components/common/DataTable（E1 例外，未新增引用）。
import styles from "./AgentsLiveBottom.module.css";

export default function AgentsLiveBottom({ data, loadingAll, s }: { data: any; loadingAll: boolean; s: any }) {
  return (
    <>
      {/* ---------- 最近执行流水 ---------- */}
      <div className="card-grid cols-2">
        <PanelCard
          title="最近执行流水"
          extra={
            <Tooltip title={t('agentsLive.selfReport.tip')}>
              <span className="tiny">{t('agentsLive.execNote')}</span>
            </Tooltip>
          }
        >
          <DataTable
            rowKey={(r: any) => r.taskId + r.at}
            loading={loadingAll}
            dataSource={data?.recent ?? []}
            emptyTitle="窗口内没有执行记录"
            emptyRows={2}
            columns={[
              { title: t('agentsLive.col.agent'), dataIndex: "agentId", width: 130, render: (v: string) => <span className={styles.cellBase}>{v || "-"}</span> },
              {
                title: "任务",
                dataIndex: "taskTitle",
                render: (v: string) => <Tooltip title={v}><span className={styles.cellBase}>{(v || "-").slice(0, 40)}</span></Tooltip>,
              },
              {
                title: "结果",
                dataIndex: "status",
                width: 88,
                render: (v: string, row: any) => (
                  <Tag color={row.qualityPassed ? "success" : STATUS_TAG[v]?.color || "default"}>
                    {STATUS_TAG[v]?.label || v}
                  </Tag>
                ),
              },
              {
                title: t('agentsLive.col.selfReport'),
                key: "tokens",
                width: 130,
                render: (_: any, row: any) => {
                  // 2026-09-10: 优先显示"本次任务"的自报用量 (事件 sourceId = taskId), 没有则显示该 agent 近窗口累加
                  const usage = data?.agents?.find((a: any) => a.agentId === row.agentId)?.tokenUsage;
                  const taskTokens = usage?.byTask?.[row.taskId] || 0;
                  const agentTokens = usage?.tokens || 0;
                  if (!taskTokens && !agentTokens) return <span className="tiny">—</span>;
                  return (
                    <Tooltip
                      title={`${row.agentId} 窗口内自报累计 ${fmtNum(agentTokens)} 词元${taskTokens ? `（本任务 ${fmtNum(taskTokens)}）` : ""}`}
                    >
                      <span className={"mono " + styles.monoBase}>
                        {taskTokens ? fmtNum(taskTokens) : fmtNum(agentTokens)}
                        <span className={"tiny " + styles.tagGap}>{taskTokens ? "本任务" : "窗口累计"}</span>
                      </span>
                    </Tooltip>
                  );
                },
              },
              { title: "时间", dataIndex: "at", width: 96, render: (v: number) => <span className="tiny nowrap">{relTime(v)}</span> },
            ]}
          />
        </PanelCard>

        <PanelCard title={t('agentsLive.rules.title')} extra={<span className="tiny">{t('agentsLive.rules.transparent')}</span>}>
          <div className={styles.rules}>
            <div>· {t('agentsLive.rules.online')}</div>
            <div>· {t('agentsLive.rules.running')}</div>
            <div>· {t('agentsLive.rules.stuck')}</div>
            <div>· {t('agentsLive.rules.quality')}</div>
            <div>· {t('agentsLive.rules.exec')}</div>
            <div>· <b>在办</b>：{s.stateRules?.busy || "有进行中任务"} —— 被派单但未开始不算。</div>
            <div>· <b>卡住</b>：{s.stateRules?.stuck || "在办任务 30 分钟无更新"}。</div>
            <div>· <b>离线</b>：{s.stateRules?.offline || "通信服务离线且名册非活跃"}。</div>
            <div>· <b>执行体</b>：{s.stateRules?.executor || "有工具、无常驻执行进程，不判在线 / 离线"}。</div>
            <div>· {t('agentsLive.rules.twoScopes', { types: s.taskScope?.types?.join(" + ") || "" })}</div>
            <div className={"tiny " + styles.tightTop}>{t('agentsLive.rules.goto')}</div>
            <div className={"tiny " + styles.tightTopLoose}>
              {t('agentsLive.rules.note')}
            </div>
          </div>
        </PanelCard>
      </div>

      <div className={"tiny " + styles.footRight}>
        {t('agentsLive.source')}{" "}
        {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
      </div>
    </>
  );
}
