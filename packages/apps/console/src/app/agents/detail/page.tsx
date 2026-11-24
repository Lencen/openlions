// 0.5.1 B4-7 /agents/detail · Bento 智能体详情入口（2026-11-15，只读）
// SLOT-MAP（B4-BENTO-DESIGN-2026-11-15.md §4）：s12 页头 → s4 智能体摘要 + s8 最近活动 → s12 关联入口。
// 入口参数：?agentId= 或 ?id=（沿用历史入口，见 /system/permissions、/sessions、/cost、/agents 的链接）。
// 只读边界（AUDIT-062 P0#3 + B4 §1）：本页不渲染任何写控件；原权限/分级三个 POST 已不在此页发起。
// 数据：/api/agent-list + /api/agents-live?range=30d + /api/session-list（均只读 BFF）。
// 四态：缺参「缺少对象标识」/ 未找到「未找到该智能体」/ error（端点+状态码+重试）/ unavailable（分块 n/a）。
import type { ReactNode } from "react";
import Link from "next/link";
import { B4Card, B4Grid, B4Kv, B4PageHead, B4State } from "../[id]/_components/B4";
import { EXEC_STATUS_LABEL, TIER_LABELS, fmtAgo, fmtTime, loadAgent, loadLive, loadSessions, parseJson } from "../[id]/_data";
import { Alert } from "@/components/primitives";
import s from "../[id]/_components/b4.module.css";

export const dynamic = "force-dynamic";

interface Activity { at: number; title: string; meta: string; tone: "info" | "warn" | "muted" }

