"use client";
// 概览首页 · 最近任务 + 最近飞轮事件 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
//
// 2026-11-04（ord-20261104-032）：内联 style 清零 —— 5 处内联样式对象换成 page.module.css 的类；
//   任务范围的动态色改走 data-scope 属性选择器（取值与 config/taskScopes 同源）。取数与文案未动。
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import DataTable from "@/components/common/DataTable";
import { scopeDef, scopeOfType } from "@/config/taskScopes";
import { relTime, truncate } from "@/lib/format";
import { EVENT_LABEL, STATUS_TAG } from "./constants";
import styles from "../page.module.css";

export default function OverviewRecentPanels({ data, loadingCards }: { data: any; loadingCards: boolean }) {
  const tasks = data?.tasks;

  return (
    <div className="card-grid cols-2">
      <PanelCard title="最近任务" extra={<a href="/flywheel/tasks" className="tiny">全部改进任务 →</a>}>
        <DataTable
          rowKey="id"
          dataSource={tasks?.recent ?? []}
          locale={{ emptyText: <StateBlock loading={loadingCards} title="窗口内没有任务记录" rows={2} /> }}
          columns={[
            {
              title: "任务",
              dataIndex: "title",
              render: (v: string, row: any) => (
                <Tooltip title={v}>
                  <span className={styles.rcName}>
                    {(() => {
                      const sd = scopeDef(row.scope || scopeOfType(row.improvementType));
                      return <span className={styles.rcScope} data-scope={sd.key}>{sd.short}</span>;
                    })()}
                    {truncate(v, 40)}
                  </span>
                </Tooltip>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 76,
              render: (v: string) => <Tag color={STATUS_TAG[v]?.color || "default"}>{STATUS_TAG[v]?.label || v}</Tag>,
            },
            { title: t('overview.col.agent'), dataIndex: "assignedAgent", width: 120, render: (v: string) => v || <span className="tiny">未分配</span> },
            { title: "更新时间", dataIndex: "updatedAt", width: 92, render: (v: number) => <span className="tiny">{relTime(v)}</span> },
          ]}
        />
      </PanelCard>

      <PanelCard title="最近飞轮事件" extra={<a href="/flywheel/flow" className="tiny">运行流程图 →</a>}>
        {(data?.recentEvents ?? []).length === 0 ? (
          <StateBlock loading={loadingCards} title="窗口内没有事件" rows={3} />
        ) : (
          <div className={styles.rcList}>
            {(data?.recentEvents ?? []).slice(0, 10).map((e: any, i: number) => (
              <div key={i} className={styles.rcRow}>
                <Pill tone={e.targetStage === "OK" ? "ok" : "crit"}>{EVENT_LABEL[e.stage] || e.stage}</Pill>
                <span className="tiny">{e.sourceType}</span>
                <span className={"truncate " + styles.rcTitle}>{truncate(e.sourceTitle, 40)}</span>
                <span className="tiny nowrap">{relTime(e.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </PanelCard>
    </div>
  );
}
