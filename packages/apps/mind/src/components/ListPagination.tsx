"use client";
/**
 * ListPagination — mind 端版本 (purple 主题)
 * 跟 task 端 ListPagination 设计一致, 但用紫色 (#667eea) 匹配 mind 端
 *  P1-7 修复: 4 个列表分页控件统一
 */
import { useState } from "react";

export interface ListPaginationProps {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  noun?: string;
  pageSizeOptions?: number[];
}

export default function ListPagination({
  total, page, pageSize, onPageChange, onPageSizeChange,
  noun = "条", pageSizeOptions = [20, 50, 100, 200],
}: ListPaginationProps) {
  const accent = "#667eea";
  const bg = "rgba(102,126,234,0.15)";
  const border = "rgba(102,126,234,0.3)";
  const muted = "rgba(100,116,139,0.2)";
  const mutedText = "#475569";

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [jumpTo, setJumpTo] = useState("");

  const btnStyle = (disabled: boolean) => ({
    padding: "6px 12px",
    background: disabled ? muted : bg,
    border: `1px solid ${disabled ? muted : border}`,
    color: disabled ? mutedText : accent,
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
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, padding: "12px 16px", background: bg, border: `1px solid ${border}`, borderRadius: 8, flexWrap: "wrap", gap: 12 }}>
      <span style={{ color: "#64748b", fontSize: 12 }}>
        共 <strong style={{ color: accent }}>{total}</strong> {noun}, 第 <strong style={{ color: accent }}>{page}</strong> / <strong style={{ color: accent }}>{totalPages}</strong> 页
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: "#64748b", fontSize: 12 }}>每页</span>
        <select
          value={pageSize}
          onChange={(e) => { onPageSizeChange(parseInt(e.target.value)); onPageChange(1); }}
          style={{ padding: "4px 8px", background: bg, border: `1px solid ${border}`, color: accent, borderRadius: 4, fontSize: 12, fontFamily: "inherit" }}
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
          style={{ width: 60, padding: "4px 8px", background: bg, border: `1px solid ${border}`, color: accent, borderRadius: 4, fontSize: 12, fontFamily: "inherit", textAlign: "center" }}
        />
        <button onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages} style={btnStyle(page >= totalPages)}>下一页 →</button>
        <button onClick={() => onPageChange(totalPages)} disabled={page >= totalPages} style={btnStyle(page >= totalPages)}>末页 »</button>
      </div>
    </div>
  );
}
