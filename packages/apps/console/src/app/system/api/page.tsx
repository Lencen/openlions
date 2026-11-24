"use client";
// 0.5.1 B5-2 /system/api · Bento P1/P7 接口清单（2026-11-15）
// 数据：GET /api/agent-services（服务表 6 行）+ GET /api/mcp-proxy（工具 6 个静态清单）；
//       REST/tRPC 清单来自页面常量（源码唯一来源，非接口）。
// 缺口：MCP 工具调用数无埋点 → n/a + 原因；本页只读，不渲染工具调测（POST /api/mcp-proxy 写路径）。
import { useState, useEffect } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import BentoState from "@/components/bento/BentoState";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, States, Toolbar, Tone, usePhaseOverride, useResource } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import { REST_ENDPOINTS, TRPC_ROUTERS } from "./_components/EndpointTables";
import { fmtNum, fmtTime } from "@/lib/format";

interface Svc { name: string; display_name: string; description: string; endpoint: string; version: string; status: string; enabled: boolean; available_perms?: string | string[]; updated_at?: string }

const permCount = (p?: string | string[]): number => {
  if (Array.isArray(p)) return p.length;
  if (typeof p === "string" && p) { try { const a = JSON.parse(p); return Array.isArray(a) ? a.length : 0; } catch { return 0; } }
  return 0;
};

