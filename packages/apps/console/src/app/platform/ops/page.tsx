"use client";
// 「运营看板」——执行产能与模型调用的只读一屏（C1d）。数据源: mind /api/v1/flywheel/ops，console 代理 /api/ops。
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHero, Pill, PanelCard } from "@/components/ui";

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
      <PageHero title="运营看板" subtitle="执行产能与模型调用（近 24 小时，只读）" tags={<Pill tone="info">只读</Pill>} />
      {msg ? <div className="tiny">{msg}</div> : null}
      <PanelCard title="执行产能">
        <div style={{ fontSize: "var(--fs-lg)", lineHeight: 2 }}>
          积压 {c.backlog ?? "-"}（从未认领 {c.neverClaimed ?? "-"}）
          <br />
          新建 {c.created ?? "-"} / 完成 {c.completed ?? "-"} · 净积压 {c.netBacklogDelta ?? "-"}/日 · 吞吐 {c.throughputPerHour ?? "-"}/小时 · 在跑 {c.inProgress ?? "-"}
        </div>
      </PanelCard>
      <PanelCard title="模型调用">
        <div style={{ fontSize: "var(--fs-lg)", lineHeight: 2 }}>
          调用 {l.calls ?? "-"} 次 · 失败率 {l.failRate == null ? "-" : Math.round(Number(l.failRate) * 100) + "%"}
        </div>
      </PanelCard>
      <PanelCard title="执行体">
        <div style={{ fontSize: "var(--fs-lg)", lineHeight: 2 }}>已登记 {agents.length} 个（活跃 {active}）</div>
      </PanelCard>
      <div className="tiny" style={{ marginTop: "var(--sp-4)" }}>只读聚合 · 时刻 {d?.asOf ?? "-"}</div>
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/agents-live">执行体在线 →</Link>
        <Link href="/llm-usage">语言模型用量 →</Link>
      </div>
    </main>
  );
}
