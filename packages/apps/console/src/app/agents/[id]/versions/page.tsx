// [UI-S6 / 屏06 智能体详情 · 版本]
// 服务端渲染: 名册/画像/授权的时间线 (注册、最近更新、能力分级、配额、密钥到期) + 画像字段快照。
// 2026-11-05 P2 呈现层（批 4/5）：内联 style 清零 + 两张手写 .tbl 表换成白名单 DataTable。
//   取数（loadAgent / loadLive）与字段未动。注意：本页是**服务端组件**，不能给客户端 DataTable 传函数，
//   故把 fmtTime / renderValue 的结果在服务端预算成字符串放进行对象（列、表头、空态文案与改前一致）。
import type { ReactNode } from "react";
import AgentShell from "../_components/AgentShell";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import { TIER_LABELS, fmtTime, loadAgent, loadLive, parseJson } from "../_data";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

interface ChangeRow {
  at: string | number | null;
  topic: string;
  detail: string;
}

/** 变更时间线的一行（已格式化的展示值，供 DataTable 直接渲染） */
interface ChangeView { time: string; topic: string; detail: string }
/** 画像快照的一行 */
interface ProfileView { field: string; value: string }

function ts(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : 0;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "-";
    }
  }
  return String(v);
}

const changeColumns: DataColumn<ChangeView>[] = [
  { key: "time", title: "时间", width: 160 },
  { key: "topic", title: "事项", width: 160 },
  { key: "detail", title: "说明" },
];

const profileColumns: DataColumn<ProfileView>[] = [
  { key: "field", title: "字段", width: 220 },
  { key: "value", title: "取值" },
];

export default async function AgentVersionsPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS] = await Promise.all([loadAgent(id), loadLive(id)]);
  if (!agentLoad.ok) return <AgentSourceError id={id} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push("实时状态 /api/agents-live");
  if (!agent && !live) return <AgentMissing id={id} />;

  const profile = parseJson(agent?.profile);
  const quota = parseJson(profile.quota);
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;

  const changes: ChangeRow[] = [];
  const push = (at: unknown, topic: string, detail: ReactNode) => {
    if (at == null || at === "") return;
    changes.push({ at: at as string | number, topic, detail: String(detail) });
  };
  push(agent?.created_at, "登记注册", "智能体首次进入名册");
  push(profile.capabilitySetAt, "能力分级设置", `${tier != null ? TIER_LABELS[tier] : "-"}（${profile.capabilitySetBy || "未知来源"}）`);
  push(quota.setAt, "配额设置", `每日上限 ${quota.dailyLimit ?? "-"} · ${quota.mode || "-"}`);
  push(agent?.updated_at, "最近更新", "名册记录最近一次变更");
  push(agent?.last_seen_at, "最近露面", "最近一次心跳/上报时间");
  for (const p of agent?.permissions ?? []) {
    push(p.expires_at, "服务密钥到期", `${p.service_name} 的授权密钥到期`);
  }
  changes.sort((a, b) => ts(b.at) - ts(a.at));

  const profileKeys = Object.keys(profile);
  const changeRows: ChangeView[] = changes.map((c) => ({ time: fmtTime(c.at), topic: c.topic, detail: c.detail }));
  const profileRows: ProfileView[] = profileKeys.map((k) => ({ field: k, value: renderValue(profile[k]) }));

  return (
    <AgentShell id={id} active="versions" agent={agent} live={live}>
      {degraded.length ? <Alert type="warning" showIcon className={styles.alertRow} title="部分数据源降级" description={degraded.join("；")} /> : null}
      <div className={"panel " + styles.panelGap}>
        <div className="panel-header"><span className="panel-title">变更时间线（{changes.length} 项）</span></div>
        <TableCopyButton />
        <DataTable columns={changeColumns} rows={changeRows} rowKey={(c) => c.time + c.topic} empty={{ title: "暂无可展示的变更记录" }} />
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">画像字段快照（{profileKeys.length} 项）</span></div>
        <TableCopyButton />
        <DataTable columns={profileColumns} rows={profileRows} rowKey={(p) => p.field} empty={{ title: "该智能体没有登记画像" }} />
      </div>
    </AgentShell>
  );
}
