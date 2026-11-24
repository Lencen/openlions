// 0.5.1 B4-8 /agents/[id]/overview · Bento 概览（2026-11-15）
// SLOT-MAP（B4-BENTO-DESIGN-2026-11-15.md §4）：s12 页头 → KPI 4×s3（运行数/成功率/平均耗时/最近活动）
//   → s8 最近运行 + s4 配置摘要 → s12 当前任务 → s12 相关视图。
// 取数：/api/agent-list（名册）+ /api/agents-live?range=30d（执行统计/最近执行）+ /api/session-list（最近运行=会话档案）。
// 缺字段一律 n/a+原因（不写 0 冒充）；服务端组件，四态由取数结果分支给出；只读。
import type { ReactNode } from "react";
import Link from "next/link";
import AgentShell from "../_components/AgentShell";
import { B4Card, B4Grid, B4Kpi, B4Kv, B4PageHead, B4State } from "../_components/B4";
import { EXEC_STATUS_LABEL, TIER_LABELS, fmtAgo, fmtTime, loadAgent, loadLive, loadSessions, parseJson } from "../_data";
import { Alert } from "@/components/primitives";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import s from "../_components/b4.module.css";

export const dynamic = "force-dynamic";

const RANGE = "30d" as const;

type RunRow = { time: ReactNode; runId: ReactNode; status: ReactNode; result: ReactNode };
const RUN_COLUMNS: DataColumn<RunRow>[] = [
  { key: "time", title: "时间", width: 150 },
  { key: "runId", title: "运行编号" },
  { key: "status", title: "状态", width: 90 },
  { key: "result", title: "结果" },
];

