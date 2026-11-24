"use client";

// /about 错误边界（2026-11-13 M4 C/D/F：补 error 态）
export default function AboutError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <h1>关于平台</h1>
      <div role="alert" style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 16, color: "var(--text-muted)" }}>
        <b>页面加载失败</b>
        <p>版本/运行时信息读取异常；请重试或联系平台维护。</p>
        <button type="button" className="btn" onClick={() => reset()}>重试</button>
      </div>
    </main>
  );
}
