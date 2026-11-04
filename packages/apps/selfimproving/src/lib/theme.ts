/**
 * LIONS 主题系统 — 全局共享(dashboard / health / 详情页 / 导航 / 反思)
 *
 * 暗色风格: 青色/紫色/红色 (赛博风)
 * 亮色风格: 白底蓝紫 (Apple/Linear clean)
 * 跟随系统: prefers-color-scheme
 *
 * 用法:
 *   import { THEMES, useTheme } from "@/lib/theme";
 *   const { mode, resolved, setMode } = useTheme();
 *   const C = THEMES[resolved];
 *   <div style={{ background: C.bg, color: C.text }}>...</div>
 */
import { useState, useEffect } from "react";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  borderHi: string;
  primary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  text: string;
  muted: string;
  dim: string;
  bgGradient: string;
  cardBg: string;
  rowHover: string;
  alertBg: string;
  cfgBg: string;
}

export const THEMES: Record<ResolvedTheme, Theme> = {
  dark: {
    bg: "#0a0e1a",
    surface: "rgba(0,212,255,0.04)",
    surface2: "rgba(255,255,255,0.03)",
    border: "rgba(0,212,255,0.18)",
    borderHi: "rgba(0,212,255,0.4)",
    primary: "#00d4ff",
    accent: "#a855f7",
    success: "#10b981",
    warning: "#f59e0b",
    error: "#ef4444",
    text: "#e2e8f0",
    muted: "#64748b",
    dim: "#94a3b8",
    bgGradient: "radial-gradient(circle at 20% 0%, rgba(0,212,255,0.08) 0%, transparent 40%), radial-gradient(circle at 80% 100%, rgba(168,85,247,0.06) 0%, transparent 40%)",
    cardBg: "linear-gradient(135deg, rgba(0,212,255,0.04) 0%, rgba(255,255,255,0.03) 100%)",
    rowHover: "rgba(0,212,255,0.04)",
    alertBg: "rgba(0,0,0,.2)",
    cfgBg: "rgba(0,0,0,.25)",
  },
  light: {
    bg: "#f6f8fb",
    surface: "rgba(59,130,246,0.04)",
    surface2: "rgba(99,102,241,0.03)",
    border: "rgba(59,130,246,0.2)",
    borderHi: "rgba(59,130,246,0.45)",
    primary: "#2563eb",
    accent: "#7c3aed",
    success: "#059669",
    warning: "#d97706",
    error: "#dc2626",
    text: "#0f172a",
    muted: "#64748b",
    dim: "#475569",
    bgGradient: "radial-gradient(circle at 20% 0%, rgba(59,130,246,0.06) 0%, transparent 40%), radial-gradient(circle at 80% 100%, rgba(124,58,237,0.05) 0%, transparent 40%)",
    cardBg: "linear-gradient(135deg, rgba(59,130,246,0.04) 0%, rgba(99,102,241,0.03) 100%)",
    rowHover: "rgba(59,130,246,0.04)",
    alertBg: "rgba(59,130,241,0.04)",
    cfgBg: "rgba(241,245,249,0.7)",
  },
};

export const THEME_STORAGE_KEY = "lions-theme-mode";

/**
 * 从 localStorage + prefers-color-scheme 解析最终主题
 */
export function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

/**
 * 持久化主题模式
 */
export function saveThemeMode(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {}
}

/**
 * 读取持久化的主题模式
 */
export function loadThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {}
  return "dark";
}

/**
 * React hook: 主题模式 + 解析后主题(响应 system 切换)
 * URL ?theme=dark|light|system 优先级最高,其次 localStorage
 */
export function useTheme() {
  // 初始 mode: 优先 URL,否则 localStorage,否则 dark
  const initialMode = (() => {
    if (typeof window === "undefined") return "dark" as ThemeMode;
    const urlT = new URLSearchParams(window.location.search).get("theme") as ThemeMode | null;
    if (urlT && ["dark", "light", "system"].includes(urlT)) return urlT;
    return loadThemeMode();
  })();
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [systemNow, setSystemNow] = useState<"dark" | "light">(
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"
  );
  const resolved: "dark" | "light" = mode === "system" ? systemNow : (mode as "dark" | "light");

  // 监听 URL 变化(用户点不同 ?theme=)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      const urlT = new URLSearchParams(window.location.search).get("theme") as ThemeMode | null;
      if (urlT && ["dark", "light", "system"].includes(urlT)) {
        setModeState(urlT);
        return;
      }
      // 否则用 data-theme
      const dt = document.documentElement.getAttribute("data-theme") as "dark" | "light" | null;
      if (dt) setModeState(dt);
    };
    window.addEventListener("popstate", handler);
    // 监听 theme-init.js 触发的事件
    window.addEventListener("lions-theme-ready", ((e: CustomEvent) => handler()) as EventListener);
    // 定期检查(覆盖 pushState 不触发 popstate 的情况)
    const interval = setInterval(handler, 1000);
    // 立即跑一次
    handler();
    return () => {
      window.removeEventListener("popstate", handler);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemNow(e.matches ? "light" : "dark");
    };
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", resolved);
    }
  }, [resolved]);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    saveThemeMode(m);
  };

  return { mode, resolved, setMode };
}

// React imports via inline hooks (lib layer should not depend on React, but provide hook for client components)
