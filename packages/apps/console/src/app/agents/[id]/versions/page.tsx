// 0.5.1 B4-10 /agents/[id]/versions · Bento 版本/变更（2026-11-15）
// SLOT-MAP（B4 §4）：s12 页头 → s12 版本列表（版本号/时间/变更/操作只读）→ s4 当前版本摘要 + s8 画像快照。
// 数据现实（诚实口径）：AgentRegistry/画像均未下发 version 字段 → 「版本号」列如实 n/a+原因；
//   可观测的版本事件 = 画像/授权/名册时间戳（登记、分级设置、配额设置、密钥到期、最近更新），按时间倒序。
// 只读；四态：loading（loading.tsx）/ empty（无版本事件）/ error（端点+状态码+重试）/ unavailable（分块 n/a）。
import type { ReactNode } from "react";
import Link from "next/link";
import AgentShell from "../_components/AgentShell";
import { B4Card, B4Grid, B4Kv, B4PageHead, B4State } from "../_components/B4";
import { TIER_LABELS, fmtTime, loadAgent, loadLive, parseJson } from "../_data";
import { Alert } from "@/components/primitives";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import s from "../_components/b4.module.css";

export const dynamic = "force-dynamic";

interface ChangeRow { at: string | number | null; topic: string; detail: string }
type VersionRow = { version: ReactNode; time: ReactNode; change: ReactNode; op: ReactNode };
const VERSION_COLUMNS: DataColumn<VersionRow>[] = [
  { key: "version", title: "版本号", width: 140 },
  { key: "time", title: "时间", width: 150 },
  { key: "change", title: "变更说明" },
  { key: "op", title: "操作", width: 70 },
];

type ProfileRow = { field: ReactNode; value: ReactNode };
const PROFILE_COLUMNS: DataColumn<ProfileRow>[] = [
  { key: "field", title: "画像字段", width: 200 },
  { key: "value", title: "取值" },
];

function ts(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : 0;
}
function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "n/a（空值）";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return "n/a（不可序列化）"; } }
  return String(v);
}

