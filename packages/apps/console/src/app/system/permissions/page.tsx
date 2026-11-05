"use client";
import { useEffect, useState } from "react";
import KPICard from "@/components/KPICard";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

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
  const badge = (st: string) => st === "ACTIVE" ? (<span className="badge badge-green">✓</span>) : st === "REVOKED" ? (<span className="badge badge-red">✕</span>) : (<span style={{color:"var(--text-muted)"}}>—</span>);

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>业务与系统</span><span className="sep">/</span><span className="current">权限管理</span></div>
    <PageHeader><PageTitle>{t('permissions.title')}</PageTitle><div className="page-subtitle">{t('permissions.subtitle')}</div></PageHeader>
    {error && <div style={{ color: "var(--status-crit)", marginBottom: "var(--sp-3)" }}>⚠ {error}</div>}
    <div className="kpi-grid">
      <KPICard label={t('permissions.kpi.agents')} value={String(agents.length)} />
      <KPICard label="业务服务" value={String(svcNames.length)} />
      <KPICard label="有效授权" value={String(totalAuth)} />
      <KPICard label="授权点" value={String(agents.length * svcNames.length)} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">业务授权矩阵 {loading && "(加载中...)"}</span></div>
      <div style={{overflowX:"auto"}}><TableCopyButton />
      <table className="tbl"><thead><tr><th>{t('permissions.col.agent')}</th>{svcNames.map((s: string) => (<th key={s} style={{fontSize: "var(--fs-xs)"}}>{s.replace("lions_","").replace("_"," ")}</th>))}<th style={{width:100}}>操作</th></tr></thead><tbody>
        {agents.map((a: any) => (<tr key={a.agent_id}>
          <td className="nowrap"><b style={{fontSize: "var(--fs-base)"}}>{a.agent_id}</b><div style={{fontSize: "var(--fs-xs)",color:"var(--text-dim)"}}>{a.display_name || ""} · {a.status}</div></td>
          {svcNames.map((s: string) => (<td key={s} style={{textAlign:"center"}}>{badge(authOf(a, s))}</td>))}
          <td className="nowrap" style={{fontSize: "var(--fs-sm)"}}><a href={"/agents/detail?agentId=" + a.agent_id} style={{color:"var(--primary)"}}>管理 →</a></td>
        </tr>))}
        {agents.length === 0 && !loading && <tr><td colSpan={svcNames.length + 2} style={{padding: "var(--sp-5)",color:"var(--text-muted)",textAlign:"center"}}>{t('permissions.empty')}</td></tr>}
      </tbody></table></div>
      <div style={{fontSize: "var(--fs-sm)",color:"var(--text-dim)",marginTop: "var(--sp-2)"}}>{t('permissions.legend')}</div>
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">角色 / 多租户（架构预留）</span></div><div style={{fontSize: "var(--fs-sm)",color:"var(--text-muted)"}}>{t('permissions.rbac')}</div></div>
  </main></div>);
}
