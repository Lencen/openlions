// Stub theme module for legacy health/AgentActivitySection pages.
// Minimal shape — extend when those pages are rewritten.
export const THEME_STORAGE_KEY = "lions-mind-theme";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export interface Theme {
  bg: string;
  fg: string;
  ink: string;
  border: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  surface: string;
  // 遗留#8 (2026-09-01): 兼容 legacy health 页用的别名 (语义映射, 消除 69 个类型错误)
  text: string;
  dim: string;
  primary: string;
  alertBg: string;
  cfgBg: string;
  rowHover: string;
  borderHi: string;
  bgGradient: string;
  cardBg: string;
  surface2: string;
}

const dark: Theme = {
  bg: "#0a0a0a",
  fg: "#e5e5e5",
  ink: "#fafafa",
  border: "rgba(255,255,255,.08)",
  muted: "rgba(255,255,255,.5)",
  accent: "#3b82f6",
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
  surface: "#171717",
  text: "#e5e5e5",
  dim: "rgba(255,255,255,.5)",
  primary: "#3b82f6",
  alertBg: "rgba(239,68,68,.08)",
  cfgBg: "#111111",
  rowHover: "rgba(255,255,255,.04)",
  borderHi: "rgba(255,255,255,.15)",
  bgGradient: "linear-gradient(180deg,#0f172a,#0a0a0a)",
  cardBg: "#141414",
  surface2: "#1e1e1e",
};

const light: Theme = {
  bg: "#ffffff",
  fg: "#1a1a1a",
  ink: "#000",
  border: "rgba(0,0,0,.1)",
  muted: "rgba(0,0,0,.5)",
  accent: "#2563eb",
  success: "#16a34a",
  warning: "#d97706",
  error: "#dc2626",
  surface: "#f5f5f5",
  text: "#1a1a1a",
  dim: "rgba(0,0,0,.5)",
  primary: "#2563eb",
  alertBg: "rgba(220,38,38,.08)",
  cfgBg: "#eeeeee",
  rowHover: "rgba(0,0,0,.04)",
  borderHi: "rgba(0,0,0,.2)",
  bgGradient: "linear-gradient(180deg,#f8fafc,#ffffff)",
  cardBg: "#fafafa",
  surface2: "#eeeeee",
};

export const THEMES: Record<ResolvedTheme, Theme> = { dark, light };
