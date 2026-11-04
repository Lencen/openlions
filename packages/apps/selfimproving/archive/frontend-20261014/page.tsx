"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { THEMES, loadThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme";
// P3-3 修复: 不要用 next/dynamic 包 server component — next.js 14 反模式,
// dynamic({ssr:true}) 会让 server-fetched data 丢失, client hydration 用空 props 重渲染
// 改为直接 static import, 让 Next.js App Router 原生处理 server component 内嵌 use client 子组件
import AgentActivityServer from "./_components/AgentActivityServer";

interface NavCard {
  href: string;
  emoji: string;
  title: string;
  desc: string;
  tags: string[];
  category: "DATA" | "OPS" | "PRODUCT" | "MIND";
}

const NAV: NavCard[] = [
  { href: "/dashboard", emoji: "📊", title: "Dashboard", desc: "KPI / 飞轮 / 引擎 / 实时", tags: ["数据驾驶舱", "KPI", "WebSocket"], category: "DATA" },
  { href: "/health", emoji: "🩺", title: "系统健康面板", desc: "10 维度 SRE 视角 + 告警 + 主题切换", tags: ["SRE", "10 维度", "主题切换"], category: "OPS" },
  { href: "/tasks", emoji: "📋", title: "Task 列表", desc: "任务队列 + 详情页含 V3 结构化上下文", tags: ["PENDING", "聚类", "上下文"], category: "OPS" },
  { href: "/tasks/new", emoji: "➕", title: "新建 Task", desc: "手动创建任务", tags: ["手动", "规划"], category: "OPS" },
  { href: "http://localhost:3004/flywheel/reflections", emoji: "🪞", title: "Reflections", desc: "认知系统的反思沉淀 (Console)", tags: ["Mind", "V3 结构化"], category: "MIND" },
  { href: "/problems", emoji: "🧩", title: "Problems", desc: "问题池 + 自动解决器", tags: ["自动解决", "问题驱动"], category: "MIND" },
  { href: "/reviews", emoji: "🔍", title: "Reviews", desc: "任务评审记录", tags: ["评审", "质量"], category: "DATA" },
  { href: "http://localhost:3000", emoji: "🧠", title: "LIONS-Mind", desc: "认知状态管理平台(3000 端口)", tags: ["外部", "Mind"], category: "MIND" },
];

const CATEGORY_LABELS: Record<string, string> = {
  DATA: "数据驾驶舱",
  OPS: "运营操作",
  MIND: "认知与反思",
};

