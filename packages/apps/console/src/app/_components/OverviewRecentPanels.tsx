"use client";
// 概览首页 · 最近任务 + 最近飞轮事件 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import DataTable from "@/components/common/DataTable";
import { scopeDef, scopeOfType } from "@/config/taskScopes";
import { relTime, truncate } from "@/lib/format";
import { EVENT_LABEL, STATUS_TAG } from "./constants";

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
                  <span style={{ fontSize: "var(--fs-base)" }}>
                    {(() => {
                      const sd = scopeDef(row.scope || scopeOfType(row.improvementType));
                      return <span style={{ color: sd.color, fontWeight: 600, marginRight: "var(--sp-1-5)" }}>{sd.short}</span>;
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
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            {(data?.recentEvents ?? []).slice(0, 10).map((e: any, i: number) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--fs-base)", borderBottom: "1px solid var(--border)", paddingBottom: "var(--sp-1-5)" }}>
                <Pill tone={e.targetStage === "OK" ? "ok" : "crit"}>{EVENT_LABEL[e.stage] || e.stage}</Pill>
                <span className="tiny">{e.sourceType}</span>
                <span className="truncate" style={{ flex: 1, color: "var(--text-dim)" }}>{truncate(e.sourceTitle, 40)}</span>
                <span className="tiny nowrap">{relTime(e.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </PanelCard>
    </div>
  );
}
