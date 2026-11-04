"use client";
// 2026-10-22 平台统一主题切换（无外部依赖，portal/session/mind/selfimproving 共用同一份实现）。
// 与 console 的 Radix 版行为一致：只切 data-theme（换值不换名），选择持久在 localStorage。
// 兼容历史 key：lions-session-theme（session 旧实现）。
import { useEffect, useState } from "react";

export const THEME_KEY = "lions-theme";
export const LEGACY_SESSION_KEY = "lions-session-theme";
export const THEMES = ["light", "dark", "hc"] as const;
export type ThemeName = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeName = "dark";

const LABEL: Record<ThemeName, string> = { light: "浅色", dark: "深色", hc: "高对比" };

/** 防 FOUC：在 <head> 内联执行，先于 React 挂载设置 data-theme（与 console 同口径：dark-first）。 */
export const THEME_PREPAINT_SCRIPT =
  "(function(){try{" +
  "var s=localStorage.getItem(\"" + THEME_KEY + "\")||localStorage.getItem(\"" + LEGACY_SESSION_KEY + "\");" +
  "var t=(s===\"light\"||s===\"dark\"||s===\"hc\")?s:(window.matchMedia&&window.matchMedia(\"(prefers-color-scheme: light)\").matches?\"light\":\"dark\");" +
  "document.documentElement.setAttribute(\"data-theme\",t);" +
  "}catch(e){}})()" as any;

function apply(theme: ThemeName) {
  document.documentElement.setAttribute("data-theme", theme);
  // session 的主题挂在 body 上，两处都设，保证两种写法都能生效
  if (document.body) document.body.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { void 0; }
}

export default function ThemeToggleLite() {
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME);
  useEffect(() => {
    const cur = document.documentElement.getAttribute("data-theme") as ThemeName | null;
    if (cur && (THEMES as readonly string[]).includes(cur)) setTheme(cur as ThemeName);
  }, []);
  return (
    <div className="theme-toggle" role="group" aria-label="主题切换">
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          className={"theme-toggle-btn" + (theme === t ? " active" : "")}
          aria-pressed={theme === t}
          onClick={() => { setTheme(t); apply(t); }}
          title={LABEL[t]}
        >
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}
