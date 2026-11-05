"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { FlowData } from "./_components/types";
import FlowHeader from "./_components/FlowHeader";
import FlowStatus from "./_components/FlowStatus";
import FlowPipeline from "./_components/FlowPipeline";
import FlowSourcesSessions from "./_components/FlowSourcesSessions";
import FlowQueuesPanel from "./_components/FlowQueuesPanel";
import FlowQualityPanel from "./_components/FlowQualityPanel";
import FlowQualityAuditPanel from "./_components/FlowQualityAuditPanel";
import FlowLogsPanel from "./_components/FlowLogsPanel";
import styles from "./page.module.css";

// 飞轮运转动态图 v2 (2026-09-03)
// 被动动态: 10s 自动刷新; 展示 ①在不在转 ②每步输入/输出量+来源 ③堆积 ④质量 ⑤session 处理情况
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。

export default function FlywheelFlowPage() {
  const [d, setD] = useState<FlowData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/flywheel-flow", { cache: "no-store" });
        const j = await r.json();
        if (j.error) setErr(j.error); else setD(j);
      } catch (e: any) { setErr(e.message); }
    };
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const age = d?.heartbeat?.lastEvent?.ageSec ?? -1;
  const alive = age >= 0 && age < 600;
  const pausedWarn = age >= 600;
  const q = (k: string) => d?.queues?.[k] ?? 0;

  return (
    <div className="layout"><main className="main">
      <FlowHeader d={d} err={err} />
      <FlowStatus d={d} age={age} alive={alive} pausedWarn={pausedWarn} q={q} />
      <FlowPipeline steps={d?.steps || []} />
      <FlowSourcesSessions d={d} />
      <FlowQueuesPanel q={q} ready={!!d} />
      <FlowQualityPanel d={d} />
      <FlowQualityAuditPanel d={d} />
      <FlowLogsPanel logs={d?.logs} ready={!!d} />
      {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className={`tiny ${styles.flowRelatedLinks}`}>
        <span>相关视图：</span>
        <Link href="/system/pipeline">流水线监控 →</Link>
        <Link href="/flywheel/executions">执行记录 →</Link>
      </div>
    </main></div>
  );
}
