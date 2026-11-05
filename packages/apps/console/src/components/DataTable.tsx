"use client";
// 2026-10-25 R4：通用数据表格（组件三件套之一）
// 由来：智能体/会话/待办这类「一行一条记录」的页面此前用 110px 高的卡片堆叠，
//   5 条记录占满一屏、没有列对齐、状态标签漂在空白里、无法扫读（评审 §3-5）。
// 约束：只做展示（排序/筛选由页面上层控制）；数值列右对齐 + 等宽数字；
//   状态用「色点 + 文字」不只靠颜色（WCAG 1.4.1）。
// 2026-11-05 P2 呈现层改造：列宽 / 对齐 / 骨架宽度不再写内联 style，
//   改为 DataTable.module.css 里的档位类（.w40…w360 / .p0…p100 / .cellLeft/.cellRight）。
import type { ReactNode } from "react";
import styles from "./DataTable.module.css";

export interface DataColumn<T> {
  key: string;
  title: string;
  width?: string | number;
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

/** 列宽 -> 档位类（10px 一档；非像素值返回空，交给浏览器自适应） */
function widthClass(width?: string | number): string {
  if (width === undefined || width === null) return "";
  const n = Number(String(width).replace(/px$/, "").trim());
  if (!Number.isFinite(n) || n <= 0) return "";
  const step = Math.min(360, Math.max(40, Math.round(n / 10) * 10));
  return styles["w" + step] || "";
}

/** 骨架宽度 -> 档位类（5% 一档） */
function pctClass(pct: number): string {
  const step = Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
  return styles["p" + step] || "";
}

function alignClass(align?: "left" | "right"): string {
  return align === "right" ? "dt-num " + styles.cellRight : styles.cellLeft;
}

export default function DataTable<T>({ columns, rows, rowKey, loading, empty, error, onRetry }: DataTableProps<T>) {
  return (
    <div className="dt-wrap">
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={[widthClass(c.width), alignClass(c.align)].filter(Boolean).join(" ")}>{c.title}</th>
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
                  <td key={c.key}><div className={"dt-skel " + pctClass(40 + ((i * 17) % 40))} /></td>
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
                  <td key={c.key} className={alignClass(c.align)}>
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
