"use client";

import { useEffect, useState } from "react";
import { THEMES, loadThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme";

/**
 * 浮动主题切换器 — 跨页面可用
 *
 * 固定在右下角(不影响页面布局)
 * 点击切换 dark / light / system
 * 与 localStorage 同步(与 health/root page 共用 key)
 *
 * P3 修复: 初始 mode 强制 "dark" (跟 SSR 一致), hydration 后 useEffect 再读 localStorage
 * 避免 "Text content does not match server-rendered HTML" 错
 */
export function FloatingThemeSwitcher() {
  // 初始值硬编码 "dark" — 跟 server 渲染一致 (server 看不到 localStorage)
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [hydrated, setHydrated] = useState(false);
  const [systemNow, setSystemNow] = useState<"dark" | "light">("dark");
  const [open, setOpen] = useState(false);

  // hydration 后从 localStorage 读真实 mode
  useEffect(() => {
    const urlT = new URLSearchParams(window.location.search).get("theme") as ThemeMode | null;
    const realMode = (urlT && ["dark", "light", "system"].includes(urlT))
      ? urlT
      : loadThemeMode();
    setModeState(realMode);
    setSystemNow(window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
    setHydrated(true);
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

  const resolved: "dark" | "light" = mode === "system" ? systemNow : (mode as "dark" | "light");
  const C = THEMES[resolved];
  const setMode = (m: ThemeMode) => { setModeState(m); saveThemeMode(m); };

  const Btn = ({ m, icon, label }: { m: ThemeMode; icon: string; label: string }) => (
    <button
      onClick={() => { setMode(m); }}
      title={label}
      style={{
        background: mode === m ? C.primary : "transparent",
        color: mode === m ? (resolved === "dark" ? "#0a0e1a" : "#fff") : C.text,
        border: `1px solid ${mode === m ? C.primary : C.border}`,
        padding: "4px 8px",
        borderRadius: 6,
        fontSize: 12,
        cursor: "pointer",
        fontWeight: mode === m ? 700 : 500,
        whiteSpace: "nowrap",
        width: "100%",
        textAlign: "left",
      }}
    >
      {icon} {label}
    </button>
  );

  return (
    <div style={{ position: "fixed", bottom: 16, right: 16, zIndex: 9999 }}>
      {open && (
        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 8,
            marginBottom: 6,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            minWidth: 110,
            boxShadow: "0 4px 16px rgba(0,0,0,.25)",
          }}
        >
          <Btn m="dark" icon="🌙" label="暗色" />
          <Btn m="light" icon="☀️" label="亮色" />
          <Btn m="system" icon="⚙" label="跟随" />
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        title="切换主题"
        style={{
          background: C.surface,
          color: C.text,
          border: `1px solid ${C.borderHi}`,
          borderRadius: "50%",
          width: 44,
          height: 44,
          fontSize: 18,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 8px rgba(0,0,0,.2)",
        }}
      >
        {resolved === "dark" ? "🌙" : "☀️"}
      </button>
    </div>
  );
}
