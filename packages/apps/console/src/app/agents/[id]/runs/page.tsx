// 0.5.1 B4-9 /agents/[id]/runs · Bento 运行记录（2026-11-15）
// SLOT-MAP（B4 §4）：s12 页头 → s12 运行列表（时间/运行ID/状态/耗时/结果）→ s12 分页 → s12 相关视图。
// 数据：/api/session-list?page=&pageSize=&agent_id=（真实会话档案，字段用 task 侧无接口，故如实标注 n/a+原因）。
// 只读；四态：loading（loading.tsx）/ empty「无运行记录」/ error（端点+状态码+重试）/ unavailable（分块 n/a）。
import type { ReactNode } from "react";
import Link from "next/link";
import AgentShell from "../_components/AgentShell";
import { B4Card, B4Grid, B4Kv, B4PageHead, B4State } from "../_components/B4";
import { EXEC_STATUS_LABEL, fmtDuration, fmtTime, loadAgent, loadLive, loadSessions } from "../_data";
import { Alert } from "@/components/primitives";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import s from "../_components/b4.module.css";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "待提炼",
  DONE: "已提炼",
  PROCESSED: "已提炼",
  SKIPPED: "已跳过",
  FAILED: "失败",
};

function statusBadge(raw?: string | null): ReactNode {
  const st = String(raw || "").toUpperCase();
  const cls = st === "FAILED" ? "badge badge-red"
    : st === "PENDING" ? "badge badge-yellow"
    : st === "DONE" || st === "PROCESSED" ? "badge badge-green"
    : st === "SKIPPED" ? "badge"
    : "badge badge-blue";
  return <span className={cls}>{STATUS_LABEL[st] || (st || "n/a")}</span>;
}

type RunRow = { time: ReactNode; runId: ReactNode; status: ReactNode; duration: ReactNode; result: ReactNode };
const RUN_COLUMNS: DataColumn<RunRow>[] = [
  { key: "time", title: "时间", width: 150 },
  { key: "runId", title: "运行编号" },
  { key: "status", title: "状态", width: 90 },
  { key: "duration", title: "耗时", width: 130 },
  { key: "result", title: "结果（消息数 / 失败原因）" },
];

