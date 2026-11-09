"use client";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

// 2026-09-07: Agent 配置统一收敛到 Agent 详情页 (真实授权矩阵/业务管理)
// 此页保留入口, 自动跳转 agents/detail (带 agentId 或默认 agent-x)
function ConfigRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const aid = params.get("agentId") || "agent-e";
    router.replace("/agents/detail?agentId=" + aid);
  }, []);
  return (
    <div className="layout-with-sidebar">
      <main className="main">
        {/* 2026-11-05 页头口径（PAGE-HEADER-31 §3 第 7 行）：本页只是入口跳转页（跳 /agents/detail），
            按表给标题 + 一句说明 + 面包屑；表里的主操作「保存」在本页没有落点（页面无表单/无保存动作），
            按规则 3「没有就不放」不造按钮。 */}
        <div className="breadcrumb"><span>成员</span><span className="sep">/</span><span>智能体</span><span className="sep">/</span><span className="current">配置</span></div>
        <PageHeader>
          <PageTitle>智能体配置</PageTitle>
          <div className="page-subtitle">全局智能体的默认参数与开关</div>
        </PageHeader>
        <div className={styles.redirect}>正在跳转到智能体详情（配置管理）...</div>
      </main>
    </div>
  );
}

export default function AgentConfigPage() {
  return (<Suspense fallback={<div className={styles.fallback}>加载中...</div>}><ConfigRedirect /></Suspense>);
}
