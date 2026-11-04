"use client";
// 2026-10-25 R4：通用数据表格（组件三件套之一）
// 由来：智能体/会话/待办这类「一行一条记录」的页面此前用 110px 高的卡片堆叠，
//   5 条记录占满一屏、没有列对齐、状态标签漂在空白里、无法扫读（评审 §3-5）。
// 约束：只做展示（排序/筛选由页面上层控制）；数值列右对齐 + 等宽数字；
//   状态用「色点 + 文字」不只靠颜色（WCAG 1.4.1）。
import type { ReactNode } from "react";

export interface DataColumn<T> {
  key: string;
  title: string;
  width?: string;
  align?: "left" | "right";
  render?: (row: T, index: number) => ReactNode;
}

export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** 加载中：渲染骨架行（不是空白） */
  loading?: boolean;
  /** 空态文案与动作；不给则用默认一句 */
  empty?: { title: string; desc?: string; action?: ReactNode };
  /** 错误态：给 onRetry 就显示「重试」 */
  error?: string | null;
  onRetry?: () => void;
}

export default function DataTable<T>({ columns, rows, rowKey, loading, empty, error, onRetry }: DataTableProps<T>) {
  return (
    <div className="dt-wrap">
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align === "right" ? "right" : "left" }}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr className="dt-state-row">
              <td colSpan={columns.length}>
                <div className="dt-state">
                  <div className="dt-state-title">数据暂时取不到</div>
                  <div className="dt-state-desc">列表本身可用，可重试；技术细节见页面底部。</div>
                  {onRetry ? <button className="btn" onClick={onRetry}>重试</button> : null}
                </div>
              </td>
            </tr>
          ) : loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={"sk" + i}>
                {columns.map((c) => (
                  <td key={c.key}><div className="dt-skel" style={{ width: `${40 + ((i * 17) % 40)}%` }} /></td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr className="dt-state-row">
              <td colSpan={columns.length}>
                <div className="dt-state">
                  <div className="dt-state-title">{empty?.title ?? "暂无数据"}</div>
                  {empty?.desc ? <div className="dt-state-desc">{empty.desc}</div> : null}
                  {empty?.action ?? null}
                </div>
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={rowKey(r, i)}>
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align === "right" ? "right" : "left" }}
                    className={c.align === "right" ? "dt-num" : undefined}>
                    {c.render ? c.render(r, i) : String((r as any)[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 状态片：色点 + 文字（不只靠颜色） */
export function StateChip({ state, text }: { state: "ok" | "warn" | "crit" | "idle"; text: string }) {
  return <span className="dt-chip" data-state={state}><i />{text}</span>;
}
