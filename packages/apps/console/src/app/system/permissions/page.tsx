"use client";
// 0.5.1 B5-9 /system/permissions · Bento P3 配置/列表（2026-11-15）
// 数据：GET /api/agent-permissions（8 行，行内 permissions[]）+ GET /api/agent-services（6 个业务服务）。
// 口径：0.5.1 只读 —— 原页「授权/取消授权」写控件（POST /api/agent-permissions）不渲染；
//       角色/多租户为架构预留（tenant_id 多为 null）→ n/a + 原因；授权点=permissions 服务名并集，不混行数。
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, Search, States, Toolbar, Tone, usePhaseOverride, useResource } from "../_components/bento-kit";
import { useMemo, useState, useEffect } from "react";
import kit from "../_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface Perm { service_name: string; status: string; expires_at?: string | null }
interface Agent { agent_id: string; display_name?: string; status?: string; role?: string | null; tenant_id?: string | null; updated_at?: string; permissions?: Perm[] }
interface Svc { name: string; display_name?: string; status?: string }

const FALLBACK_SVC = ["lions_mind", "lions_memory", "lions_knowledge", "lions_session", "lions_flywheel", "mcp_agent_chat"];

export default function PermissionsPage() {
  const agentsRes = useResource<Agent[]>("/api/agent-permissions", { emptyWhen: (d) => d.length === 0 });
  const svcRes = useResource<Svc[] | { services?: Svc[] }>("/api/agent-services");
  const [reqAt, setReqAt] = useState<string | null>(null);
  useEffect(() => { setReqAt(new Date().toISOString()); }, []);
  const forced = usePhaseOverride();
  const agents = Array.isArray(agentsRes.data) ? agentsRes.data : [];
  const services: Svc[] = Array.isArray(svcRes.data) ? svcRes.data : (svcRes.data?.services ?? []);
  const svcNames = services.length > 0 ? services.map((s) => s.name) : FALLBACK_SVC;

  const phases = [agentsRes.phase, svcRes.phase];
  const combined = phases.includes("forbidden") ? "forbidden" : phases.includes("error") ? "error" : phases.includes("loading") ? "loading" : agentsRes.phase === "ok" && agents.length === 0 ? "empty" : "ok";
  const phase = forced && forced !== "ok" ? forced : combined;

  const [q, setQ] = useState("");
  const visibleAgents = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return kw ? agents.filter((a) => (a.agent_id + " " + (a.display_name || "")).toLowerCase().includes(kw)) : agents;
  }, [agents, q]);
  const roles = new Set<string>();
  agents.forEach((a) => { if (a.role) roles.add(a.role); });
  const authOf = (a: Agent, svc: string): string => (a.permissions || []).find((p) => p.service_name === svc)?.status || "NONE";
  const activeAuth = agents.reduce((s, a) => s + (a.permissions || []).filter((p) => p.status === "ACTIVE").length, 0);
  const authPoints = new Set<string>();
  agents.forEach((a) => (a.permissions || []).forEach((p) => authPoints.add(p.service_name + ":" + p.status)));
  const tenants = new Set(agents.map((a) => a.tenant_id).filter(Boolean));

  const k = (v: number | null, hint: string): Metric =>
    v == null ? { kind: "na", reason: hint } : { kind: "value", value: fmtNum(v), hint };

  const badge = (st: string) => st === "ACTIVE" ? <Tone tone="ok">已授权</Tone> : st === "REVOKED" ? <Tone tone="crit">已取消</Tone> : <span className={kit.muted}>—</span>;

  const cols: DataColumn<Agent>[] = [
    { key: "agent", title: "智能体", width: 190, render: (a) => <><b className={kit.mono}>{a.agent_id}</b><div className={kit.muted}>{a.display_name || "n/a"} · {a.status || "n/a"}</div></> },
    { key: "role", title: "角色", width: 100, render: (a) => a.role ? <Tone tone="info">{a.role}</Tone> : <span className={kit.muted}>n/a</span> },
    ...svcNames.map((s) => ({
      key: "svc-" + s,
      title: s.replace("lions_", "").replace("mcp_", "mcp "),
      width: 110,
      render: (a: Agent) => badge(authOf(a, s)),
    }) as DataColumn<Agent>),
    { key: "updated", title: "更新", width: 170, render: (a) => <span className={kit.mono}>{a.updated_at ? fmtTime(a.updated_at) : "n/a"}</span> },
  ];

  return (
    <main className="page">
      <h1 className={kit.srOnly}>权限管理</h1>
      <PageHeader>
        <PageTitle>权限管理</PageTitle>
        <div className="page-subtitle">平台授权矩阵（智能体 × 业务服务）· 0.5.1 只读 · 数据来自授权与服务注册接口 · 数据时刻 {reqAt ? fmtTime(reqAt) : "n/a"}（请求时刻）</div>
        <Chips group="系统" page="权限" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/agent-permissions · GET /api/agent-services" error={agentsRes.error || svcRes.error} status={agentsRes.status || svcRes.status} onRetry={() => { agentsRes.reload(); svcRes.reload(); }}
        emptyTitle="无权限数据" emptyDetail="授权接口正常返回但没有任何授权记录（空集，不是不可得）。"
        unavailableTitle="权限数据不可得" unavailableDetail="agent-permissions 未返回数组；补齐路径：BFF 输出授权行。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="授权代理" metric={k(agents.length, "GET /api/agent-permissions 行数")} />
          <KpiTile span={3} label="角色数" metric={roles.size ? k(roles.size, Array.from(roles).join(" / ")) : { kind: "na", reason: "角色字段全空（角色/多租户为架构预留，当前无角色数据源）" }} />
          <KpiTile span={3} label="授权点数（服务×状态）" metric={k(authPoints.size, "各 agent permissions 的服务名+状态并集")} />
          <KpiTile span={3} label="租户" metric={tenants.size ? k(tenants.size, Array.from(tenants).join(" / ")) : { kind: "na", reason: "tenant_id 全为 null（多租户为架构预留，无数据源）" }} />

          <BentoCard span={12} title="平台授权矩阵" sub={"智能体 " + fmtNum(agents.length) + " 行 × 业务服务 " + fmtNum(svcNames.length) + " 列 · 有效授权 " + fmtNum(activeAuth) + " 项"}>
            <Toolbar right="只读 · 写操作（授权/取消）0.5.1 不开放">
              <Search value={q} onChange={setQ} placeholder="搜索 智能体 / 显示名" />
            </Toolbar>
            <DataTable<Agent> columns={cols} rows={visibleAgents} rowKey={(a) => a.agent_id}
              empty={{ title: "无授权记录", desc: "授权矩阵为空（空集）。" }} />
            <Note>图例：已授权 = permissions.status ACTIVE；已取消 = REVOKED；— = 无该服务授权记录。本页不渲染写按钮（0.5.1 只读）。</Note>
          </BentoCard>

          <BentoCard span={4} title="角色 / 多租户" sub="架构预留（当前无数据源）">
            <ul className={kit.kv}>
              <li><span>角色数</span><b>{roles.size ? fmtNum(roles.size) + "（" + Array.from(roles).join(" / ") + "）" : "n/a —— 角色字段为空，角色权限模型为预留"}</b></li>
              <li><span>租户</span><b>{tenants.size ? Array.from(tenants).join(" / ") : "n/a —— tenant_id 全为 null"}</b></li>
              <li><span>授权点口径</span><b>服务名 + 状态并集（{fmtNum(authPoints.size)} 个），不等于行数×列数</b></li>
            </ul>
          </BentoCard>

          <BentoCard span={8} title="口径与只读说明">
            <ul className={kit.kv}>
              <li><span>平台密钥认证</span><b>每业务独立接口密钥；本页只读展示授权矩阵，不展示密钥指纹/明文（BFF 白名单已剔除）。</b></li>
              <li><span>写操作</span><b>0.5.1 只读：授权/取消授权（POST /api/agent-permissions）不渲染，待写通路契约（二次确认 + 审计）开放。</b></li>
              <li><span>审计</span><b>n/a —— console 无 /api/audit 只读接口（实测 404）；写路径审计在服务端 AuditLog。</b></li>
            </ul>
            <Note>相关视图：<a className={kit.link} href="/system/business">业务系统</a> · <a className={kit.link} href="/system/auth">统一认证</a></Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}