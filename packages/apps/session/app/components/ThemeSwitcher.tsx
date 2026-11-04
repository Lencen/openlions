"use client";
import { useEffect, useState } from "react";

const KEY = "lions-session-theme";
const THEMES = [
  { id: "archive-light", label: "LIGHT", enabled: true },
  { id: "archive-dark", label: "DARK", enabled: true },
  { id: "archive-glass", label: "GLASS", enabled: false },
  { id: "archive-mono", label: "MONO", enabled: false },
];

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<string>("archive-light");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) setTheme(saved);
    } catch {
      // 隐私模式/禁用存储时读取会抛 —— 忽略, 用默认主题(不阻断渲染)
    }
  }, []);
  function pick(t: string) {
    setTheme(t);
    document.body.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch {
      // 写入失败(隐私模式/配额): 主题已应用到 DOM, 只是下次刷新不记住 —— 故意不报错
    }
  }
  return (
    <div className="theme-switcher">
      {THEMES.map((t) => (
        <button
          key={t.id}
          className={theme === t.id ? "active" : ""}
          disabled={!t.enabled}
          onClick={() => t.enabled && pick(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
