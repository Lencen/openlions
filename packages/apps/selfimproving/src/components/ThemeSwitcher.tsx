"use client";

/**
 * 4 主题切换器 (Cognitive OS)
 * dark / light / glass / mono
 *
 * 顶栏右上角横排 pill 按钮, active 状态青绿底.
 * 切换: 改 documentElement[data-theme] + localStorage 持久化
 * SSR 安全: 初始值硬编码 "dark", hydration 后从 localStorage 读真实值
 *
 * 跨项目复用: lions-mind + lions-selfimproving-task
 */

import { useEffect, useState } from "react";

export type ThemeMode = "cognitive-os-dark" | "cognitive-os-light" | "cognitive-os-glass" | "cognitive-os-mono";

const THEMES: { mode: ThemeMode; icon: string; label: string }[] = [
  { mode: "cognitive-os-dark", icon: "🌙", label: "DARK" },
  { mode: "cognitive-os-light", icon: "☀️", label: "LIGHT" },
  { mode: "cognitive-os-glass", icon: "🪟", label: "GLASS" },
  { mode: "cognitive-os-mono", icon: "◾", label: "MONO" },
];

const STORAGE_KEY = "lions-theme-mode";

function loadThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "cognitive-os-dark";
  const stored = window.localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
  if (stored && THEMES.some((t) => t.mode === stored)) return stored;
  return "cognitive-os-dark";
}

function saveThemeMode(mode: ThemeMode) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, mode);
}

export function ThemeSwitcher() {
  // 初始值硬编码 (跟 SSR 一致, 避免 hydration mismatch)
  const [mode, setModeState] = useState<ThemeMode>("cognitive-os-dark");
  const [hydrated, setHydrated] = useState(false);

  // hydration 后读真实 mode
  useEffect(() => {
    const realMode = loadThemeMode();
    setModeState(realMode);
    document.documentElement.setAttribute("data-theme", realMode);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", mode);
    }
    if (hydrated) saveThemeMode(mode);
  }, [mode, hydrated]);

  const setMode = (m: ThemeMode) => setModeState(m);

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {THEMES.map((t) => (
        <button
          key={t.mode}
          onClick={() => setMode(t.mode)}
          title={t.label}
          className={`theme-btn ${mode === t.mode ? "active" : ""}`}
        >
          <span style={{ fontSize: 12 }}>{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}
