"use client";
// lineage 页 · 落库构成 / 验证状态 / 智能体产出入库 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import DataTable from "@/components/common/DataTable";
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum, fmtScore } from "@/lib/format";
import { TABLE_COLOR, TABLE_LABEL } from "./lineageShared";

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
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            {(["Memory", "Knowledge", "Practice", "Skill"] as const).map((t) => {
              const b = byTable[t] || { n: 0, avg: 0, unscored: 0, total: 0 };
              const maxN = Math.max(...(["Memory", "Knowledge", "Practice", "Skill"] as const).map((x) => byTable[x]?.n || 0), 1);
              return (
                <div key={t}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-base)", marginBottom: "var(--sp-0-5)" }}>
                    <span style={{ color: TABLE_COLOR[t], fontWeight: 600 }}>{TABLE_LABEL[t]}</span>
                    <span className="mono">{fmtNum(b.n)} <span className="tiny">/ 累计 {fmtNum(b.total)}</span></span>
                  </div>
                  <div className="mini-bar" style={{ width: "100%", height: 8 }}>
                    <div className="mini-bar-fill" style={{ width: `${(b.n / maxN) * 100}%`, background: TABLE_COLOR[t] }} />
                  </div>
                  <div className="tiny" style={{ marginTop: "var(--sp-0-5)" }}>平均质量 {fmtScore(b.avg)} · 未评分 {fmtNum(b.unscored)}</div>
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      <PanelCard title="知识验证状态" tone="var(--status-ok)" extra={<span className="tiny">全量口径</span>}>
        {loadingAll ? <StateBlock loading rows={3} /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2-5)", fontSize: "var(--fs-base)" }}>
            {[
              { k: "verified", label: "已验证/提案接受", tone: "ok" },
              { k: "pending", label: "待人工复核", tone: "warn" },
              { k: "rejected", label: "已驳回", tone: "crit" },
              { k: "humanConfirmed", label: "人工确认", tone: "info" },
              { k: "unverified", label: "未进入验证流程", tone: "mute" },
            ].map((row) => (
              <div key={row.k} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
                <Pill tone={row.tone}>{row.label}</Pill>
                <span className="mono" style={{ marginLeft: "auto" }}>{fmtNum(data?.verification?.[row.k])}</span>
              </div>
            ))}
            <div className="tiny" style={{ lineHeight: 1.7, marginTop: "var(--sp-1)" }}>
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
              { title: t('lineage.col.agent'), dataIndex: "agentId", render: (v: string) => <span style={{ fontSize: "var(--fs-base)" }}>{v}</span> },
              { title: "提交", dataIndex: "n", width: 60, render: (v: number) => <span className="mono">{fmtNum(v)}</span> },
              { title: "平均质量", dataIndex: "avgQuality", width: 84, render: (v: number) => <span className="mono">{v === null ? "-" : fmtScore(v)}</span> },
            ]}
          />
        )}
      </PanelCard>
    </div>
  );
}