export default function ApiListPage() {
  const svc = useResource<Svc[] | { services?: Svc[] }>("/api/agent-services", {
    emptyWhen: (d) => (Array.isArray(d) ? d.length : (d.services || []).length) === 0,
  });
  const mcp = useResource<{ tools?: string[] }>("/api/mcp-proxy");
  const [reqAt, setReqAt] = useState<string | null>(null);
  useEffect(() => { setReqAt(new Date().toISOString()); }, []);
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : svc.phase;
  const services: Svc[] = Array.isArray(svc.data) ? svc.data : (svc.data?.services ?? []);
  const tools = mcp.data?.tools ?? [];
  const active = services.filter((s) => s.status === "ACTIVE").length;
  const toolCount = tools.length;

  const k = (v: number | null | undefined, hint: string): Metric =>
    v == null ? { kind: "na", reason: "接口未返回该字段" } : { kind: "value", value: fmtNum(v), hint };

  const svcCols: DataColumn<Svc>[] = [
    { key: "name", title: "服务", width: 150, render: (s) => <b>{s.name}</b> },
    { key: "disp", title: "显示名", width: 120, render: (s) => s.display_name || "n/a" },
    { key: "ver", title: "版本", width: 90, render: (s) => <span className={kit.mono}>{s.version || "n/a"}</span> },
    { key: "status", title: "状态", width: 90, render: (s) => <Tone tone={s.status === "ACTIVE" ? "ok" : "warn"}>{s.status === "ACTIVE" ? "已启用" : s.status || "n/a"}</Tone> },
    { key: "endpoint", title: "端点", render: (s) => <span className={kit.mono}>{s.endpoint || "n/a"}</span> },
    { key: "perms", title: "权限项", align: "right", width: 80, render: (s) => <span className={kit.num}>{permCount(s.available_perms) || "n/a"}</span> },
  ];

  const restCols: DataColumn<string[]>[] = [
    { key: "method", title: "方法", width: 80, render: (r) => <Tone tone={r[0] === "GET" ? "info" : "warn"}>{r[0]}</Tone> },
    { key: "path", title: "路径", render: (r) => <span className={kit.mono}>{r[1]}</span> },
    { key: "owner", title: "归属", width: 160, render: (r) => r[2] || "n/a" },
    { key: "state", title: "状态", width: 100, render: () => <Tone tone="ok">已注册</Tone> },
  ];
  const trpcCols: DataColumn<string[]>[] = [
    { key: "router", title: "路由", width: 140, render: (r) => <b className={kit.mono}>{r[0]}</b> },
    { key: "eps", title: "核心端点", render: (r) => <span className={kit.mono}>{r[1]}</span> },
    { key: "n", title: "数量", align: "right", width: 80, render: (r) => <span className={kit.num}>{r[2]}</span> },
  ];

  return (
    <main className="page" data-slot="system-api-page">
      <h1 className={kit.srOnly}>接口</h1>
      <PageHeader>
        <PageTitle>接口</PageTitle>
        <div className="page-subtitle">平台对外接口 · 业务服务注册表 · 智能体工具通道（只读；来自源码常量与注册接口）· 数据时刻 {reqAt ? fmtTime(reqAt) : "n/a"}（请求时刻）</div>
        <Chips group="系统" page="接口" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/agent-services" error={svc.error} status={svc.status} onRetry={svc.reload}
        emptyTitle="无接口" emptyDetail="服务注册接口正常返回但没有任何业务服务（空集，非不可得）。"
        unavailableTitle="接口清单不可得" unavailableDetail="agent-services 未返回服务数组；补齐路径：BFF 输出 services[]。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="业务服务" metric={k(summaryCount(services), "GET /api/agent-services 行数")} />
          <KpiTile span={3} label="已启用服务" metric={k(active, "status=ACTIVE")} />
          <KpiTile span={3} label="对外接口" metric={k(REST_ENDPOINTS.length, "页面常量（源码唯一来源）")} />
          <KpiTile span={3} label="内部路由 / 工具通道" metric={toolCount || TRPC_ROUTERS.length ? { kind: "value", value: TRPC_ROUTERS.length + " / " + (mcp.phase === "ok" ? toolCount : "n/a"), hint: mcp.phase === "ok" ? "内部路由数 / 工具通道工具数" : "工具通道工具数取不到（见下方工具卡）" } : { kind: "na", reason: "mcp-proxy 未返回 tools" }} />

          <BentoCard span={8} title="业务服务注册表" sub={"共 " + fmtNum(services.length) + " 个服务 · ACTIVE " + fmtNum(active) + " 个"}>
            <Toolbar right="只读 · GET /api/agent-services" />
            <DataTable<Svc> columns={svcCols} rows={services} rowKey={(s) => s.name}
              empty={{ title: "无业务服务", desc: "注册表为空（空集，不是不可得）。" }} />
          </BentoCard>

          <BentoCard span={4} title="智能体工具通道" sub={mcp.phase === "ok" ? "共 " + fmtNum(toolCount) + " 个（静态清单）" : "工具清单取不到"}>
            {mcp.phase === "loading" && <BentoState phase="loading" />}
            {mcp.phase === "error" && <BentoState phase="error" title="工具通道清单不可得" detail={"端点 GET /api/mcp-proxy · " + (mcp.status ? "返回码 " + mcp.status : mcp.error) + " · 可重试。"} onRetry={mcp.reload} />}
            {mcp.phase === "ok" && (
              <>
                <ul className={kit.kv}>
                  {tools.map((t) => <li key={t}><span className={kit.mono}>{t}</span><b>已注册</b></li>)}
                </ul>
                <Note>调用数 n/a —— mcp-proxy 只返回工具名清单，无调用计数埋点（补齐需埋点，不在本批）。</Note>
              </>
            )}
          </BentoCard>

          <BentoCard span={12} title="对外接口" sub={"共 " + REST_ENDPOINTS.length + " 条（页面常量；本批只读清单）"}>
            <DataTable<string[]> columns={restCols} rows={REST_ENDPOINTS} rowKey={(_r, i) => i} />
          </BentoCard>

          <BentoCard span={12} title="内部接口路由" sub={"共 " + TRPC_ROUTERS.length + " 个路由"}>
            <DataTable<string[]> columns={trpcCols} rows={TRPC_ROUTERS} rowKey={(_r, i) => i} />
            <Note>口径：对外/内部接口清单来自页面常量（源码唯一来源）；服务注册表与工具通道来自接口。工具调测为写路径，0.5.1 只读页不渲染。</Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}

function summaryCount<T>(arr: T[]): number { return arr.length; }