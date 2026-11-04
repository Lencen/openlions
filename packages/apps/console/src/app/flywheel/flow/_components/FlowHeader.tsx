"use client";
// flywheel/flow 页 · 面包屑 + 页头 + 错误提示 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import type { FlowData } from "./types";

export default function FlowHeader({ d, err }: { d: FlowData | null; err: string }) {
  return (
    <>
      <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>飞轮引擎</span><span className="sep">/</span><span className="current">飞轮运转动态图</span></div>
      <div className="page-header">
        <div className="page-title">飞轮运转动态图</div>
        <div className="page-subtitle">每 10 秒被动刷新 · 只汇总不调 LLM · {d ? new Date(d.timestamp).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "加载中..."}</div>
      </div>
      {err && <div style={{ color: "var(--status-crit)", marginBottom: "var(--sp-3)" }}>⚠ {err}</div>}
    </>
  );
}