export default async function AgentRunsPage({
  params, searchParams,
}: { params: { id: string }; searchParams?: { page?: string } }) {
  const id = decodeURIComponent(params.id || "");
  const rawPage = Number(searchParams?.page || 1);
  let page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const [agentLoad, liveS, sessionsS] = await Promise.all([
    loadAgent(id), loadLive(id, "24h"), loadSessions(id, page, PAGE_SIZE),
  ]);
  const agent = agentLoad.agent;
  const live = liveS.data;
  let sess = sessionsS.data;
  const asOf = sessionsS.asOf || liveS.asOf || agentLoad.asOf || null;
  const totalPages = Math.max(1, Math.ceil(sess.total / Math.max(1, sess.limit || PAGE_SIZE)));
  if (page > totalPages) {
    const fixed = await loadSessions(id, totalPages, PAGE_SIZE);
    if (fixed.ok) sess = fixed.data;
    page = totalPages;
  }
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push(`实时状态 /api/agents-live（HTTP ${liveS.status ?? "连接失败"}）`);
  if (!sessionsS.ok) degraded.push(`会话档案 /api/session-list（HTTP ${sessionsS.status ?? "连接失败"}）`);

  const head = <B4PageHead id={id} page="运行" title="智能体详情 · 运行" subtitle="该智能体的运行（会话档案）记录与分页" agent={agent} live={live} asOf={asOf} />;
  const fallback = (phase: "empty" | "error", title: string, detail: ReactNode, retry?: string) => (
    <div className="layout-with-sidebar"><main className="main">
      {head}
      <B4Grid><B4Card span={12} state={phase === "error" ? "unavailable" : "ok"}><B4State phase={phase} title={title} detail={detail} retryHref={retry} /></B4Card></B4Grid>
    </main></div>
  );
  if (!id) return fallback("empty", "缺少对象标识", "本页需要智能体 id（/agents/{id}/runs）；请从智能体列表进入。", "/agents");
  if (!agentLoad.ok) {
    return fallback("error", "名册接口取数失败", `端点 /api/agent-list 返回 ${agentLoad.status ?? "连接失败"}；这不等于「没有这个智能体」，请稍后重试。`, `/agents/${encodeURIComponent(id)}/runs`);
  }
  if (!agent && !live) return fallback("empty", "未找到该智能体", `名册里查不到 ${id}；可能 id 有误或该智能体已下线。`, "/agents");

  const base = `/agents/${encodeURIComponent(agent?.agent_id || id)}/runs`;
  const rows: RunRow[] = sess.items.map((r) => {
    const st = String(r.status || "").toUpperCase();
    const start = r.started_at ? Date.parse(r.started_at) : NaN;
    const end = r.ended_at ? Date.parse(r.ended_at) : NaN;
    const dur = Number.isFinite(start) && Number.isFinite(end) ? fmtDuration(end - start) : "";
    return {
      time: <span className={s.sm}>{fmtTime(r.started_at || r.last_message_at || r.updated_at)}</span>,
      runId: <span className={s.mono + " " + s.sm}>{String(r.session_uid || "").split(":").slice(-1)[0]}</span>,
      status: statusBadge(st),
      duration: dur ? <span className={s.sm}>{dur}</span> : <span className={s.dim + " " + s.sm} title="会话未结束或接口未下发 ended_at">n/a（未结束/无 ended_at）</span>,
      result: st === "FAILED"
        ? <span className={s.dim + " " + s.sm}>{r.processing_error || "失败（接口未下发失败原因）"}</span>
        : <span className={s.dim + " " + s.sm}>{r.message_count != null ? `${r.message_count} 条消息` : "n/a（接口未下发消息数）"}</span>,
    };
  });
  // R2（B4-FIELDS §13）：最近执行时间取 lastExecution.completedAt（不是 execStats.lastAt——
  // 后者在 execStats=null 时会显示 "-"，与真实的 2026-11-11 COMPLETED 自相矛盾）。
  const lastExec = live?.lastExecution ?? null;
  const prevHref = page > 1 ? `${base}?page=${page - 1}` : "";
  const nextHref = page < totalPages ? `${base}?page=${page + 1}` : "";

  return (
    <AgentShell id={id} active="runs" agent={agent} live={live} header={head}>
      {degraded.length ? <Alert type="warning" showIcon className={s.alertRow} title="部分数据源降级" description={degraded.join("；")} /> : null}

      <B4Grid>
        <B4Card
          span={12}
          title="运行列表"
          sub={`会话档案口径 · 共 ${sess.total.toLocaleString()} 条 · 每页 ${PAGE_SIZE} 条 · 第 ${page}/${totalPages} 页`}
          state={sessionsS.ok ? "ok" : "unavailable"}
          actions={<span className={s.dim + " " + s.sm}>只读</span>}
        >
          {!sessionsS.ok ? (
            <B4State
              phase="unavailable"
              title="运行列表不可得"
              detail={`端点 /api/session-list 返回 ${sessionsS.status ?? "连接失败"}；分块 n/a，页面其余信息可用。`}
              retryHref={base}
            />
          ) : (
            <div className={s.tableWrap}>
              <DataTable columns={RUN_COLUMNS} rows={rows} empty={{ title: "无运行记录", desc: "该智能体在 /api/session-list 下没有可展示的会话档案。", action: <Link href="/agents" className={s.link}>返回智能体列表</Link> }} />
            </div>
          )}
        </B4Card>

        <B4Card
          span={12}
          title="最近执行"
          sub="来源：接口「最近一次执行」字段（不用窗口聚合的最近时间，避免空值横线与真实执行矛盾）"
          state={liveS.ok ? "ok" : "unavailable"}
        >
          {!liveS.ok ? (
            <B4State phase="unavailable" title="最近执行不可得" detail={`端点 /api/agents-live 返回 ${liveS.status ?? "连接失败"}；本分块 n/a。`} retryHref={base} />
          ) : lastExec ? (
            <B4Kv items={[
              { label: "最近执行任务", value: lastExec.taskTitle || lastExec.id || "n/a（接口未下发任务标题）" },
              { label: "执行状态", value: EXEC_STATUS_LABEL[String(lastExec.status || "").toUpperCase()] || lastExec.status || "n/a" },
              { label: "质量通过", value: lastExec.qualityPassed ? "是" : "否" },
              { label: "完成时间", value: fmtTime(lastExec.completedAt), mono: true },
              { label: "窗口执行聚合", value: live?.execStats ? "有（窗口统计见概览）" : "n/a（窗口内无执行聚合；不用它当最近执行时间）" },
            ]} />
          ) : (
            <B4State phase="empty" title="无最近执行记录" detail="lastExecution 为 null（接口有返回、值确实为空）。" />
          )}
        </B4Card>

        <B4Card span={12} title="分页">
          {sess.total === 0 ? (
            <div className={s.emptyNote}>共 0 条运行记录，无分页。</div>
          ) : (
            <div className={s.pager}>
              <a className={s.link} href={prevHref || undefined} aria-disabled={prevHref ? "false" : "true"}>← 上一页</a>
              <span className={s.pageInfo}>第 {page} / {totalPages} 页</span>
              <a className={s.link} href={nextHref || undefined} aria-disabled={nextHref ? "false" : "true"}>下一页 →</a>
              <span className={s.dim}>共 {sess.total.toLocaleString()} 条（来源 /api/session-list，limit={sess.limit}，offset={sess.offset}）</span>
              {!nextHref ? <span className={s.dim}>已到最后一页</span> : null}
            </div>
          )}
        </B4Card>

        <B4Card span={12} title="相关视图">
          <div className={s.related}>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/overview`} className={s.link}>概览 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/versions`} className={s.link}>版本/变更 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/config`} className={s.link}>配置（只读） →</Link>
            <Link href="/agents" className={s.link}>全部智能体 →</Link>
          </div>
        </B4Card>
      </B4Grid>
    </AgentShell>
  );
}