export default async function AgentDetailPage({
  searchParams,
}: { searchParams?: { agentId?: string; id?: string } }) {
  const id = String(searchParams?.agentId || searchParams?.id || "").trim();
  const missing = !id;
  const [agentLoad, liveS, sessionsS] = missing
    ? [
        { ok: false, agent: null, asOf: null, status: null, error: null } as any,
        { ok: false, data: null, asOf: null, status: null, error: null } as any,
        { ok: false, data: { items: [], total: 0, limit: 10, offset: 0 }, status: null, error: null } as any,
      ]
    : await Promise.all([loadAgent(id), loadLive(id, "30d"), loadSessions(id, 1, 10)]);
  const agent = agentLoad.agent;
  const live = liveS.data;
  const asOf = agentLoad.asOf || liveS.asOf || null;
  const profile = parseJson(agent?.profile);
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const quota = parseJson(profile.quota);
  const asOfForHead = missing ? null : asOf;
  const degraded: string[] = [];
  if (!missing && !liveS.ok) degraded.push(`实时状态 /api/agents-live（HTTP ${liveS.status ?? "连接失败"}）`);
  if (!missing && !sessionsS.ok) degraded.push(`会话档案 /api/session-list（HTTP ${sessionsS.status ?? "连接失败"}）`);

  const head = (
    <B4PageHead
      id={id || "(缺少 agentId)"}
      page="详情"
      title="智能体详情"
      subtitle="单个智能体的档案摘要、最近活动与关联入口（只读）"
      agent={agent}
      live={live}
      asOf={asOfForHead}
      chips={["#", "智能体", "详情", "只读"]}
    />
  );
  // 页头状态行（B4 §4：页头 = 智能体名 + id + 状态徽章 + asOf；本页无 [id] 壳，故自带一行）
  const lastSeen = live?.lastSeenAt || (agent?.last_seen_at ? Date.parse(agent.last_seen_at) : null);
  const stateBadge = live?.state === "stuck" ? "badge badge-red"
    : live?.state === "busy" ? "badge badge-green"
    : live?.state === "offline" ? "badge"
    : "badge badge-blue";
  const statusRow = (
    <div className={s.statusRow}>
      <span className={stateBadge}>{live?.stateLabel || agent?.status || "状态 n/a"}</span>
      <span className="badge badge-blue">注册 {live?.registryStatus || agent?.status || "-"}</span>
      <span className="badge">通信服务 {live?.macsStatus || "-"}</span>
      <span>最近露面 {lastSeen ? fmtAgo(lastSeen) : "n/a（接口未下发）"}</span>
    </div>
  );
  const shell = (body: ReactNode) => (
    <div className="layout-with-sidebar"><main className="main">
      {head}
      {statusRow}
      {body}
    </main></div>
  );

  if (missing) {
    return shell(
      <B4Grid>
        <B4Card span={12}>
          <B4State
            phase="empty"
            title="缺少对象标识"
            detail="本页需要 ?agentId=（或 ?id=）指定一个智能体；未提供参数时不猜测对象，也不默认落到任何智能体。"
            retryHref="/agents"
          />
        </B4Card>
      </B4Grid>,
    );
  }
  if (!agentLoad.ok) {
    return shell(
      <B4Grid>
        <B4Card span={12} state="unavailable">
          <B4State
            phase="error"
            title="名册接口取数失败"
            detail={`端点 /api/agent-list 返回 ${agentLoad.status ?? "连接失败"}；这不等于「没有这个智能体」——请稍后重试或检查 BFF。`}
            retryHref={`/agents/detail?agentId=${encodeURIComponent(id)}`}
          />
        </B4Card>
      </B4Grid>,
    );
  }
  if (!agent && !live) {
    return shell(
      <B4Grid>
        <B4Card span={12}>
          <B4State phase="empty" title="未找到该智能体" detail={`名册里查不到 ${id}；可能 id 有误或该智能体已下线。`} retryHref="/agents" />
        </B4Card>
      </B4Grid>,
    );
  }

  // 最近活动时间线：只从真实字段合并（最近执行/最近产出/最近露脸/最近会话），不编造事件。
  const acts: Activity[] = [];
  if (live?.lastExecution?.completedAt) {
    const at = Date.parse(String(live.lastExecution.completedAt));
    const stLabel = EXEC_STATUS_LABEL[String(live.lastExecution.status || "").toUpperCase()] || live.lastExecution.status || "n/a";
    if (Number.isFinite(at)) acts.push({ at, title: `执行完成：${live.lastExecution.taskTitle || live.lastExecution.id || "n/a"}`, meta: `状态 ${stLabel} · 质量通过 ${live.lastExecution.qualityPassed ? "是" : "否"}`, tone: "info" });
  }
  if (live?.lastOutput?.at) acts.push({ at: Number(live.lastOutput.at), title: "产出提交（智能体产出归档）", meta: `质量 ${live.lastOutput.quality != null ? Math.round(Number(live.lastOutput.quality) * 100) + "%" : "n/a（未下发）"}`, tone: "info" });
  if (lastSeen) acts.push({ at: Number(lastSeen), title: "最近露面（心跳/上报）", meta: `${fmtTime(lastSeen)}（${fmtAgo(lastSeen)}）`, tone: "muted" });
  for (const r of sessionsS.data.items) {
    const t = r.last_message_at || r.updated_at || r.started_at;
    if (!t) continue;
    const at = Date.parse(String(t));
    if (!Number.isFinite(at)) continue;
    acts.push({ at, title: `会话活动：${r.title || r.session_uid}`, meta: `${fmtAgo(at)} · 状态 ${r.status || "n/a"} · ${r.message_count != null ? r.message_count + " 条消息" : "消息数 n/a"}`, tone: "info" });
  }
  acts.sort((a, b) => b.at - a.at);
  const topActs = acts.slice(0, 10);
  const base = `/agents/${encodeURIComponent(agent?.agent_id || id)}`;

  return shell(
    <>
      {degraded.length ? <Alert type="warning" showIcon className={s.alertRow} title="部分数据源降级" description={degraded.join("；")} /> : null}
      <B4Grid>
        <B4Card span={4} title="智能体摘要" sub="来自名册 /api/agent-list（只读）">
          <B4Kv items={[
            { label: "智能体编号", value: agent?.agent_id || id, mono: true },
            { label: "显示名", value: agent?.display_name || "n/a（名册未下发）" },
            { label: "状态", value: live?.stateLabel || agent?.status || "n/a（接口未下发）" },
            { label: "角色", value: live?.roleLabel || agent?.role || "n/a（接口未下发）" },
            { label: "能力分级", value: tier != null ? TIER_LABELS[tier] : "n/a（画像未登记）" },
            { label: "每日上限", value: quota.dailyLimit != null ? String(quota.dailyLimit) : "n/a（画像未下发）" },
            { label: "最近露面", value: lastSeen ? `${fmtTime(lastSeen)}（${fmtAgo(lastSeen)}）` : "n/a（接口未下发）" },
          ]} />
          <div className={s.note}><Link href={`${base}/config`} className={s.link}>配置详情（只读） →</Link></div>
        </B4Card>

        <B4Card
          span={8}
          title="最近活动"
          sub={`最近执行/产出/露面/会话合并时间线 · 取前 ${topActs.length} 条`}
          state={sessionsS.ok && liveS.ok ? "ok" : "unavailable"}
          actions={<Link href={`${base}/runs`} className={s.link}>全部运行 →</Link>}
        >
          {!sessionsS.ok || !liveS.ok ? (
            <B4State
              phase="unavailable"
              title="活动数据不完整"
              detail={`${!liveS.ok ? "实时状态 /api/agents-live 不可用；" : ""}${!sessionsS.ok ? "会话档案 /api/session-list 不可用；" : ""}时间线只显示可取得的事件。`}
              retryHref={`/agents/detail?agentId=${encodeURIComponent(id)}`}
            />
          ) : null}
          {topActs.length ? (
            <ul className={s.timeline}>
              {topActs.map((a, i) => (
                <li key={i} className={s.tlItem}>
                  <span className={s.tlDot} data-tone={a.tone} />
                  <div className={s.tlBody}>
                    <div className={s.tlTitle}>{a.title}</div>
                    <div className={s.tlMeta}>{fmtTime(a.at)} · {a.meta}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <B4State phase="empty" title="最近无活动记录" detail="最近执行、产出、露面与会话档案均为空（接口有返回、值确实为空）。" />
          )}
        </B4Card>

        <B4Card span={12} title="关联入口" sub="本智能体的子页与相关只读视图">
          <div className={s.related}>
            <Link href={`${base}/overview`} className={s.link}>概览 →</Link>
            <Link href={`${base}/runs`} className={s.link}>运行记录 →</Link>
            <Link href={`${base}/versions`} className={s.link}>版本/变更 →</Link>
            <Link href={`${base}/config`} className={s.link}>配置（只读） →</Link>
            <Link href="/agents" className={s.link}>全部智能体 →</Link>
            <Link href="/system/permissions" className={s.link}>业务授权矩阵 →</Link>
          </div>
          <div className={s.note}>关联入口均为只读跳转；本页不提供保存/授权/分级设置等写操作（0.5.1 详情只读）。</div>
        </B4Card>
      </B4Grid>
    </>
  );
}
