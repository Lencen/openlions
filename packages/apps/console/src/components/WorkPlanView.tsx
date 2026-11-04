"use client";
// 2026-09-11 用户反馈: 活跃看板"数据不对, 且看不出工作安排"。
// 本视图回答: 队列里有什么 / 谁在办什么 / 为什么某些 agent 没活 / 生成器状态。
import { Button, Skeleton, Table, Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { t, bizText } from "@/i18n";
import { MetricCard, PanelCard, Pill, StateBlock } from "@/components/ui";
import { fmtNum, relTime } from "@/lib/format";
import { scopeDef, scopeOfType } from "@/config/taskScopes";

const TYPE_LABEL: Record<string, string> = {
  GOAL_GAP: "机制修复",
  THEME_IMPROVE: "反思衍生",
  PLATFORM_REVIEW: "平台复审",
  VERIFY_AGENT_OUTPUT: t('workplan.type.verify'),
  DISCUSSION_QUESTION: "对话/问答",
  BRIDGE: "自动桥接",
  "(未分类)": "未分类",
};

const IDLE_TONE: Record<string, string> = {
  has_work: "ok",
  waiting: "info",
  queue_empty: "warn",
  capability_guard: "crit",
  not_integrated: "mute",
  executor_identity: "info",
  stale_in_progress: "crit",
  // 2026-09-11 新增: 僵尸消费者(认领不产出)与人类账号
  zombie_consumer: "crit",
  human_owner: "mute",
};
const IDLE_LABEL: Record<string, string> = {
  has_work: "在办",
  waiting: "等待认领",
  queue_empty: "队列空",
  capability_guard: "能力守卫拦截",
  not_integrated: "未接入",
  executor_identity: "执行体(需唤醒)",
  stale_in_progress: "在办超时",
  zombie_consumer: "僵尸消费者",
  human_owner: "人类账号",
};

const LIVENESS_TONE: Record<string, string> = { consuming: "ok", executor: "info", quiet: "warn", unhealthy: "crit", human: "mute", offline: "mute" };
const LIVENESS_LABEL: Record<string, string> = { consuming: "在消费", executor: "执行体", quiet: "静默(>24h)", unhealthy: "僵尸", human: "人", offline: "离线" };

function TypeBars({ items, color = "var(--primary)" }: { items: { type: string; count: number }[]; color?: string }) {
  const max = Math.max(...items.map((i) => i.count), 1);
  if (!items.length) return <span className="tiny">无</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
      {items.map((it) => (
        <div key={it.type} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--fs-base)" }}>
          <span style={{ width: 130, color: scopeDef(scopeOfType(it.type)).color, fontWeight: 600 }}>
            {TYPE_LABEL[it.type] || it.type}
          </span>
          <div className="mini-bar" style={{ flex: 1, height: 8 }}>
            <div className="mini-bar-fill" style={{ width: `${(it.count / max) * 100}%`, background: color }} />
          </div>
          <span className="mono nowrap" style={{ width: 44, textAlign: "right" }}>{fmtNum(it.count)}</span>
        </div>
      ))}
    </div>
  );
}

