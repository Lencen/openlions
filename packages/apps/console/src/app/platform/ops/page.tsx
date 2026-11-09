"use client";
// 「运营看板」——执行产能与模型调用的只读一屏（C1d）。数据源: mind /api/v1/flywheel/ops，console 代理 /api/ops。
import { useEffect, useState } from "react";
import Link from "next/link";
import { PanelCard } from "@/components/ui";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface Ops {
  asOf?: string;
  capacity?: { backlog?: number; neverClaimed?: number; created?: number; completed?: number; netBacklogDelta?: number; throughputPerHour?: number; inProgress?: number };
  llm?: { calls?: number; ok?: number; failRate?: number | null };
  agents?: Array<{ agentId: string; status: string }>;
  error?: string;
}

export default function OpsBoardPage() {
  const [d, setD] = useState<Ops | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    fetch("/api/ops")
      .then((r) => r.json())
      .then((j: Ops) => { if (j && j.error) setMsg("上游暂不可用，稍后刷新"); setD(j); })
      .catch(() => setMsg("读取失败"));
  }, []);
  const c = d?.capacity || {};
  const l = d?.llm || {};
  const agents = d?.agents || [];
  const active = agents.filter((a) => a.status === "ACTIVE").length;
  return (
    <main className="page">
      {/* 2026-11-05 页头口径统一（PAGE-HEADER-31 §3）：原来是 PageHero，换成白名单 PageHeader。
          标题 / 一句说明 / 面包屑逐字取表（平台 / 运营配置）；表里"主操作：保存"本页没有对应动作
          （只读取数，不写配置），按"没有就不放，别造"留空。取数、面板与文案均未动。 */}
      <div className="breadcrumb">
        <span className={styles.crumbDim}>平台</span>
        <span className="sep">/</span>
        <span className="current">运营配置</span>
      </div>
      <PageHeader>
        <PageTitle>运营配置</PageTitle>
        <div className="page-subtitle">运营参数与开关</div>
      </PageHeader>
      {msg ? <div className="tiny">{msg}</div> : null}
      <PanelCard title="执行产能">
        <div className={styles.big}>
          积压 {c.backlog ?? "-"}（从未认领 {c.neverClaimed ?? "-"}）
          <br />
          新建 {c.created ?? "-"} / 完成 {c.completed ?? "-"} · 净积压 {c.netBacklogDelta ?? "-"}/日 · 吞吐 {c.throughputPerHour ?? "-"}/小时 · 在跑 {c.inProgress ?? "-"}
        </div>
      </PanelCard>
      <PanelCard title="模型调用">
        <div className={styles.big}>
          调用 {l.calls ?? "-"} 次 · 失败率 {l.failRate == null ? "-" : Math.round(Number(l.failRate) * 100) + "%"}
        </div>
      </PanelCard>
      <PanelCard title="执行体">
        <div className={styles.big}>已登记 {agents.length} 个（活跃 {active}）</div>
      </PanelCard>
      <div className={"tiny " + styles.footNote}>只读聚合 · 时刻 {d?.asOf ?? "-"}</div>
      <div className={"tiny " + styles.footLinks}>
        <span>相关视图：</span>
        <Link href="/agents-live">执行体在线 →</Link>
        <Link href="/llm-usage">语言模型用量 →</Link>
      </div>
    </main>
  );
}