export default async function AgentOverviewPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS, sessionsS] = await Promise.all([
    loadAgent(id), loadLive(id, RANGE), loadSessions(id, 1, 5),
  ]);
  const agent = agentLoad.agent;
  const live = liveS.data;
  const profile = parseJson(agent?.profile);
  const perms = agent?.permissions ?? [];
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const quota = parseJson(profile.quota);
  // R2（B4-FIELDS §13）：execStats=null 表示窗口内无执行统计，**不得用 ??0 兜成 0**；
  // 页面区分「无数据(n/a)」与「0」：null -> n/a+原因，有对象才显示数字。
  const exec = live?.execStats ?? null;
  const execN = exec?.n;
  const completed = exec?.completed;
  const passed = exec?.passed;
  const hasRate = typeof completed === "number" && completed > 0;
  const current = live?.currentTask ?? agent?.currentTask ?? null;
  const pending = live?.assignedPending ?? [];
  const recent = sessionsS.data.items;
  const asOf = liveS.asOf || agentLoad.asOf || null;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push(`实时状态 /api/agents-live（HTTP ${liveS.status ?? "连接失败"}）`);
  if (!sessionsS.ok) degraded.push(`会话档案 /api/session-list（HTTP ${sessionsS.status ?? "连接失败"}）`);

  const head = <B4PageHead id={id} page="概览" title="智能体详情 · 概览" subtitle="档案、执行统计、最近运行与配置摘要" agent={agent} live={live} asOf={asOf} />;
  const fallback = (phase: "empty" | "error", title: string, detail: ReactNode, retry?: string) => (
    <div className="layout-with-sidebar"><main className="main">
      {head}
      <B4Grid><B4Card span={12} state={phase === "error" ? "unavailable" : "ok"}><B4State phase={phase} title={title} detail={detail} retryHref={retry} /></B4Card></B4Grid>
    </main></div>
  );
  if (!id) return fallback("empty", "缺少对象标识", "本页需要智能体 id（/agents/{id}/overview）；请从智能体列表进入。", "/agents");
  if (!agentLoad.ok) {
    return fallback("error", "名册接口取数失败", `端点 /api/agent-list 返回 ${agentLoad.status ?? "连接失败"}；这不等于「没有这个智能体」，请稍后重试。`, `/agents/${encodeURIComponent(id)}/overview`);
  }
  if (!agent && !live) return fallback("empty", "未找到该智能体", `名册里查不到 ${id}；可能 id 有误或该智能体已下线。`, "/agents");

  const runRows: RunRow[] = recent.map((r) => {
    const st = String(r.status || "").toUpperCase();
    return {
      time: <span className={s.sm}>{fmtTime(r.last_message_at || r.updated_at || r.started_at)}</span>,
      runId: <span className={s.mono + " " + s.sm}>{String(r.session_uid || "").split(":").slice(-1)[0]}</span>,
      status: <span className="badge badge-blue">{st || "n/a"}</span>,
      result: <span className={s.dim + " " + s.sm}>{r.message_count != null ? `${r.message_count} 条消息` : "n/a（接口未下发消息数）"}</span>,
    };
  });
  const lastExec = live?.lastExecution ?? null;

  return (
    <AgentShell id={id} active="overview" agent={agent} live={live} header={head}>
      {degraded.length ? <Alert type="warning" showIcon className={s.alertRow} title="部分数据源降级" description={degraded.join("；")} /> : null}

      <B4Grid>
        <B4Kpi
          label="运行数（近 30 天）"
          value={typeof execN === "number" ? execN.toLocaleString() : undefined}
          hint={liveS.ok && typeof execN === "number" ? `执行记录口径：任务执行表；统计窗口：近 30 天` : undefined}
          na={!liveS.ok
            ? `实时状态源 /api/agents-live 取数失败（HTTP ${liveS.status ?? "连接失败"}）`
            : exec == null ? `接口未返回执行聚合（近 30 天窗口内无执行记录），按 n/a 呈现、不写 0` : undefined}
        />
        <B4Kpi
          label="成功率（质量通过）"
          value={hasRate ? `${Math.round((passed / completed) * 100)}%` : undefined}
          hint={hasRate ? `${passed.toLocaleString()} / ${completed.toLocaleString()} 条质量通过；统计窗口：近 30 天` : undefined}
          na={!liveS.ok
            ? `实时状态源 /api/agents-live 取数失败（HTTP ${liveS.status ?? "连接失败"}）`
            : !hasRate ? "窗口内无已完成执行（completed=0），成功率无分母，不能记 0" : undefined}
        />
        <B4Kpi
          label="平均耗时"
          na={!liveS.ok
            ? `实时状态源 /api/agents-live 取数失败（HTTP ${liveS.status ?? "连接失败"}）`
            : "接口未下发执行耗时字段（执行表未暴露开始时间），无法计算"}
        />
        <B4Kpi
          label="最近活动"
          value={live?.lastSeenAt ? fmtAgo(live.lastSeenAt) : undefined}
          hint={live?.lastSeenAt ? fmtTime(live.lastSeenAt) : undefined}
          na={!liveS.ok
            ? `实时状态源 /api/agents-live 取数失败（HTTP ${liveS.status ?? "连接失败"}）`
            : !live?.lastSeenAt ? "接口未返回 lastSeenAt（名册 last_seen_at 也为空）" : undefined}
        />

        <B4Card
          span={8}
          title="最近运行"
          sub="最近执行（/api/agents-live）与最近 5 条会话档案（/api/session-list）"
          actions={<Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/runs`} className={s.link}>全部运行 →</Link>}
          state={sessionsS.ok ? "ok" : "unavailable"}
        >
          {!sessionsS.ok ? (
            <B4State phase="unavailable" title="会话档案不可得" detail={`端点 /api/session-list 返回 ${sessionsS.status ?? "连接失败"}；最近运行列表暂不可渲染。`} retryHref={`/agents/${encodeURIComponent(id)}/overview`} />
          ) : (
            <>
              {lastExec ? (
                <B4Kv items={[
                  { label: "最近执行任务", value: lastExec.taskTitle || lastExec.id || "n/a（接口未下发任务标题）" },
                  { label: "执行状态", value: EXEC_STATUS_LABEL[String(lastExec.status || "").toUpperCase()] || lastExec.status || "n/a" },
                  { label: "质量通过", value: lastExec.qualityPassed ? "是" : "否" },
                  { label: "完成时间", value: fmtTime(lastExec.completedAt), mono: true },
                ]} />
              ) : <div className={s.emptyNote}>最近执行：n/a（窗口内无执行记录）</div>}
              <div className={s.tableWrap}>
                <DataTable columns={RUN_COLUMNS} rows={runRows} empty={{ title: "无最近运行记录（会话档案为空）" }} />
              </div>
            </>
          )}
        </B4Card>

        <B4Card span={4} title="配置摘要" sub="来自名册画像 profile（只读）" state={Object.keys(profile).length ? "ok" : "unavailable"}>
          {Object.keys(profile).length ? (
            <B4Kv items={[
              { label: "能力分级", value: tier != null ? TIER_LABELS[tier] : "n/a（画像未登记 capabilityTier）" },
              { label: "模型", value: profile.model || "n/a（画像未下发）" },
              { label: "运行方式", value: profile.driver || "n/a（画像未下发）" },
              { label: "负责人", value: profile.owner || "n/a（画像未下发）" },
              { label: "每日上限", value: quota.dailyLimit != null ? String(quota.dailyLimit) : "n/a（画像未下发 quota）" },
              { label: "配额模式", value: quota.mode || "n/a（画像未下发）" },
              { label: "服务授权", value: `有效授权 ${perms.filter((p: any) => p.status === "ACTIVE").length} 个 / 历史撤销 ${perms.filter((p: any) => p.status === "REVOKED").length} 个（详见配置页）` },
            ]} />
          ) : (
            <B4State phase="unavailable" title="画像为空" detail="名册 /api/agent-list 的 profile 为空（该智能体未登记画像），配置摘要无字段可渲染。" />
          )}
          <div className={s.note}>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/config`} className={s.link}>配置详情（只读） →</Link>
          </div>
        </B4Card>

        <B4Card span={12} title="当前任务与待开始" sub="来自 /api/agents-live 的 currentTask / assignedPending" state={liveS.ok ? "ok" : "unavailable"}>
          {!liveS.ok ? (
            <B4State phase="unavailable" title="在办数据不可得" detail={`端点 /api/agents-live 返回 ${liveS.status ?? "连接失败"}；当前任务/待开始任务暂不可渲染。`} />
          ) : (
            <>
              {current ? (
                <B4Kv items={[
                  { label: "当前任务", value: current.title || current.id },
                  { label: "状态", value: current.status || "n/a" },
                  { label: "优先级", value: current.priority || "n/a（接口未下发）" },
                  { label: "静默时长", value: current.idleMin != null ? `${current.idleMin} 分钟` : "n/a（接口未下发）" },
                ]} />
              ) : <div className={s.emptyNote}>当前无在办任务（接口返回 currentTask=null）。</div>}
              <div className={s.tableWrap}>
                <DataTable
                  columns={[
                    { key: "title", title: "待开始任务" },
                    { key: "priority", title: "优先级", width: 90 },
                    { key: "type", title: "改进类型", width: 130 },
                  ]}
                  rows={pending.slice(0, 10).map((r: any) => ({
                    title: r.title || r.id,
                    priority: r.priority || "-",
                    type: r.improvementType || "-",
                  }))}
                  empty={{ title: "没有待开始任务" }}
                />
              </div>
            </>
          )}
        </B4Card>

        <B4Card span={12} title="相关视图">
          <div className={s.related}>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/runs`} className={s.link}>运行记录 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/versions`} className={s.link}>版本/变更 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/config`} className={s.link}>配置（只读） →</Link>
            <Link href={`/agents/detail?id=${encodeURIComponent(agent?.agent_id || id)}`} className={s.link}>详情入口 →</Link>
            <Link href="/agents" className={s.link}>全部智能体 →</Link>
          </div>
        </B4Card>
      </B4Grid>
    </AgentShell>
  );
}