export default async function AgentVersionsPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS] = await Promise.all([loadAgent(id), loadLive(id, "24h")]);
  const agent = agentLoad.agent;
  const live = liveS.data;
  const asOf = agentLoad.asOf || liveS.asOf || null;
  const profile = parseJson(agent?.profile);
  const quota = parseJson(profile.quota);
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push(`实时状态 /api/agents-live（HTTP ${liveS.status ?? "连接失败"}）`);

  const head = <B4PageHead id={id} page="版本" title="智能体详情 · 版本" subtitle="版本事件时间线、当前版本摘要与画像快照" agent={agent} live={live} asOf={asOf} />;
  const fallback = (phase: "empty" | "error", title: string, detail: ReactNode, retry?: string) => (
    <div className="layout-with-sidebar"><main className="main">
      {head}
      <B4Grid><B4Card span={12} state={phase === "error" ? "unavailable" : "ok"}><B4State phase={phase} title={title} detail={detail} retryHref={retry} /></B4Card></B4Grid>
    </main></div>
  );
  if (!id) return fallback("empty", "缺少对象标识", "本页需要智能体 id（/agents/{id}/versions）；请从智能体列表进入。", "/agents");
  if (!agentLoad.ok) {
    return fallback("error", "名册接口取数失败", `端点 /api/agent-list 返回 ${agentLoad.status ?? "连接失败"}；这不等于「没有这个智能体」，请稍后重试。`, `/agents/${encodeURIComponent(id)}/versions`);
  }
  if (!agent && !live) return fallback("empty", "未找到该智能体", `名册里查不到 ${id}；可能 id 有误或该智能体已下线。`, "/agents");

  const changes: ChangeRow[] = [];
  const push = (at: unknown, topic: string, detail: string) => {
    if (at == null || at === "") return;
    changes.push({ at: at as string | number, topic, detail });
  };
  push(agent?.created_at, "登记注册", "智能体首次进入名册");
  push(profile.capabilitySetAt, "能力分级设置", `${tier != null ? TIER_LABELS[tier] : "n/a（分级未知）"}（${profile.capabilitySetBy || "设置来源未下发"}）`);
  push(quota.setAt, "配额设置", `每日上限 ${quota.dailyLimit ?? "n/a"} · ${quota.mode || "n/a"}`);
  push(agent?.updated_at, "名册最近更新", "名册记录最近一次变更");
  push(agent?.last_seen_at, "最近露面", "最近一次心跳/上报时间");
  for (const p of agent?.permissions ?? []) push(p.expires_at, "服务密钥到期", `${p.service_name} 的授权密钥到期`);
  changes.sort((a, b) => ts(b.at) - ts(a.at));

  const versionRows: VersionRow[] = changes.map((c) => ({
    version: <span className={s.dim + " " + s.sm}>n/a（名册/画像未下发版本号）</span>,
    time: <span className={s.sm}>{fmtTime(c.at)}</span>,
    change: <><b>{c.topic}</b><div className={s.dim + " " + s.sm}>{c.detail}</div></>,
    op: <span className="badge">只读</span>,
  }));
  const profileRows: ProfileRow[] = Object.keys(profile).map((k) => ({ field: <span className={s.mono + " " + s.sm}>{k}</span>, value: renderValue(profile[k]) }));
  const lastChange = changes[0];

  return (
    <AgentShell id={id} active="versions" agent={agent} live={live} header={head}>
      {degraded.length ? <Alert type="warning" showIcon className={s.alertRow} title="部分数据源降级" description={degraded.join("；")} /> : null}

      <B4Grid>
        <B4Card
          span={12}
          title="版本列表"
          sub={`可观测的版本事件 ${changes.length} 项 · 按时间倒序 · 名册/画像未下发版本号（版本号列如实 n/a）`}
          actions={<span className={s.dim + " " + s.sm}>只读</span>}
        >
          <div className={s.tableWrap}>
            <DataTable
              columns={VERSION_COLUMNS}
              rows={versionRows}
              empty={{
                title: "无版本记录",
                desc: "该智能体没有任何可观测的时间戳（登记/分级/配额/授权到期均为空），故无版本事件可列。",
                action: <Link href="/agents" className={s.link}>返回智能体列表</Link>,
              }}
            />
          </div>
          <div className={s.note}>口径：平台名册与画像接口都不下发版本号字段，本页不编造版本号，只列真实可观测的配置/注册变更事件（变更说明）。</div>
        </B4Card>

        <B4Card span={4} title="当前版本摘要" state="unavailable">
          <B4Kv items={[
            { label: "当前版本", value: "n/a（名册/画像未下发版本号字段）" },
            { label: "最近变更", value: lastChange ? `${lastChange.topic} · ${fmtTime(lastChange.at)}` : "n/a（无变更事件）" },
            { label: "变更事件数", value: `${changes.length} 项` },
            { label: "画像字段数", value: `${Object.keys(profile).length} 项` },
            { label: "能力分级", value: tier != null ? TIER_LABELS[tier] : "n/a（画像未登记）" },
            { label: "名册更新时间", value: fmtTime(agent?.updated_at), mono: true },
          ]} />
        </B4Card>

        <B4Card span={8} title="画像字段快照" sub={`来自名册 /api/agent-list 的 profile · ${Object.keys(profile).length} 个字段（只读）`}>
          <div className={s.tableWrap}>
            <DataTable columns={PROFILE_COLUMNS} rows={profileRows} empty={{ title: "该智能体没有登记画像", desc: "profile 为空，画像字段快照不可渲染。" }} />
          </div>
        </B4Card>

        <B4Card span={12} title="相关视图">
          <div className={s.related}>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/overview`} className={s.link}>概览 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/runs`} className={s.link}>运行记录 →</Link>
            <Link href={`/agents/${encodeURIComponent(agent?.agent_id || id)}/config`} className={s.link}>配置（只读） →</Link>
            <Link href="/agents" className={s.link}>全部智能体 →</Link>
          </div>
        </B4Card>
      </B4Grid>
    </AgentShell>
  );
}
