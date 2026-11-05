"use client";
/**
 * FilterBar — 白名单组件（P0）
 * 规则：视图分段 + 筛选 chips + 右侧只读说明；筛选是读操作，页面上不出现写控件。
 */
import type { ReactNode } from "react";

export interface FilterItem {
  key: string;
  label: string;
  count?: number;
}

export interface FilterBarProps {
  items: FilterItem[];
  active?: string;
  onSelect?: (key: string) => void;
  right?: ReactNode;
}

export default function FilterBar({ items, active, onSelect, right }: FilterBarProps) {
  return (
    <div className="toolbar">
      <div className="filters">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={"filter" + (it.key === active ? " on" : "")}
            onClick={() => onSelect?.(it.key)}
          >
            {it.label}
            {typeof it.count === "number" ? <span className="n">{it.count}</span> : null}
          </button>
        ))}
      </div>
      <span className="spacer" />
      {right ? <span className="tiny">{right}</span> : null}
    </div>
  );
}
