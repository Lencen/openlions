"use client";
/**
 * ListPagination — 统一 4 个列表的分页控件
 *  P1-7 修复: tasks / problems / reflections / mind reflection 4 个列表分页不一致
 *  设计:
 *  - 总数 + 当前页/总页数
 *  - pageSize 选择 (20/50/100/200)
 *  - 翻页按钮 (上/下/首页/末页)
 *  - 跳页输入
 *  - 颜色风格跟项目一致的 cyan (task 端) / purple (mind 端)
 */
import { useState } from "react";

export type PaletteName = "cyan" | "purple";

const PALETTES: Record<PaletteName, { accent: string; bg: string; border: string; muted: string; mutedText: string }> = {
  cyan: { accent: "#00d4ff", bg: "rgba(0,212,255,0.15)", border: "rgba(0,212,255,0.3)", muted: "rgba(100,116,139,0.2)", mutedText: "#475569" },
  purple: { accent: "#667eea", bg: "rgba(102,126,234,0.15)", border: "rgba(102,126,234,0.3)", muted: "rgba(100,116,139,0.2)", mutedText: "#475569" },
};

export interface ListPaginationProps {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** 名称, e.g. "任务" / "问题" / "反思" / "反思记录" */
  noun?: string;
  palette?: PaletteName;
  pageSizeOptions?: number[];
}

export default function ListPagination({
  total, page, pageSize, onPageChange, onPageSizeChange,
  noun = "条", palette = "cyan", pageSizeOptions = [20, 50, 100, 200],
}: ListPaginationProps) {
  const p = PALETTES[palette];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [jumpTo, setJumpTo] = useState("");

  const btnStyle = (disabled: boolean) => ({
    padding: "6px 12px",
    background: disabled ? p.muted : p.bg,
    border: `1px solid ${disabled ? p.muted : p.border}`,
    color: disabled ? p.mutedText : p.accent,
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    fontFamily: "inherit",
  } as const);

  const onJump = () => {
    const n = parseInt(jumpTo);
    if (!isNaN(n) && n >= 1 && n <= totalPages) {
      onPageChange(n);
      setJumpTo("");
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, padding: "12px 16px", background: p.bg, border: `1px solid ${p.border}`, borderRadius: 8, flexWrap: "wrap", gap: 12 }}>
      <span style={{ color: "#64748b", fontSize: 12 }}>
        共 <strong style={{ color: p.accent }}>{total}</strong> {noun}, 第 <strong style={{ color: p.accent }}>{page}</strong> / <strong style={{ color: p.accent }}>{totalPages}</strong> 页
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: "#64748b", fontSize: 12 }}>每页</span>
        <select
          value={pageSize}
          onChange={(e) => { onPageSizeChange(parseInt(e.target.value)); onPageChange(1); }}
          style={{ padding: "4px 8px", background: p.bg, border: `1px solid ${p.border}`, color: p.accent, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}
        >
          {pageSizeOptions.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button onClick={() => onPageChange(1)} disabled={page <= 1} style={btnStyle(page <= 1)}>« 首页</button>
        <button onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1} style={btnStyle(page <= 1)}>← 上一页</button>
        <input
          type="number" min={1} max={totalPages} value={jumpTo}
          onChange={(e) => setJumpTo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onJump()}
          placeholder="跳页"
          style={{ width: 60, padding: "4px 8px", background: p.bg, border: `1px solid ${p.border}`, color: p.accent, borderRadius: 4, fontSize: 12, fontFamily: "inherit", textAlign: "center" }}
        />
        <button onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages} style={btnStyle(page >= totalPages)}>下一页 →</button>
        <button onClick={() => onPageChange(totalPages)} disabled={page >= totalPages} style={btnStyle(page >= totalPages)}>末页 »</button>
      </div>
    </div>
  );
}
