// [UI-S6 / 屏06 智能体详情 · 配置]
// 只读展示: 能力分级 + 业务服务授权矩阵 + 配额。真正改动权限仍走既有可编辑页(/agents/detail)。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 三张手写 .tbl 表 → 白名单 DataTable。
//   列/字段/文案不变；两张无表头的「标签 → 值」表用 .kvTable 藏掉 DataTable 的空表头行。
//   取数（loadAgent / loadLive / loadServices）与只读语义一字未改。
import type { ReactNode } from "react";
import Link from "next/link";
import AgentShell, { AgentTabHeader } from "../_components/AgentShell";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import { TIER_LABELS, fmtTime, loadAgent, loadLive, loadServices, parseJson, parseList } from "../_data";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

/** 「标签 → 值」两列表（改前是 手写表格<tbody> 里逐行 kv(...)） */
type KvRow = { label: string; value: ReactNode };
/** 服务授权矩阵：每个单元格都是服务端已渲染好的节点（列定义里没有函数） */
type ServiceTableRow = {
  name: ReactNode;
  desc: ReactNode;
  version: ReactNode;
  status: ReactNode;
  granted: ReactNode;
  available: ReactNode;
  expires: ReactNode;
};
// 2026-11-05 热修：服务端组件不能把 render 函数传给客户端 DataTable，
//   列只留可序列化字段，单元格值在服务端预算成 ReactNode/字符串放进 rows。
const KV_COLUMNS: DataColumn<KvRow>[] = [
  { key: "label", title: "" },
  { key: "value", title: "" },
];

export default async function AgentConfigPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS, servicesS] = await Promise.all([loadAgent(id), loadLive(id), loadServices(id)]);
  // 2026-11-06 D-03：先备好页签页头 —— 名册失败/智能体不存在/正常三条分支都要渲染它，
  //   否则 SSR 首屏没有 page-header（0.4.31 dev 实测 5 页 70/75 的根因就是只有"正常"分支带页头）。
  const tabHeader = (
    <AgentTabHeader
      id={id}
      tab="配置"
      title="智能体详情 · 配置"
      subtitle="能力分级、服务授权与配额（只读）"
      agent={agentLoad.ok ? agentLoad.agent : null}
      live={liveS.data}
    />
  );
  if (!agentLoad.ok) return <AgentSourceError id={id} header={tabHeader} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  const services = servicesS.data;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push("实时状态 /api/agents-live");
  if (!servicesS.ok) degraded.push("服务目录 /api/agent-services");
  if (!agent && !live) return <AgentMissing id={id} header={tabHeader} />;

  const profile = parseJson(agent?.profile);
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const quota = parseJson(profile.quota);
  const permByService: Record<string, any> = {};
  for (const p of agent?.permissions ?? []) permByService[p.service_name] = p;

  const capabilityRows: KvRow[] = [
    { label: "当前分级", value: tier != null ? TIER_LABELS[tier] : "-" },
    { label: "分级理由", value: profile.capabilityReason || "-" },
    { label: "设置来源", value: profile.capabilitySetBy || "-" },
    { label: "设置时间", value: <span className={"mono " + styles.sm}>{fmtTime(profile.capabilitySetAt)}</span> },
    { label: "工具能力", value: profile.toolCapable ? "有工具" : "无工具" },
    { label: "常驻执行器", value: profile.persistentWorker ? "是" : "否" },
  ];
  const quotaRows: KvRow[] = [
    { label: "每日上限", value: quota.dailyLimit != null ? String(quota.dailyLimit) : "-" },
    { label: "模式", value: quota.mode || "-" },
    { label: "设置来源", value: quota.setBy || "-" },
    { label: "设置时间", value: <span className={"mono " + styles.sm}>{fmtTime(quota.setAt)}</span> },
    { label: "说明", value: quota.note || "-" },
  ];
  const serviceColumns: DataColumn<ServiceTableRow>[] = [
    { key: "name", title: "服务", width: 140 },
    { key: "desc", title: "说明" },
    { key: "version", title: "版本", width: 70 },
    { key: "status", title: "目录状态", width: 90 },
    { key: "granted", title: "已授权权限" },
    { key: "available", title: "可授权权限" },
    { key: "expires", title: "密钥到期", width: 110 },
  ];
  const serviceRows: ServiceTableRow[] = services.map((s) => {
    const granted = parseList(permByService[s.name]?.permissions);
    return {
      name: <span className={styles.strong}>{s.display_name || s.name}</span>,
      desc: <span className={styles.dim}>{s.description || "-"}</span>,
      version: <span className={"mono " + styles.sm}>{s.version || "-"}</span>,
      status: <span className={s.status === "ACTIVE" ? "badge badge-green" : "badge"}>{s.status || "-"}</span>,
      granted: granted.length ? (
        <span className={styles.badgeWrap}>
          {granted.map((g) => <span key={g} className="badge badge-blue">{g}</span>)}
        </span>
      ) : (
        <span className={styles.muted}>未授权</span>
      ),
      available: <span className={styles.dim}>{parseList(s.available_perms).join(" / ") || "-"}</span>,
      expires: <span className={"mono " + styles.sm}>{fmtTime(permByService[s.name]?.expires_at)}</span>,
    };
  });

  return (
    <AgentShell
      id={id}
      active="config"
      agent={agent}
      live={live}
      header={tabHeader}
    >
      {degraded.length ? (
        <div className={styles.alertRow}>
          <Alert type="warning" showIcon title="部分数据源降级" description={degraded.join("；")} />
        </div>
      ) : null}
      <div className="grid-2">
        <div className="panel">
          <div className="panel-header"><span className="panel-title">能力分级</span></div>
          <TableCopyButton />
          <div className={styles.kvTable}>
            <DataTable columns={KV_COLUMNS} rows={capabilityRows} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><span className="panel-title">配额</span></div>
          <TableCopyButton />
          <div className={styles.kvTable}>
            <DataTable columns={KV_COLUMNS} rows={quotaRows} />
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">服务授权矩阵（{services.length} 个业务服务）</span>
          <Link
            href={`/agents/detail?id=${encodeURIComponent(agent?.agent_id || id)}`}
            className={styles.adjustLink}
          >
            去调整权限
          </Link>
        </div>
        <TableCopyButton />
        <DataTable
          columns={serviceColumns}
          rows={serviceRows}
          empty={{ title: "服务目录暂不可用" }}
        />
      </div>
    </AgentShell>
  );
}
