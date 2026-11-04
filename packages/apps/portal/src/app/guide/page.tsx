"use client";
import { useEffect, useRef, useState } from "react";

interface Section {
  id: string;
  title: string;
  markdown: string;
}

interface GuideResp {
  ok: boolean;
  version: string;
  updatedAt: string;
  base: Record<string, string>;
  sections: Section[];
}

export default function GuidePage() {
  const [data, setData] = useState<GuideResp | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState("");
  // P1-4 (2026-09-07): 内容区滚动引用 + 记住上次阅读章节
  const contentRef = useRef<HTMLDivElement>(null);
  const STORE_KEY = "lions-guide-last-section";

  useEffect(() => {
    fetch("/api/portal/guide?format=json")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setData(d);
          const saved = (typeof window !== "undefined" && window.localStorage.getItem(STORE_KEY)) || "";
          const exists = d.sections?.some((s: any) => s.id === saved);
          setActive(exists ? saved : (d.sections[0]?.id || ""));
        }
        else setError("加载失败");
      })
      .catch(() => setError("网络错误"));
  }, []);

  const cur = data?.sections.find((s) => s.id === active);

  // 切章节: 记住位置 + 内容滚回顶部 (锚点语义)
  const selectSection = (id: string) => {
    setActive(id);
    try { window.localStorage.setItem(STORE_KEY, id); } catch {}
    contentRef.current?.scrollTo?.({ top: 0 });
  };

  return (
    <main className="main" style={{ marginLeft: 0, padding: "28px 32px", maxWidth: 1100 }}>
      <div className="breadcrumb">
        <span style={{ color: "var(--text-dim)" }}>AI 接入层</span>
        <span className="sep">/</span>
        <span className="current">Agent 接入手册</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>Agent 接入手册</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
            让 Agent 自助了解平台能力并学会交互 · 版本 {data?.version || "..."} · 更新于 {data?.updatedAt || ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a className="btn" href="/api/portal/guide?format=md" target="_blank" rel="noreferrer">下载 Markdown</a>
          <a className="btn" href="/api/portal/guide?format=json" target="_blank" rel="noreferrer">查看 JSON</a>
        </div>
      </div>

      {error && <div style={{ color: "var(--status-crit)", marginBottom: 12 }}>⚠ {error}</div>}

      {data && (
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div style={{ width: 190, flexShrink: 0, position: "sticky", top: 72 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>目录</div>
            {data.sections.map((s) => (
              <button
                key={s.id}
                onClick={() => selectSection(s.id)}
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "9px 10px", marginBottom: 2,
                  borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13,
                  background: active === s.id ? "var(--primary-dim)" : "transparent",
                  color: active === s.id ? "var(--primary)" : "var(--text-dim)",
                  fontWeight: active === s.id ? 600 : 400,
                }}
              >
                {s.title}
              </button>
            ))}
          </div>

          <div className="panel" style={{ flex: 1, minWidth: 0 }} ref={contentRef}>
            {cur && (
              <>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 12px" }}>{cur.title}</h2>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: 1.7, color: "var(--text)", maxHeight: 620, overflowY: "auto" }}>
                  {cur.markdown}
                </pre>
              </>
            )}

            {data.base && (
              <div style={{ marginTop: 16, padding: 12, background: "var(--bg-surface2)", borderRadius: 8, fontSize: 12 }}>
                <strong>你的平台可达地址:</strong>
                <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.8 }}>
                  <div>mind: <span style={{ color: "var(--primary)" }}>{data.base.mind}</span></div>
                  <div>session: <span style={{ color: "var(--primary)" }}>{data.base.session}</span></div>
                  <div>portal: <span style={{ color: "var(--primary)" }}>{data.base.portal}</span></div>
                  <div>console: <span style={{ color: "var(--primary)" }}>{data.base.console}</span></div>
                </div>
                <div style={{ marginTop: 8, color: "var(--text-muted)" }}>
                  远端 agent (如 [host]) 走 LAN [internal-ip]; 本机用 localhost。agent 通过 register/heartbeat 拿到自己的 base。
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
