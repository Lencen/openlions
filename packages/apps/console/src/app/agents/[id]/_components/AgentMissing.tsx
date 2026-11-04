// [UI-S6 / 屏06] 智能体不存在 / 取数失败时的降级态 (不 500、不白屏)
import Link from "next/link";

export default function AgentMissing({ id }: { id: string }) {
  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <Link href="/">概览</Link>
          <span className="sep">/</span>
          <Link href="/agents">智能体</Link>
          <span className="sep">/</span>
          <span className="current">未找到</span>
        </div>
        <div className="panel" style={{ padding: "var(--sp-6)" }}>
          <div style={{ fontWeight: 600, marginBottom: "var(--sp-2)" }}>没有这个智能体</div>
          <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-md)" }}>
            名册里查不到 <span className="mono">{id || "(空)"}</span>，或名册接口暂时不可用。
            &nbsp;<Link href="/agents" style={{ color: "var(--primary)" }}>返回智能体列表</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
