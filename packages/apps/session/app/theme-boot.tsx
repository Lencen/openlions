"use client";
import { useEffect } from "react";

const KEY = "lions-session-theme";

export default function ThemeBoot() {
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) document.body.setAttribute("data-theme", saved);
    } catch {
      // 隐私模式/禁用存储时 localStorage 读取会抛 —— 读不到就保持默认主题(与修复前同样静默吞掉)
    }
  }, []);
  return null;
}
