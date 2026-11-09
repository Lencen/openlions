"use client";
// lineage 页 · 落库构成 / 验证状态 / 智能体产出入库 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批6：内联 style 清零（样式下沉 LineageCompositionPanels.module.css）；
//   产物类型配色走 data-table 属性选择器，构成条宽度走 5% 档位类；取数/字段/文案未动。
import DataTable from "@/components/common/DataTable";
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum, fmtScore } from "@/lib/format";
import { TABLE_LABEL } from "./lineageShared";
import styles from "./LineageCompositionPanels.module.css";

/** 占比 -> 5% 档位类（0/5/…/100），与 DataTable 骨架宽度同口径 */
function pctClass(pct: number): string {
  // 非有限值（数据缺失）不套档位类，保持改前「宽度声明失效 -> 由浏览器自适应」的行为
  if (!Number.isFinite(pct)) return "";
  const step = Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
  return styles["p" + step] || "";
}

export default function LineageCompositionPanels({
  data,
  byTable,
  consumption,
  loadingAll,
}: {
  data: any;
  byTable: Record<string, any>;
  consumption: any;
  loadingAll: boolean;
}) {
  return (
    <div className="card-grid cols-3">
      <PanelCard title="产物落库构成" extra={<span className="tiny">窗口内</span>}>
        {loadingAll ? <StateBlock loading rows={3} /> : (
          <div className={styles.stack}>
            {(["Memory", "Knowledge", "Practice", "Skill"] as const).map((t) => {
              const b = byTable[t] || { n: 0, avg: 0, unscored: 0, total: 0 };
              const maxN = Math.max(...(["Memory", "Knowledge", "Practice", "Skill"] as const).map((x) => byTable[x]?.n || 0), 1);
              return (
                <div key={t}>
                  <div className={styles.compHead}>
                    <span className={styles.compLabel} data-table={t}>{TABLE_LABEL[t]}</span>
                    <span className="mono">{fmtNum(b.n)} <span className="tiny">/ 累计 {fmtNum(b.total)}</span></span>
                  </div>
                  <div className={"mini-bar " + styles.barTrack}>
                    <div className={"mini-bar-fill " + styles.barFill + " " + pctClass((b.n / maxN) * 100)} data-table={t} />
                  </div>
                  <div className={"tiny " + styles.mt0_5}>平均质量 {fmtScore(b.avg)} · 未评分 {fmtNum(b.unscored)}</div>
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      <PanelCard title="知识验证状态" tone="var(--status-ok)" extra={<span className="tiny">全量口径</span>}>
        {loadingAll ? <StateBlock loading rows={3} /> : (
          <div className={styles.verifyStack}>
            {[
              { k: "verified", label: "已验证/提案接受", tone: "ok" },
              { k: "pending", label: "待人工复核", tone: "warn" },
              { k: "rejected", label: "已驳回", tone: "crit" },
              { k: "humanConfirmed", label: "人工确认", tone: "info" },
              { k: "unverified", label: "未进入验证流程", tone: "mute" },
            ].map((row) => (
              <div key={row.k} className={styles.verifyRow}>
                <Pill tone={row.tone}>{row.label}</Pill>
                <span className={"mono " + styles.mlAuto}>{fmtNum(data?.verification?.[row.k])}</span>
              </div>
            ))}
            <div className={"tiny " + styles.note}>
              {t('lineage.verifyNote')}
            </div>
          </div>
        )}
      </PanelCard>

      <PanelCard title={t('lineage.agentOutput.title')} extra={<span className="tiny">智能体产出入库</span>}>
        {loadingAll ? <StateBlock loading rows={3} /> : (consumption?.submissionsByAgent ?? []).length === 0 ? (
          <StateBlock title={t('lineage.agentOutput.empty')} rows={2} />
        ) : (
          <DataTable
            rowKey="agentId"
            dataSource={consumption.submissionsByAgent}
            columns={[
              { title: t('lineage.col.agent'), dataIndex: "agentId", render: (v: string) => <span className={styles.baseText}>{v}</span> },
              { title: "提交", dataIndex: "n", width: 60, render: (v: number) => <span className="mono">{fmtNum(v)}</span> },
              { title: "平均质量", dataIndex: "avgQuality", width: 84, render: (v: number) => <span className="mono">{v === null ? "-" : fmtScore(v)}</span> },
            ]}
          />
        )}
      </PanelCard>
    </div>
  );
}