export default function HomePage() {
  // URL 参数优先级最高(?theme=light/dark/system),其次 localStorage
  const router = useRouter();
  // P3 修复: 初始值硬编码 "dark" 跟 SSR 一致, hydration 后 useEffect 再读 localStorage
  // 避免 "Text content does not match server-rendered HTML" 错
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [systemNow, setSystemNow] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const urlT = new URLSearchParams(window.location.search).get("theme") as ThemeMode | null;
    const realMode = (urlT && ["dark", "light", "system"].includes(urlT))
      ? urlT
      : loadThemeMode();
    setModeState(realMode);
    setSystemNow(window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const h = (e: MediaQueryListEvent) => setSystemNow(e.matches ? "light" : "dark");
    mq.addEventListener?.("change", h);
    return () => mq.removeEventListener?.("change", h);
  }, []);
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", mode === "system" ? systemNow : mode);
    }
  }, [mode, systemNow]);

  // P3 修复: 监听 AgentActivitySection 的 lions-refresh-data 事件
  // 触发 router.refresh() 重新跑 server component, 重新 fetch agent-activity 数据
  // 避免 client fetch mind 跨域 + 端口写死
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      router.refresh();
    };
    window.addEventListener("lions-refresh-data", handler);
    return () => window.removeEventListener("lions-refresh-data", handler);
  }, [router]);
  const resolved: "dark" | "light" = mode === "system" ? systemNow : (mode as "dark" | "light");
  const setMode = (m: ThemeMode) => { setModeState(m); saveThemeMode(m); };
  const C = THEMES[resolved];
  const [stats, setStats] = useState({ tasks: 0, problems: 0, wsConnected: false });

  // 简单 stats 拉取
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/trpc/dashboard.overview");
        const j = await r.json();
        if (alive && j?.result?.data) {
          const d = j.result.data;
          setStats({
            tasks: d.kpi?.pending ?? 0,
            problems: 0,
            wsConnected: true,
          });
        }
      } catch {}
    };
    load();
    return () => { alive = false; };
  }, []);

  const ThemeBtn = ({ m, icon, label }: { m: ThemeMode; icon: string; label: string }) => (
    <button
      onClick={() => setMode(m)}
      title={label}
      style={{
        background: mode === m ? C.primary : "transparent",
        color: mode === m ? (resolved === "dark" ? "var(--bg-base)" : "var(--ink-primary)") : C.text,
        border: `1px solid ${mode === m ? C.primary : C.border}`,
        padding: "4px 10px",
        borderRadius: 6,
        fontSize: 13,
        cursor: "pointer",
        transition: "all 0.15s",
        fontWeight: mode === m ? 700 : 500,
      }}
    >
      {icon} {label}
    </button>
  );

  const groupedNav: Record<string, NavCard[]> = NAV.reduce((acc, c) => {
    (acc[c.category] ||= []).push(c);
    return acc;
  }, {} as Record<string, NavCard[]>);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, padding: "32px 48px", backgroundImage: C.bgGradient }}>
      {/* 顶栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1280, margin: "0 auto", marginBottom: 32 }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, background: `linear-gradient(135deg, ${C.primary} 0%, ${C.accent} 100%)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              🦁 LIONS Operations Console
            </h1>
            <span style={{ fontSize: 11, color: C.muted, fontFamily: "monospace" }}>v3.0.0 · V3 反思引擎</span>
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
            反思 → 聚类 → 上下文组装 → 任务执行 — 自进化的认知运维平台
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <ThemeBtn m="dark" icon="🌙" label="暗色" />
          <ThemeBtn m="light" icon="☀️" label="亮色" />
          <ThemeBtn m="system" icon="⚙" label="跟随" />
        </div>
      </div>

      {/* 概览数据条 */}
      <div style={{ maxWidth: 1280, margin: "0 auto 32px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { label: "V3 反思引擎", value: "✓ 运行", color: C.success },
          { label: "主题", value: resolved === "dark" ? "🌙 暗色" : "☀️ 亮色", color: C.primary },
          { label: "WS 实时", value: stats.wsConnected ? "已连接" : "未连接", color: stats.wsConnected ? C.success : C.muted },
          { label: "待处理 Task", value: String(stats.tasks), color: stats.tasks > 0 ? C.warning : C.muted },
        ].map((s, i) => (
          <div key={i} style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px" }}>
            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{s.label}</div>
            <div style={{ fontSize: 18, color: s.color, fontWeight: 700, marginTop: 4 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Agent 活跃度 (24h) — P0-23b (服务端预取 + 注水) */}
      <AgentActivityServer />

      {/* 导航卡片 */}
      {Object.entries(groupedNav).map(([cat, cards]) => (
        <div key={cat} style={{ maxWidth: 1280, margin: "0 auto", marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: C.muted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 12 }}>
            {CATEGORY_LABELS[cat] || cat}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {cards.map((c) => (
              <Link
                key={c.href}
                href={c.href}
                target={c.href.startsWith("http") ? "_blank" : undefined}
                style={{ textDecoration: "none" }}
              >
                <div
                  style={{
                    background: C.cardBg,
                    border: `1px solid ${C.border}`,
                    borderRadius: 10,
                    padding: 18,
                    cursor: "pointer",
                    transition: "all 0.2s",
                    height: "100%",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = C.borderHi;
                    e.currentTarget.style.background = C.rowHover;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = C.border;
                    e.currentTarget.style.background = C.cardBg;
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 20 }}>{c.emoji}</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{c.title}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.6, marginBottom: 10 }}>{c.desc}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {c.tags.map((t) => (
                      <span key={t} style={{ fontSize: 10, color: C.muted, background: C.surface2, padding: "2px 6px", borderRadius: 4, border: `1px solid ${C.border}` }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}

      {/* 底部 */}
      <div style={{ maxWidth: 1280, margin: "0 auto", marginTop: 48, padding: "16px 0", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted }}>
        <div>LIONS Self-Improving Task · 端口 3001</div>
        <div>主题: {mode === "system" ? "跟随系统" : mode === "dark" ? "暗色" : "亮色"} · 实际: {resolved}</div>
      </div>
    </div>
  );
}
