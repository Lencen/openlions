"use client";
// 2026-10-13 round 76-U: console 版 useThemeColors —— 给 echarts(canvas) 解析真实主题色。
// 为什么需要: echarts 是 canvas, 不解析 CSS var(); EChart.tsx 里原本硬编码亮色主题值
//   (axisLabel #94a3b8 / tooltip 白底), 亮色主题下轴标签对比度偏低, 且切主题不跟随。
// 做法: 读 :root 上的真实色值, MutationObserver 监听 <html data-theme> 切换后重算。
// 参考平台 skill: docs/skills-mirror/ut_dev-patterns/echarts-csstoken-pitfall
import { useState, useEffect, useRef } from "react";

const KEYS = ["text", "textDim", "text3", "textMuted", "bgSurface", "bgSurface2", "border", "borderHi", "primary", "statusOk", "statusWarn", "statusCrit", "info", "tableMemory", "tableKnowledge", "tablePractice", "tableReflection", "tableSkill"] as const;
export type ConsoleThemeColorKey = (typeof KEYS)[number];

const DEFAULTS: Record<ConsoleThemeColorKey, string> = {
  text: "#1e293b", textDim: "#475569", text3: "#6E6E78", textMuted: "#94a3b8",
  bgSurface: "#ffffff", bgSurface2: "#f1f5f9", border: "rgba(0,0,0,0.08)", borderHi: "rgba(0,0,0,0.15)",
  primary: "#2563eb", statusOk: "#16a34a", statusWarn: "#d97706", statusCrit: "#dc2626", info: "#0F6FA8",
  tableMemory: "#0d9488", tableKnowledge: "#7c3aed", tablePractice: "#d97706", tableReflection: "#db2777", tableSkill: "#2563eb",
};

const CSS_NAME: Record<ConsoleThemeColorKey, string> = {
  text: "--text", textDim: "--text-dim", text3: "--text-3", textMuted: "--text-muted",
  bgSurface: "--bg-surface", bgSurface2: "--bg-surface2", border: "--border", borderHi: "--border-hi",
  primary: "--primary", statusOk: "--status-ok", statusWarn: "--status-warn", statusCrit: "--status-crit", info: "--info",
  tableMemory: "--table-memory", tableKnowledge: "--table-knowledge", tablePractice: "--table-practice", tableReflection: "--table-reflection", tableSkill: "--table-skill",
};

export function useThemeColors(): Record<ConsoleThemeColorKey, string> {
  const [colors, setColors] = useState<Record<ConsoleThemeColorKey, string>>(DEFAULTS);
  const lastRef = useRef("");
  useEffect(() => {
    const compute = () => {
      const cs = getComputedStyle(document.documentElement);
      const next: Record<string, string> = {};
      for (const k of KEYS) {
        const raw = cs.getPropertyValue(CSS_NAME[k]).trim();
        next[k] = raw || DEFAULTS[k];
      }
      const key = JSON.stringify(next);
      if (key !== lastRef.current) { lastRef.current = key; setColors(next as Record<ConsoleThemeColorKey, string>); }
    };
    compute();
    const mo = new MutationObserver(compute);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => mo.disconnect();
  }, []);
  return colors;
}
