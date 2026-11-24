"use client";
// 0.5.1 B5-5 /system/business · Bento P1 列表（2026-11-15）
// 数据：GET /api/agent-services（业务系统/服务注册表 6 行）。
// 缺口：平台无客户/营收数据源 → 营收类指标 n/a + 原因（不得出现营收 KPI）。
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

interface Svc { name: string; display_name: string; description: string; endpoint: string; version: string; status: string; enabled: boolean; available_perms?: string | string[]; created_at?: string; updated_at?: string }

function permText(p: any): string {
  if (typeof p === "string") { try { return JSON.parse(p).join(", "); } catch { return p; } }
  return Array.isArray(p) ? p.join(", ") : "n/a";
}
function permCount(p: any): number {
  if (typeof p === "string") { try { const a = JSON.parse(p); return Array.isArray(a) ? a.length : 0; } catch { return 0; } }
  return Array.isArray(p) ? p.length : 0;
}

export default function BusinessPage() {
  const res = useResource<Svc[] | { services?: Svc[] }>("/api/agent-services", {
    emptyWhen: (d) => (Array.isArray(d) ? d.length : (d.services || []).length) === 0,
  });
  const [reqAt, setReqAt] = useState<string | null>(null);
  useEffect(() => { setReqAt(new Date().toISOString()); }, []);
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : res.phase;
  const services: Svc[] = Array.isArray(res.data) ? res.data : (res.data?.services ?? []);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return kw ? services.filter((s) => (s.name + " " + s.display_name + " " + s.endpoint).toLowerCase().includes(kw)) : services;
  }, [services, q]);
  const active = services.filter((s) => s.status === "ACTIVE").length;
  const permTotal = services.reduce((a, s) => a + permCount(s.available_perms), 0);

  const k = (v: number | null, hint: string): Metric =>
    v == null ? { kind: "na", reason: hint } : { kind: "value", value: fmtNum(v), hint };

  const cols: DataColumn<Svc>[] = [
    { key: "name", title: "业务系统", width: 170, render: (s) => <b className={kit.mono}>{s.name}</b> },
    { key: "disp", title: "显示名", width: 130, render: (s) => s.display_name || "n/a" },
    { key: "ver", title: "版本", width: 90, render: (s) => <span className={kit.mono}>{s.version || "n/a"}</span> },
    { key: "endpoint", title: "端点", render: (s) => <span className={kit.mono}>{s.endpoint || "n/a"}</span> },
    { key: "perms", title: "权限项", width: 240, render: (s) => <span className={kit.muted}>{permText(s.available_perms)}</span> },
    { key: "status", title: "状态", width: 100, render: (s) => <Tone tone={s.status === "ACTIVE" ? "ok" : "warn"}>{s.status === "ACTIVE" ? "已对接" : s.status || "n/a"}</Tone> },
    { key: "upd", title: "更新时间", width: 170, render: (s) => <span className={kit.mono}>{s.updated_at ? fmtTime(s.updated_at) : "n/a"}</span> },
  ];

  return (
    <main className="page">
      <h1 className={kit.srOnly}>业务系统</h1>
      <PageHeader>
        <PageTitle>业务系统</PageTitle>
        <div className="page-subtitle">业务服务注册与对接状态 · 数据时刻 {res.data && (res.data as any).asOf ? fmtTime((res.data as any).asOf) : reqAt ? fmtTime(reqAt) : "n/a" + "（请求时刻）"}</div>
        <Chips group="系统" page="业务" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/agent-services" error={res.error} status={res.status} onRetry={res.reload}
        emptyTitle="无业务系统" emptyDetail="注册接口正常返回但没有任何业务服务（空集，不是不可得）。"
        unavailableTitle="业务系统不可得" unavailableDetail="agent-services 未返回服务数组；补齐路径：BFF 输出 services[]。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="业务系统" metric={k(services.length, "GET /api/agent-services 行数")} />
          <KpiTile span={3} label="已对接（ACTIVE）" metric={k(active, "status=ACTIVE")} />
          <KpiTile span={3} label="权限项合计" metric={k(permTotal, "各服务 available_perms 数组长度之和")} />
          <KpiTile span={3} label="待注册" metric={{ kind: "na", reason: "注册接口只返回已注册服务，无「待注册」状态字段（需注册审批接口）" }} />

          <BentoCard span={12} title="业务服务" sub={"共 " + fmtNum(services.length) + " 个 · 已对接 " + fmtNum(active) + " 个"}>
            <Toolbar right="只读 · GET /api/agent-services">
              <Search value={q} onChange={setQ} placeholder="搜索 业务系统 / 显示名 / 端点" />
            </Toolbar>
            <DataTable<Svc> columns={cols} rows={rows} rowKey={(s) => s.name}
              empty={{ title: "无业务系统", desc: "注册表为空（空集）。" }} />
          </BentoCard>

          <BentoCard span={12} title="口径与缺口">
            <ul className={kit.kv}>
              <li><span>营收 / 客户</span><b>n/a —— 平台无客户表与营收数据源；本页不出现营收类 KPI（出现即数据造假）。</b></li>
              <li><span>「待注册」</span><b>n/a —— 无注册审批/待注册状态接口；只展示已注册服务。</b></li>
              <li><span>权限项</span><b>来自服务注册接口的权限项清单；不同服务能力不同，不做跨服务求和以外的推断。</b></li>
            </ul>
            <Note>相关视图：<a className={kit.link} href="/system/permissions">权限管理</a> · <a className={kit.link} href="/system/api">接口清单</a></Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}