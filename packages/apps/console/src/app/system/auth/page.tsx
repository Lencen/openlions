"use client";
import { useEffect, useState } from "react";
import KPICard from "@/components/KPICard";
import { Alert } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
import TableCopyButton from "@/components/TableCopyButton";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

export default function AuthPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // 2026-10-13 round 76-DL: 接入全局刷新(本页只挂载拉一次)。
  const gf = useGlobalNonce();
  useEffect(() => {
    fetch(`/api/agent-permissions?_gf=${gf}`, { cache: "no-store" })
      // 2026-10-13 round 76-AF: 原来不检查 r.ok —— 接口 500 时错误体不是数组, 被静默当成"无密钥", 用户看不到失败。
      .then((r) => { if (!r.ok) throw new Error("请求失败（状态码 " + r.status + "）"); return r.json(); }).then((d) => setAgents(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [gf]);

  // 每业务: 签发 key 数 (ACTIVE) + 取消数 (REVOKED)
  const svcStat: Record<string, { active: number; revoked: number }> = {};
  for (const a of agents) {
    for (const p of (a.permissions || [])) {
      const s = p.service_name;
      if (!svcStat[s]) svcStat[s] = { active: 0, revoked: 0 };
      if (p.status === "ACTIVE") svcStat[s].active++;
      else if (p.status === "REVOKED") svcStat[s].revoked++;
    }
  }
  const totalActive = Object.values(svcStat).reduce((s, v) => s + v.active, 0);
  const totalRevoked = Object.values(svcStat).reduce((s, v) => s + v.revoked, 0);

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>业务与系统</span><span className="sep">/</span><span className="current">统一认证</span></div>
    <PageHeader><PageTitle>统一认证</PageTitle><div className="page-subtitle">平台密钥认证体系（每业务独立密钥）· 单点登录 / 角色权限预留</div></PageHeader>
    {error && <div style={{ marginBottom: "var(--sp-3)" }}><Alert type="error" message="密钥数据加载失败" description={String(error).slice(0, 200)} /></div>}
    <div className="kpi-grid">
      <KPICard label="认证方式" value="接口密钥" />
      <KPICard label="有效密钥" value={String(totalActive)} />
      <KPICard label="已取消" value={String(totalRevoked)} />
      <KPICard label="业务服务" value={String(Object.keys(svcStat).length)} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">业务服务密钥签发状态（实时）</span></div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>业务服务</th><th>有效密钥</th><th>已取消</th><th>认证</th></tr></thead><tbody>
        {Object.entries(svcStat).map(([svc, v]) => (
          <tr key={svc}><td className="nowrap"><b>{svc}</b></td><td className="num">{v.active}</td><td className="num">{v.revoked}</td><td><span className="badge badge-green">sk-mind</span></td></tr>
        ))}
        {loading && <tr><td colSpan={4} style={{padding: "var(--sp-4)",color:"var(--text-muted)",textAlign:"center"}}>加载中...</td></tr>}
        {!loading && !error && Object.keys(svcStat).length === 0 && <tr><td colSpan={4} style={{padding: "var(--sp-4)",color:"var(--text-muted)",textAlign:"center"}}>暂无业务服务密钥</td></tr>}
      </tbody></table>
      <div style={{fontSize: "var(--fs-sm)",color:"var(--text-dim)",marginTop: "var(--sp-1-5)"}}>
        Key 由接入审批签发 (勾选业务), 取消授权即失效。细粒度授权矩阵见 <a href="/system/permissions" style={{color:"var(--primary)"}}>权限管理</a>。
        单点登录 / 授权登录 / 目录账号与角色权限为非商业版预留（架构字段已存在）。
      </div>
    </div>
  </main></div>);
}
