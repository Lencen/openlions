"use client";
/**
 * ThemeToggle.tsx — 三主题切换（light | dark | hc）
 *
 * 2026-10-22 重构：从 Radix DropdownMenu 换成**无依赖分段按钮**。原因有二：
 *   1) Radix 菜单在仓库里没有任何样式，深色下白底浅字（axe 对比度 1.05，唯一剩余 serious）；
 *   2) portal/session 已经用同一份无依赖实现，统一后三端切换器外观一致。
 * 口径不变：只切 data-theme（换值不换名），选择持久在 localStorage("lions-theme")。
 */
import { useEffect, useState } from "react";

export const THEME_KEY = "lions-theme";
export const THEMES = ["light", "dark", "hc"] as const;
export type ThemeName = (typeof THEMES)[number];

/** 默认主题: 拍板 #2 dark-first */
export const DEFAULT_THEME: ThemeName = "dark";

const LABEL: Record<ThemeName, string> = { light: "浅色", dark: "深色", hc: "高对比" };

export const THEME_PREPAINT_SCRIPT =
  "(function(){try{" +
  "var k=\"" + THEME_KEY + "\";" +
  "var s=localStorage.getItem(k);" +
  "var t;" +
  "if(s===\"light\"||s===\"dark\"||s===\"hc\"){t=s;}" +
  "else{" +
  "  try{" +
  "    if(window.matchMedia&&window.matchMedia(\"(prefers-contrast: more)\").matches){t=\"hc\";}" +
  "    else if(window.matchMedia&&window.matchMedia(\"(prefers-color-scheme: light)\").matches){t=\"light\";}" +
  "    else{t=\"dark\";}" +
  "  }catch(e){t=\"dark\";}" +
  "}" +
  "document.documentElement.setAttribute(\"data-theme\",t);" +
  // 2026-10-25 R8：密度也在 prepaint 阶段应用，避免挂载后再切造成位移
  "try{var dn=localStorage.getItem(\"lions-console-density\");" +
  "document.documentElement.setAttribute(\"data-density\", dn===\"compact\"?\"compact\":\"comfortable\");}catch(e2){}" +
  "}catch(e){}})()" as any;

function applyTheme(theme: ThemeName) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { void 0; }
}

export default function ThemeToggle() {
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
          onClick={() => { setTheme(t); applyTheme(t); }}
          title={LABEL[t]}
        >
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}
