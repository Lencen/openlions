"use client";
// [UI-S6] 名册接口取数失败降级态 —— 与 AgentMissing 区分:
//   AgentMissing 表示「名册取数成功但查不到该 agent」;
//   本组件表示「名册接口本身失败, 无法判断 agent 是否存在」, 避免把取数失败显示成「没有这个智能体」。
import Link from "next/link";

export default function AgentSourceError({ id }: { id: string }) {
  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <Link href="/">概览</Link>
          <span className="sep">/</span>
          <Link href="/agents">智能体</Link>
          <span className="sep">/</span>
          <span className="current">取数失败</span>
        </div>
        <div className="panel" style={{ padding: "var(--sp-6)" }}>
          <div style={{ fontWeight: 600, marginBottom: "var(--sp-2)", color: "var(--status-crit)" }}>名册接口取数失败</div>
          <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-md)", lineHeight: 1.7 }}>
            暂时读不到智能体名册（<span className="mono">/api/agent-list</span>），因此无法确认 <span className="mono">{id || "(空)"}</span> 是否存在。
            <br />这不等于「没有这个智能体」—— 请稍后刷新，或检查 BFF。
            <br /><Link href="/agents" style={{ color: "var(--primary)" }}>返回智能体列表</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
