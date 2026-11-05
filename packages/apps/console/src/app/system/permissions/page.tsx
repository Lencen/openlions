"use client";
// 2026-11-05 P2 呈现层改造（批 4/5）：内联 style 清零 + 手写 .tbl 表换成白名单 DataTable。
//   取数（/api/agent-permissions、/api/agent-services、20s 轮询）、字段、路由与文案未动；
//   业务授权矩阵的列仍按原表头：智能体 / 各业务服务（动态列）/ 操作。
import { useEffect, useState } from "react";
import KPICard from "@/components/KPICard";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface PermRow { agent_id: string; display_name?: string; status?: string; permissions?: { service_name: string; status: string }[] }

export default function PermissionsPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<any[]>([]);

  const load = async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch("/api/agent-permissions", { cache: "no-store" }),
        fetch("/api/agent-services", { cache: "no-store" }),
      ]);
      // 2026-10-13 round 76-AF: 原来不检查 r.ok —— 接口 500 时错误体不是数组, 被静默当成"无授权", 用户看不到失败。
      if (!r1.ok || !r2.ok) throw new Error("请求失败（状态码 " + (r1.ok ? r2.status : r1.status) + "）");
      const d1 = await r1.json(); const d2 = await r2.json();
      setAgents(Array.isArray(d1) ? d1 : []);
      setServices(Array.isArray(d2) ? d2 : (d2?.services || []));
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);

  const svcNames = services.length > 0 ? services.map((s: any) => s.name) : ["lions_mind","lions_memory","lions_knowledge","lions_session","lions_flywheel","mcp_agent_chat"];
  const authOf = (a: any, svc: string) => { const p = (a.permissions || []).find((x: any) => x.service_name === svc); return p ? p.status : "NONE"; };
  const totalAuth = agents.reduce((s: number, a: any) => s + (a.permissions || []).filter((p: any) => p.status === "ACTIVE").length, 0);
  // 三个状态的呈现：✓ / ✕ / —（原来是内联 color 的 span，改成类；中心对齐用块级 span 承担）
  const badge = (st: string) => st === "ACTIVE" ? (<span className="badge badge-green">✓</span>) : st === "REVOKED" ? (<span className="badge badge-red">✕</span>) : (<span className={styles.dash}>—</span>);

  // 列定义：与原 <thead> 逐列对应（智能体 / 动态服务列 / 操作）
  const columns: DataColumn<PermRow>[] = [
    {
      key: "agent",
      title: t('permissions.col.agent'),
      render: (a: any) => (
        <span className="nowrap">
          <b className={styles.agentId}>{a.agent_id}</b>
          <div className={styles.agentSub}>{a.display_name || ""} · {a.status}</div>
        </span>
      ),
    },
    ...svcNames.map((s: string) => ({
      key: "svc-" + s,
      title: s.replace("lions_","").replace("_"," "),
      render: (a: any) => <span className={styles.center}>{badge(authOf(a, s))}</span>,
    })),
    {
      key: "op",
      title: "操作",
      width: 100,
      render: (a: any) => (
        <span className={"nowrap " + styles.opCell}>
          <a href={"/agents/detail?agentId=" + a.agent_id} className={styles.link}>管理 →</a>
        </span>
      ),
    },
  ];

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>业务与系统</span><span className="sep">/</span><span className="current">权限管理</span></div>
    <PageHeader><PageTitle>{t('permissions.title')}</PageTitle><div className="page-subtitle">{t('permissions.subtitle')}</div></PageHeader>
    {error && <div className={styles.errorRow}>⚠ {error}</div>}
    <div className="kpi-grid">
      <KPICard label={t('permissions.kpi.agents')} value={String(agents.length)} />
      <KPICard label="业务服务" value={String(svcNames.length)} />
      <KPICard label="有效授权" value={String(totalAuth)} />
      <KPICard label="授权点" value={String(agents.length * svcNames.length)} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">业务授权矩阵 {loading && "(加载中...)"}</span></div>
      <div className={styles.tableScroll}><TableCopyButton />
        <DataTable
          columns={columns}
          rows={agents}
          rowKey={(a) => a.agent_id}
          loading={loading}
          empty={{ title: t('permissions.empty') }}
        />
      </div>
      <div className={styles.legend}>{t('permissions.legend')}</div>
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">角色 / 多租户（架构预留）</span></div><div className={styles.rbac}>{t('permissions.rbac')}</div></div>
  </main></div>);
}
