"use client";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

// 2026-09-07: Agent 配置统一收敛到 Agent 详情页 (真实授权矩阵/业务管理)
// 此页保留入口, 自动跳转 agents/detail (带 agentId 或默认 leo)
function ConfigRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const aid = params.get("agentId") || "agent-e";
    router.replace("/agents/detail?agentId=" + aid);
  }, []);
  return (<div className="layout-with-sidebar"><main className="main"><div style={{padding: "var(--sp-7)",color:"var(--text-muted)",textAlign:"center"}}>正在跳转到智能体详情（配置管理）...</div></main></div>);
}

export default function AgentConfigPage() {
  return (<Suspense fallback={<div style={{padding: "var(--sp-7)",textAlign:"center"}}>加载中...</div>}><ConfigRedirect /></Suspense>);
}
