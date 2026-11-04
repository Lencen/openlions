"use client";
// Agent 活跃度区块 - client 组件 (无状态, 直接渲染 props)
// 2026-06-06 P3 修复: 之前 useState + client fetch 造成 hydration mismatch
// 改成纯渲染 props, 任何数据变化靠 router.refresh() 触发 server re-render
import { useEffect, useState } from "react";
import { THEMES, type ThemeMode } from "@/lib/theme";

interface SummaryData {
  recallByAgent: Record<string, number>;
  rememberByAgent: Record<string, number>;
  hotBySource: Record<string, { count: number; percent: number }>;
  hotTotal: number;
  recallTotal: number;
  rememberTotal: number;
  windowHours: number;
}

export default function AgentActivitySection({
  initial,
  error: initialError,
}: {
  initial: SummaryData | null;
  error?: string | null;
}) {
  // P3 修复: 不存 data state, 直接用 initial (server 注水).
  // 这样 hydration 时 React 看到的就是 server 注水值, 不会重置.
  const data = initial;
  const error = initialError ?? null;

  // 主题色 — 读 data-theme attribute 决定
  const [resolved, setResolved] = useState<"dark" | "light">("dark");
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => {
      const t = document.documentElement.getAttribute("data-theme");
      setResolved(t === "light" ? "light" : "dark");
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  const C = THEMES[resolved];

  // 60s 后触发 router.refresh 重新 fetch 数据
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = setInterval(() => {
      window.dispatchEvent(new Event("lions-refresh-data"));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: C.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8 }}>
          🛸 Agent 活跃度 ({data?.windowHours ?? 24}h)
        </div>
        {data && (
          <span style={{ fontSize: 10, color: C.muted }}>
            recall {data.recallTotal} · remember {data.rememberTotal} · HOT {data.hotTotal}
          </span>
        )}
        {error && (
          // P3-2: 即便有 error 也注水了空数据,这里只是软提示不阻塞 UI
          <span style={{ fontSize: 10, color: C.muted }} title={error}>· {data?.recallTotal === 0 && data?.rememberTotal === 0 ? "暂无数据" : "部分数据"}</span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: 12 }}>
        {/* Recall 表格 */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
            🔄 Recall (FlywheelEvent)
          </div>
          {data ? Object.entries(data.recallByAgent)
            .filter(([_, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([src, n]) => {
              const total = data.recallTotal || 1;
              return (
                <div key={src} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 11 }}>
                  <span style={{ width: 130, color: C.text, fontFamily: "monospace" }}>{src}</span>
                  <div style={{ flex: 1, height: 6, background: C.surface2, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${(n / total) * 100}%`, height: "100%", background: C.primary }} />
                  </div>
                  <span style={{ color: C.muted, minWidth: 30, textAlign: "right" }}>{n}</span>
                </div>
              );
            })
            : <div style={{ fontSize: 11, color: C.muted, padding: 12 }}>无数据</div>}
        </div>

        {/* Remember 表格 */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
            ✍️ Remember (Memory 新增)
          </div>
          {data ? Object.entries(data.rememberByAgent)
            .filter(([_, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([src, n]) => {
              const total = data.rememberTotal || 1;
              return (
                <div key={src} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 11 }}>
                  <span style={{ width: 130, color: C.text, fontFamily: "monospace" }}>{src}</span>
                  <div style={{ flex: 1, height: 6, background: C.surface2, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${(n / total) * 100}%`, height: "100%", background: C.accent }} />
                  </div>
                  <span style={{ color: C.muted, minWidth: 30, textAlign: "right" }}>{n}</span>
                </div>
              );
            })
            : <div style={{ fontSize: 11, color: C.muted, padding: 12 }}>无数据</div>}
        </div>

        {/* HOT 按 agentSource 饼图 (SVG) */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
            🔥 HOT 记忆按 agentSource
          </div>
          {data ? <HotPie data={data.hotBySource} C={C} /> : <div style={{ fontSize: 11, color: C.muted }}>无数据</div>}
        </div>
      </div>
    </div>
  );
}

function HotPie({ data, C }: { data: Record<string, { count: number; percent: number }>; C: any }) {
  const entries = Object.entries(data).filter(([_, v]) => v.count > 0);
  const total = entries.reduce((a, b) => a + b[1].count, 0);
  if (total === 0) return <div style={{ fontSize: 11, color: C.muted }}>无 HOT 数据</div>;
  const colors = [C.primary, C.accent, C.success, C.warning, C.error || "#ef4444", "#a855f7", "#ec4899", "#64748b"];
  let cumAngle = 0;
  const slices = entries.map(([src, v], i) => {
    const angle = (v.count / total) * 360;
    const startRad = ((cumAngle - 90) * Math.PI) / 180;
    const endRad = (((cumAngle + angle) - 90) * Math.PI) / 180;
    cumAngle += angle;
    const x1 = 60 + 50 * Math.cos(startRad);
    const y1 = 60 + 50 * Math.sin(startRad);
    const x2 = 60 + 50 * Math.cos(endRad);
    const y2 = 60 + 50 * Math.sin(endRad);
    const largeArc = angle > 180 ? 1 : 0;
    const path = angle >= 360
      ? `M 10 60 A 50 50 0 1 1 110 60 A 50 50 0 1 1 10 60 Z`
      : `M 60 60 L ${x1} ${y1} A 50 50 0 ${largeArc} 1 ${x2} ${y2} Z`;
    return { src, count: v.count, percent: v.percent, color: colors[i % colors.length], path };
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <svg width={120} height={120} viewBox="0 0 120 120" style={{ flexShrink: 0 }}>
        {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} stroke={C.bg} strokeWidth={1} />)}
        <circle cx={60} cy={60} r={28} fill={C.cardBg} />
        <text x={60} y={56} textAnchor="middle" fill={C.muted} fontSize={9}>HOT</text>
        <text x={60} y={70} textAnchor="middle" fill={C.text} fontSize={14} fontWeight={700}>{total}</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, flex: 1, minWidth: 0 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ color: C.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.src}</span>
            <span style={{ color: C.muted }}>{s.percent.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