export default function WorkPlanView() {
  const { data, loading, error, mutate } = useApi<any>("/api/work-plan");

  if (error) {
    return <StateBlock title="工作安排加载失败" desc={String(error?.message || "")} onRetry={mutate} />;
  }
  const loadingAll = loading && !data;
  const q = data?.queues;
  const gen = data?.generator;
  const rules = data?.stateRules;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", marginBottom: "var(--sp-3)", flexWrap: "wrap" }}>
        <span className="tiny">
          {t('workplan.source', { hours: data?.windowHours || 24 })}
        </span>
        <Button size="small" icon={<ReloadOutlined />} onClick={mutate} loading={loading} style={{ marginLeft: "auto" }}>刷新</Button>
      </div>

      <div className="metric-row">
        <MetricCard
          label={t('workplan.claimable.label')}
          tone={(q?.claimable?.count || 0) > 0 ? "info" : "mute"}
          value={loadingAll ? "…" : fmtNum(q?.claimable?.count)}
          unit="条"
          hint={<Tooltip title={bizText(q?.claimable?.definition)}><span>PENDING · 无负责人 · 非 [机制修复]</span></Tooltip>}
          footer={
            <span className="tiny">
              claim 路由可返回 {fmtNum(q?.claimable?.routeEligible?.count || 0)} 条 · 最老 {q?.claimable?.samples?.[0] ? relTime(q.claimable.samples[0].createdAt) : "-"}
            </span>
          }
        />
        <MetricCard
          label="执行体专属队列"
          tone="warn"
          value={loadingAll ? "…" : fmtNum(q?.executorOnly?.count)}
          unit="条"
          hint={<Tooltip title={bizText(q?.executorOnly?.definition)}><span>[机制修复]/[落地] 前缀或已派给执行体</span></Tooltip>}
          footer={
            <span className="tiny">
              已定向派单 {fmtNum(q?.executorOnly?.assignedToExecutor || 0)} · 待执行体认领 {fmtNum(q?.executorOnly?.awaitingExecutorClaim || 0)}
            </span>
          }
        />
        <MetricCard
          label="进行中"
          tone="info"
          value={loadingAll ? "…" : fmtNum(q?.inProgress?.count)}
          unit="条"
          hint={t('workplan.inProgress.hint', { n: fmtNum(q?.inProgress?.byAgent?.length || 0) })}
          footer={
            <Tooltip title={bizText(q?.assignedPending?.definition)}>
              <span className="tiny">已派单待开始 {fmtNum(q?.assignedPending?.count || 0)} 条（另列, 不算在办）</span>
            </Tooltip>
          }
        />
        <MetricCard
          label={`${q?.doneSince?.windowLabel || "近 24 小时"}完成`}
          tone="ok"
          value={loadingAll ? "…" : fmtNum(q?.doneSince?.total)}
          unit="条"
          hint="全部任务类型"
          footer={
            <span className="tiny">
              {t('workplan.done.breakdown', { a: fmtNum(q?.doneSince?.byScope?.MECHANISM), b: fmtNum(q?.doneSince?.byScope?.VERIFY), c: fmtNum(q?.doneSince?.byScope?.DISCUSSION) })}
            </span>
          }
        />
        <MetricCard
          label={t('workplan.verify.label')}
          tone="info"
          value={loadingAll ? "…" : fmtNum(q?.doneSince?.byScope?.VERIFY)}
          unit="条"
          hint="VERIFY_AGENT_OUTPUT"
          footer={<span className="tiny">{t('biz.workplan.verify.footer', { window: q?.doneSince?.windowLabel || "近 24 小时" })}</span>}
        />
        <MetricCard
          label={`${q?.failedSince?.windowLabel || "近 24 小时"}失败`}
          tone={(q?.failedSince?.total || 0) > 0 ? "crit" : "mute"}
          value={loadingAll ? "…" : fmtNum(q?.failedSince?.total)}
          unit="条"
          hint={q?.failedSince?.byType?.map((x: any) => (TYPE_LABEL[x.type] || x.type) + " " + x.count).join(" · ") || "无失败"}
        />
      </div>

      <div className="card-grid cols-2">
        <PanelCard
          title="队列分布"
          extra={
            <Tooltip title={bizText(q?.invariants?.rule)}>
              <span className="tiny">
                {q?.invariants?.ok ? "🟢 队列互斥校验通过" : "⚠ 队列互斥校验失败"}
              </span>
            </Tooltip>
          }
        >
          {loadingAll ? <Skeleton active paragraph={{ rows: 4 }} /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              <div>
                <div className="tiny" style={{ marginBottom: "var(--sp-1)" }}>
                  <b>可认领 {fmtNum(q?.claimable?.count)}</b>（{bizText(q?.claimable?.definition)}）· claim 路由可返回 {fmtNum(q?.claimable?.routeEligible?.count || 0)} 条
                </div>
                <TypeBars items={q?.claimable?.byType || []} color="var(--primary)" />
                {(q?.claimable?.samples || []).length ? (
                  <div style={{ marginTop: "var(--sp-2)" }}>
                    {(q.claimable.samples || []).slice(0, 5).map((t: any) => (
                      <div key={t.id} className="tiny" style={{ display: "flex", gap: "var(--sp-2)" }}>
                        <span className="mono">{t.priority}</span>
                        <a href={`/flywheel/tasks/${t.id}`} className="truncate" style={{ maxWidth: 420 }}>{t.title}</a>
                        <span className="nowrap">{t.ageMin} 分钟前</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-2)" }}>
                <div className="tiny" style={{ marginBottom: "var(--sp-1)" }}>
                  <b>执行体专属 {fmtNum(q?.executorOnly?.count)}</b>（{bizText(q?.executorOnly?.definition)}）
                  <span style={{ marginLeft: "var(--sp-2)" }}>· 已定向派单 {fmtNum(q?.executorOnly?.assignedToExecutor || 0)} · 待认领 {fmtNum(q?.executorOnly?.awaitingExecutorClaim || 0)}</span>
                </div>
                <TypeBars items={q?.executorOnly?.byType || []} color="var(--status-warn)" />
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-2)" }}>
                <div className="tiny" style={{ marginBottom: "var(--sp-1)" }}>
                  <b>已派单待开始 {fmtNum(q?.assignedPending?.count)}</b>（{bizText(q?.assignedPending?.definition)}）
                </div>
                {(q?.assignedPending?.samples || []).slice(0, 4).map((t: any) => (
                  <div key={t.id} className="tiny" style={{ display: "flex", gap: "var(--sp-2)" }}>
                    <span className="mono">{t.priority}</span>
                    <a href={`/flywheel/tasks/${t.id}`} className="truncate" style={{ maxWidth: 360 }}>{t.title}</a>
                    <span className="nowrap">→ {t.assignedAgent}</span>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-2)" }}>
                <div className="tiny" style={{ marginBottom: "var(--sp-1)" }}>
                  <b>{q?.doneSince?.windowLabel || "近 24 小时"}完成 {fmtNum(q?.doneSince?.total)}</b>（按 improvementType · {q?.doneSince?.basis}）
                </div>
                <TypeBars items={(q?.doneSince?.byType || []).map((x: any) => ({ type: x.type, count: x.count }))} color="var(--status-ok)" />
                <div className="tiny" style={{ marginTop: "var(--sp-1)" }}>
                  {q?.failedSince?.windowLabel || "近 24 小时"}失败 {fmtNum(q?.failedSince?.total)} 条
                  {q?.failedSince?.byType?.length ? `（${q.failedSince.byType.map((x: any) => (TYPE_LABEL[x.type] || x.type) + " " + x.count).join(" · ")}）` : ""}
                </div>
              </div>
              <div className="tiny" style={{ borderTop: "1px dashed var(--border)", paddingTop: "var(--sp-2)", color: "var(--text-muted)" }}>
                互斥校验：{bizText(q?.invariants?.rule)} → {q?.invariants?.ok ? "通过 🟢" : "失败 ⚠ " + JSON.stringify(q?.invariants)}
              </div>
            </div>
          )}
        </PanelCard>

        <PanelCard title="生成器状态" tone="var(--module-builtin)" extra={<span className="tiny">{gen?.script}</span>}>
          {loadingAll ? <Skeleton active paragraph={{ rows: 4 }} /> : (
            <div style={{ fontSize: "var(--fs-base)", lineHeight: 2 }}>
              <div>
                <b>最近一轮</b>：{gen?.last ? relTime(gen.last.at) : "无记录"}
                {gen?.last ? <span className="tiny"> · 新建 {fmtNum(gen.last.created)} 条</span> : null}
              </div>
              {gen?.last ? (
                <div className="tiny">
                  候选 claim {fmtNum(gen.last.candidatesClaims)} · 24h 失败任务 {fmtNum(gen.last.failedTask)} · 提炼错误 {fmtNum(gen.last.extractError)}
                  <div className="mono" style={{ color: "var(--text-muted)" }}>{gen.last.raw}</div>
                </div>
              ) : null}
              <div>
                <b>下次生成</b>：{gen?.nextRunAt ? new Date(gen.nextRunAt).toLocaleString("zh-CN", { hour12: false }) : "-"}
                <span className="tiny">
                  {" "}{t('workplan.generator.cron', { n: fmtNum(gen?.nextRunInMin), cron: gen?.cron, m: gen?.everyMinutes })}
                </span>
              </div>
              <div>
                <b>窗口内</b>：{t('workplan.generated', { n: fmtNum(gen?.runsSince), m: fmtNum(gen?.createdSince) })}
              </div>
              <div className="tiny" style={{ color: "var(--text-muted)", lineHeight: 1.7 }}>{gen?.note}</div>
            </div>
          )}
        </PanelCard>
      </div>

      <PanelCard
        title="谁在办什么 / 为什么没活"
        extra={<span className="tiny">在办 = IN_PROGRESS/PROCESSING；被派单未开始单列</span>}
      >
        {loadingAll ? <Skeleton active paragraph={{ rows: 6 }} /> : (
          <Table
            size="small"
            rowKey="agentId"
            pagination={false}
            dataSource={data?.agents || []}
            columns={[
              {
                title: t('workplan.col.agent'),
                dataIndex: "agentId",
                width: 210,
                render: (v: string, row: any) => (
                  <div>
                    <div style={{ fontSize: "var(--fs-base)", fontWeight: 600 }}>{row.displayName}</div>
                    <div className="tiny mono">{v}</div>
                    <div style={{ marginTop: "var(--sp-1)" }}>
                      <Pill tone={row.role === "executor" ? "warn" : row.role === "assignee-only" || row.role === "human" ? "mute" : "info"}>{row.roleLabel}</Pill>
                      {/* 2026-09-11: 活性细化(consuming/quiet/unhealthy/human/executor) —— 旧的 online 布尔看不出"在线但不产出" */}
                      {row.liveness && row.liveness !== "agent" && (
                        <span style={{ marginLeft: "var(--sp-1)" }} title={row.livenessText}>
                          <Pill tone={LIVENESS_TONE[row.liveness] || "mute"}>{LIVENESS_LABEL[row.liveness] || row.liveness}</Pill>
                        </span>
                      )}
                    </div>
                  </div>
                ),
              },
              {
                title: "在办任务",
                dataIndex: "currentTasks",
                render: (v: any[], row: any) =>
                  v?.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
                      {v.map((t: any) => (
                        <div key={t.id} style={{ fontSize: "var(--fs-base)" }}>
                          <span className="mono" style={{ color: scopeDef(t.scope).color, fontWeight: 600, marginRight: "var(--sp-1)" }}>{t.priority}</span>
                          <a href={`/flywheel/tasks/${t.id}`}>{String(t.title).slice(0, 56)}</a>
                          <span className="tiny" style={{ marginLeft: "var(--sp-2)" }}>
                            {relTime(t.updatedAt)}开始 · {t.idleMin} 分钟未更新{t.idleMin > 30 ? " ⚠ 超时" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : row.assignedPendingCount ? (
                    <span className="tiny">已派单待开始 {fmtNum(row.assignedPendingCount)} 条（未开始, 不算在办）</span>
                  ) : (
                    <span className="tiny">—</span>
                  ),
              },
              {
                title: "近 24h 完成",
                dataIndex: "doneSince",
                width: 190,
                render: (v: number, row: any) => (
                  <span style={{ fontSize: "var(--fs-base)" }}>
                    <b className="mono">{fmtNum(v)}</b>
                    <span className="tiny" style={{ marginLeft: "var(--sp-2)" }}>
                      {["MECHANISM", "VERIFY", "DISCUSSION", "OTHER"]
                        .filter((k) => (row.doneByScope || {})[k])
                        .map((k) => `${scopeDef(k).short} ${row.doneByScope[k]}`)
                        .join(" · ") || "—"}
                    </span>
                  </span>
                ),
              },
              {
                title: "最近提交",
                dataIndex: "lastSubmitAt",
                width: 130,
                render: (v: number, row: any) => (
                  <Tooltip title={row.lastSubmitEverAt ? `历史上最近一次提交: ${relTime(row.lastSubmitEverAt)}` : "没有提交记录"}>
                    <span className="tiny nowrap">{v ? relTime(v) : "窗口内无提交"}</span>
                  </Tooltip>
                ),
              },
              {
                title: "空闲原因",
                dataIndex: "idleReason",
                render: (v: string, row: any) => (
                  <Tooltip title={row.idleReasonText}>
                    <span>
                      <Pill tone={IDLE_TONE[v] || "mute"}>{IDLE_LABEL[v] || v || "-"}</Pill>
                      <span className="tiny" style={{ marginLeft: "var(--sp-2)" }}>{String(row.idleReasonText || "").slice(0, 70)}</span>
                    </span>
                  </Tooltip>
                ),
              },
            ]}
          />
        )}
      </PanelCard>

      <PanelCard title="判定规则（为什么这么算）" tone="var(--text-muted)">
        <div style={{ fontSize: "var(--fs-base)", lineHeight: 2, color: "var(--text-dim)" }}>
          <div>· <b>在办</b>：{bizText(rules?.busy)}</div>
          <div>· <b>空闲</b>：{bizText(rules?.idle)}</div>
          <div>· <b>卡住</b>：{bizText(rules?.stuck)}</div>
          <div>· <b>离线</b>：{bizText(rules?.offline)}</div>
          <div>· <b>执行体</b>：{bizText(rules?.executor)}</div>
          <div>· <b>完成数口径</b>：{bizText(rules?.counts)}</div>
          <div style={{ marginTop: "var(--sp-2)", paddingTop: "var(--sp-2)", borderTop: "1px dashed var(--border)" }}>
            <b>三个队列的定义（互斥关系已断言）</b>
          </div>
          <div>· <b>可认领</b>：{bizText(q?.claimable?.definition)}。认领路由还会额外要求人工复核!=true 且（反思衍生 或 类型白名单），该子集当前 {fmtNum(q?.claimable?.routeEligible?.count || 0)} 条。</div>
          <div>· <b>执行体专属</b>：{bizText(q?.executorOnly?.definition)}</div>
          <div>· <b>已派单待开始</b>：{bizText(q?.assignedPending?.definition)}；{q?.assignedPending?.note}</div>
          <div>· <b>互斥断言</b>：{bizText(q?.invariants?.rule)} —— {q?.invariants?.ok ? "当前成立 🟢" : `不成立 ⚠ 可认领∩执行体专属=${JSON.stringify(q?.invariants?.claimable_x_executorOnly)} 可认领∩已派单待开始=${JSON.stringify(q?.invariants?.claimable_x_assignedPending)}`}</div>
          <div className="tiny" style={{ marginTop: "var(--sp-1)" }}>
            能力守卫名单：{data?.capability?.toolCapableAgents?.join(", ") || "-"}（来源 {data?.capability?.source || "-"}，与认知服务认领路由同源）
          </div>
        </div>
      </PanelCard>
    </div>
  );
}
