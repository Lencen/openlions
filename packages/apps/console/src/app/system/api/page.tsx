"use client";
// system/api 页 · 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数、状态与拼装 (<200 行)。
import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { ApiKpiGrid } from "./_components/ApiHeader";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import EndpointTables, { REST_ENDPOINTS, TRPC_ROUTERS } from "./_components/EndpointTables";
import McpServiceTable from "./_components/McpServiceTable";
import ToolPlayground from "./_components/ToolPlayground";
import useMcpTools from "./_components/useMcpTools";
import type { McpTool, Svc } from "./_components/types";
import ErrorAlert from "@/components/ErrorAlert";
import styles from "./page.module.css";

export default function ApiListPage() {
  const { data: svcData, error, mutate } = useApi<Svc[] | { services: Svc[] }>(
    "/api/agent-services"
  );
  const services = Array.isArray(svcData)
    ? svcData
    : svcData?.services ?? [];

  // MCP 服务工具列表（按服务名分桶）
  const { toolsByService } = useMcpTools(services);

  // 实时调测状态
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [inputJson, setInputJson] = useState("{}");
  const [callResult, setCallResult] = useState<string>("");
  const [calling, setCalling] = useState(false);

  async function invokeTool() {
    if (!selectedTool) return;
    setCalling(true);
    setCallResult("");
    try {
      const args = JSON.parse(inputJson || "{}");
      const r = await fetch("/api/mcp-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "tools/call",
          params: { name: selectedTool.name, arguments: args },
        }),
      });
      const j = await r.json();
      const content = j?.result?.content;
      if (Array.isArray(content)) {
        setCallResult(content.map((c: any) => c.text ?? JSON.stringify(c)).join("\n"));
      } else {
        setCallResult(JSON.stringify(j, null, 2));
      }
    } catch (e: any) {
      setCallResult(`ERROR: ${e.message}`);
    }
    setCalling(false);
  }

  function handlePickTool(t: McpTool) {
    setSelectedTool(t);
    setInputJson(
      t.inputSchema?.properties
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(t.inputSchema.properties).map(
                ([k, v]: any) => [
                  k,
                  v?.default ??
                    (v?.type === "number"
                      ? 0
                      : v?.type === "object"
                        ? {}
                        : ""),
                ]
              )
            ),
            null,
            2
          )
        : "{}"
    );
    setCallResult("");
  }

  const totalTools = Object.values(toolsByService).reduce(
    (s, t) => s + t.length,
    0
  );

  return (
    <div className="layout-with-sidebar">
      
      <main className="main">
        {/* 2026-11-05 页头口径统一（PAGE-HEADER-31 §3）：页头从 _components/ApiHeader 上移到本页，
            标题 / 一句说明 / 面包屑逐字取表（平台 / 接口）。四个计数仍在下方 KPI 卡里，指标口径未动。 */}
        <div className="breadcrumb">
          <span className={styles.crumbDim}>平台</span>
          <span className="sep">/</span>
          <span className="current">接口</span>
        </div>
        <PageHeader>
          <PageTitle>接口</PageTitle>
          <div className="page-subtitle">平台对外接口与调用量</div>
        </PageHeader>
        {error ? <ErrorAlert title="服务列表加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}
        <ApiKpiGrid
          restCount={REST_ENDPOINTS.length}
          trpcCount={TRPC_ROUTERS.length}
          mcpCount={services.length}
          toolCount={totalTools}
        />
        <McpServiceTable
          services={services}
          toolsByService={toolsByService}
          onPickTool={handlePickTool}
        />
        <ToolPlayground
          selectedTool={selectedTool}
          inputJson={inputJson}
          setInputJson={setInputJson}
          callResult={callResult}
          calling={calling}
          onInvoke={invokeTool}
        />
        <EndpointTables />
        {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
        <div className={`tiny ${styles.relatedLinks}`}>
          <span>相关视图：</span>
          <Link href="/system/guards">守门规则 →</Link>
          <Link href="/system/health">健康检查 →</Link>
        </div>
      </main>
    </div>
  );
}
