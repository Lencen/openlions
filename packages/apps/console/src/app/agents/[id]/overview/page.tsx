// [UI-S6 / 屏06 智能体详情 · 概览]
// 服务端组件 (force-dynamic): curl 该路由 HTML 即含真实字段(显示名 / 角色 / 能力分级 / 配额 / 在办任务)。
// 数据来源见 ../_data.ts; 只读。
// 2026-11-05 P2 呈现层（批 4/5）：内联 style 清零 + 四处手写 .tbl 表 → 白名单 DataTable。
//   三张「标签 → 值」表改前无表头，换 DataTable 后用 .kvTable 藏掉空表头行并把首列还原成 th 观感
//   （与 /agents/[id]/config 同一做法）；「待开始任务」表头（任务 / 优先级 90 / 改进类型 130）不变。
//   取数（loadAgent / loadLive）与只读语义一字未改。
import type { ReactNode } from "react";
import KPICard from "@/components/KPICard";
import AgentShell from "../_components/AgentShell";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import { TIER_LABELS, fmtAgo, fmtTime, loadAgent, loadLive, parseJson } from "../_data";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const CAP_ROWS: Array<[string, string]> = [
  ["tools", "工具"],
  ["db", "数据库"],
  ["file", "文件"],
  ["network", "网络"],
];

/** 「标签 → 值」两列（改前是 table.tbl > tbody 里逐行 kv(...)） */
type KvRow = { label: string; value: ReactNode };
const KV_COLUMNS: DataColumn<KvRow>[] = [
  { key: "label", title: "", render: (r) => r.label },
  { key: "value", title: "", render: (r) => r.value },
];

/** 待开始任务的一行 */
type PendingRow = { id: string; title?: string; priority?: string; improvementType?: string };
const PENDING_COLUMNS: DataColumn<PendingRow>[] = [
  { key: "title", title: "任务", render: (r) => r.title || r.id },
  { key: "priority", title: "优先级", width: 90, render: (r) => r.priority || "-" },
  { key: "improvementType", title: "改进类型", width: 130, render: (r) => r.improvementType || "-" },
];

export default async function AgentOverviewPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS] = await Promise.all([loadAgent(id), loadLive(id)]);
  if (!agentLoad.ok) return <AgentSourceError id={id} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push("实时状态 /api/agents-live");
  if (!agent && !live) return <AgentMissing id={id} />;

  const profile = parseJson(agent?.profile);
  const perms = agent?.permissions ?? [];
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const caps = parseJson(profile.capabilities);
  const quota = parseJson(profile.quota);
  const ts = live?.taskStats ?? {};
  const current = live?.currentTask ?? agent?.currentTask ?? null;
  const pending: PendingRow[] = live?.assignedPending ?? [];

  const baseRows: KvRow[] = [
    { label: "智能体编号", value: <span className="mono">{agent?.agent_id || id}</span> },
    { label: "显示名", value: agent?.display_name || "-" },
    { label: "角色", value: live?.roleLabel || agent?.role || "-" },
    { label: "接入通道", value: agent?.channel || live?.channel || "-" },
    { label: "主机", value: agent?.host || live?.host || "-" },
    { label: "注册状态", value: <span className="badge badge-blue">{live?.registryStatus || agent?.status || "-"}</span> },
    { label: "当前状态", value: live?.stateLabel || "-" },
    { label: "创建时间", value: <span className={"mono " + styles.sm}>{fmtTime(agent?.created_at)}</span> },
    { label: "最近更新", value: <span className={"mono " + styles.sm}>{fmtTime(agent?.updated_at)}</span> },
    { label: "最近露面", value: `${fmtTime(agent?.last_seen_at || live?.lastSeenAt)}（${fmtAgo(agent?.last_seen_at || live?.lastSeenAt)}）` },
  ];

  const capRows: KvRow[] = [
    { label: "能力分级", value: tier != null ? TIER_LABELS[tier] : "-" },
    { label: "分级理由", value: profile.capabilityReason || "-" },
    { label: "模型", value: profile.model || "-" },
    { label: "运行方式", value: profile.driver || "-" },
    { label: "负责人", value: profile.owner || "-" },
    { label: "每日上限", value: quota.dailyLimit != null ? String(quota.dailyLimit) : "-" },
    { label: "配额模式", value: quota.mode || "-" },
    {
      label: "能力清单",
      value: (
        <span className={styles.capWrap}>
          {CAP_ROWS.map(([key, label]) => (
            <span key={key} className={caps[key] ? "badge badge-green" : "badge"}>
              {label} {caps[key] ? "可用" : "不可用"}
            </span>
          ))}
        </span>
      ),
    },
  ];

  const taskRows: KvRow[] = current ? [
    { label: "任务", value: current.title || current.id },
    { label: "状态", value: <span className="badge badge-yellow">{current.status || "-"}</span> },
    { label: "优先级", value: current.priority || "-" },
    { label: "主题", value: current.theme || "-" },
    { label: "静默时长", value: current.idleMin != null ? `${current.idleMin} 分钟` : "-" },
  ] : [];

  return (
    <AgentShell id={id} active="overview" agent={agent} live={live}>
      {degraded.length ? <Alert type="warning" showIcon className={styles.alertRow} title="部分数据源降级" description={degraded.join("；")} /> : null}
      <div className="kpi-grid">
        <KPICard label="已办任务" value={(ts.done ?? 0).toLocaleString()} />
        <KPICard label="在办任务" value={(ts.running ?? 0).toLocaleString()} />
        <KPICard label="待开始任务" value={(ts.pending ?? 0).toLocaleString()} />
        <KPICard label="产出质量" value={live?.outputQuality != null ? `${Math.round(Number(live.outputQuality) * 100)}%` : "-"} />
        <KPICard label="近 24 小时消息" value={(live?.macsMessages24h ?? 0).toLocaleString()} />
        <KPICard label="已授权服务" value={perms.length.toLocaleString()} />
      </div>

      <div className={"grid-2 " + styles.mb4}>
        <div className="panel">
          <div className="panel-header"><span className="panel-title">基础信息</span></div>
          <TableCopyButton />
          <div className={styles.kvTable}>
            <DataTable columns={KV_COLUMNS} rows={baseRows} rowKey={(r) => r.label} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><span className="panel-title">能力与配额</span></div>
          <TableCopyButton />
          <div className={styles.kvTable}>
            <DataTable columns={KV_COLUMNS} rows={capRows} rowKey={(r) => r.label} />
          </div>
        </div>
      </div>

      <div className={"panel " + styles.mb4}>
        <div className="panel-header"><span className="panel-title">当前任务</span></div>
        {current ? (
          <div className={styles.kvTable}>
            <DataTable columns={KV_COLUMNS} rows={taskRows} rowKey={(r) => r.label} />
          </div>
        ) : (
          <div className={styles.emptyNote}>当前没有在办任务。</div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">待开始任务（{(live?.assignedPendingCount ?? pending.length).toLocaleString()}）</span>
        </div>
        <TableCopyButton />
        <DataTable columns={PENDING_COLUMNS} rows={pending.slice(0, 10)} rowKey={(r) => r.id} empty={{ title: "没有待开始任务" }} />
      </div>
    </AgentShell>
  );
}
