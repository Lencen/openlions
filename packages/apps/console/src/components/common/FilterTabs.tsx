"use client";
// 公共控件 (2026-09-14 页面瘦身): 药丸式标签筛选条。
// 抽取动机: 待办中心 / 飞轮任务列表都用同一段内联样式手搓 tab 按钮, 这里统一外观与计数展示。
import { fmtNum } from "@/lib/format";

export interface FilterTab {
  key: string;
  label: string;
  count?: number;
}

export default function FilterTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: FilterTab[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "var(--sp-1-5)", flexWrap: "wrap" }}>
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              padding: "var(--sp-1) var(--sp-3)",
              borderRadius: "var(--radius-lg)",
              fontSize: "var(--fs-base)",
              cursor: "pointer",
              border: "1px solid " + (active ? "var(--primary)" : "var(--border)"),
              background: active ? "var(--primary-dim)" : "transparent",
              color: active ? "var(--primary)" : "inherit",
              fontWeight: active ? 600 : 400,
            }}
          >
            {t.label}
            {t.count != null ? " " + fmtNum(t.count) : ""}
          </button>
        );
      })}
    </div>
  );
}
