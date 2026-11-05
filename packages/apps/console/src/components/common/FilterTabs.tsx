"use client";
// 公共控件 (2026-09-14 页面瘦身): 药丸式标签筛选条。
// 抽取动机: 待办中心 / 飞轮任务列表都用同一段内联样式手搓 tab 按钮, 这里统一外观与计数展示。
// 2026-11-05 P2 呈现层改造: 容器与按钮的内联样式清零, 改 FilterTabs.module.css;
//   选中态用 data-active 属性选择器表达（不再是按 active 现拼 style 对象）。
import { fmtNum } from "@/lib/format";
import styles from "./FilterTabs.module.css";

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
    <div className={styles.tabs}>
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={styles.tab}
            data-active={active ? "true" : "false"}
          >
            {t.label}
            {t.count != null ? " " + fmtNum(t.count) : ""}
          </button>
        );
      })}
    </div>
  );
}
