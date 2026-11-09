"use client";
// 2026-10-25 R4：通用数据表格（组件三件套之一）
// 由来：智能体/会话/待办这类「一行一条记录」的页面此前用 110px 高的卡片堆叠，
//   5 条记录占满一屏、没有列对齐、状态标签漂在空白里、无法扫读（评审 §3-5）。
// 约束：只做展示（排序/筛选由页面上层控制）；数值列右对齐 + 等宽数字；
//   状态用「色点 + 文字」不只靠颜色（WCAG 1.4.1）。
// 2026-11-05 P2 呈现层改造：列宽 / 对齐 / 骨架宽度不再写内联 style，
//   改为 DataTable.module.css 里的档位类（.w40…w360 / .p0…p100 / .cellLeft/.cellRight）。
import { Fragment, useState, type ReactNode } from "react";
import styles from "./DataTable.module.css";

export interface DataColumn<T> {
  key: string;
  title: string;
  width?: string | number;
  align?: "left" | "right";
  render?: (row: T, index: number) => ReactNode;
  /** 该列渲染成**行表头** `<th scope="row">`（2026-11-05 商业线裁决 D）。
   *  用途：热力图 / 键值表这类"首列是行名"的表，换掉原手写表后仍要保住行表头语义（WCAG 1.3.1）。 */
  rowHeader?: boolean;
}

/** 可展开行（2026-11-05 商业线裁决 D）：与原子件 primitives.Table 的 expandable 同形状，
 *  目的是让"必须原地展开"的表能留在白名单里，而不是绕过去用原子件。
 *  · expandedRowRender 是函数 —— 只能由**客户端组件**传；服务端组件传函数会触发 RSC 边界错误。 */
export interface DataTableExpandable<T> {
  expandedRowRender: (row: T, index: number) => ReactNode;
  /** 受控展开键；不传则组件自管（点一下开、再点关） */
  expandedRowKeys?: (string | number)[];
  onExpand?: (expanded: boolean, row: T) => void;
  /** 某行是否允许展开（默认全部允许） */
  rowExpandable?: (row: T) => boolean;
}

export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  /** 行 key：**可选**。2026-11-05 P2 批6 热修 —— 服务端组件不能把函数传给客户端组件，
   *  所以服务端页面只传数据、不传函数；不给 rowKey 时按行下标取 key（列表只做展示、无重排）。 */
  rowKey?: (row: T, index: number) => string | number;
  /** 加载中：渲染骨架行（不是空白） */
  loading?: boolean;
  /** 空态文案与动作；不给则用默认一句 */
  empty?: { title: string; desc?: string; action?: ReactNode };
  /** 错误态：给 onRetry 就显示「重试」 */
  error?: string | null;
  onRetry?: () => void;
  /** 行级交互（2026-11-05 P2 批6 补）：整行可点。
   *  · 只能由**客户端组件**传（"use client"）—— 服务端组件传函数会触发
   *    "Functions cannot be passed directly to Client Components"；
   *  · 键盘可达仍由行内的原生按钮承担（本组件不把 <tr> 做成可聚焦），
   *    所以这里只补鼠标点击与视觉提示，不改键盘路径。 */
  onRow?: (row: T, index: number) => { onClick?: () => void; className?: string };
  /** 可展开行；不给则完全是原来的纯展示表（默认行为零变化） */
  expandable?: DataTableExpandable<T>;
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

export default function DataTable<T>({ columns, rows, rowKey, loading, empty, error, onRetry, onRow, expandable }: DataTableProps<T>) {
  // 展开态：受控优先（expandedRowKeys），否则自管（与 primitives.Table 同语义）
  const [openKeys, setOpenKeys] = useState<(string | number)[]>([]);
  const keyOf = (r: T, i: number) => (rowKey ? rowKey(r, i) : i);
  const expandedKeys = expandable?.expandedRowKeys ?? openKeys;
  const toggleRow = (k: string | number, r: T) => {
    const has = expandedKeys.includes(k);
    if (!expandable?.expandedRowKeys) {
      setOpenKeys(has ? expandedKeys.filter((x) => x !== k) : [...expandedKeys, k]);
    }
    expandable?.onExpand?.(!has, r);
  };
  const colCount = columns.length + (expandable ? 1 : 0);
  return (
    <div className="dt-wrap">
      <table className="dt">
        <thead>
          <tr>
            {expandable ? <th key="__expand" className={styles.expandCol} /> : null}
            {columns.map((c) => (
              <th key={c.key} className={[widthClass(c.width), alignClass(c.align)].filter(Boolean).join(" ")}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr className="dt-state-row">
              <td colSpan={colCount}>
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
                {expandable ? <td className={styles.expandCol} /> : null}
                {columns.map((c) => (
                  <td key={c.key}><div className={"dt-skel " + pctClass(40 + ((i * 17) % 40))} /></td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr className="dt-state-row">
              <td colSpan={colCount}>
                <div className="dt-state">
                  <div className="dt-state-title">{empty?.title ?? "暂无数据"}</div>
                  {empty?.desc ? <div className="dt-state-desc">{empty.desc}</div> : null}
                  {empty?.action ?? null}
                </div>
              </td>
            </tr>
          ) : (
            rows.map((r, i) => {
              const rowProps = onRow ? onRow(r, i) : undefined;
              const k = keyOf(r, i);
              const canExpand = !!expandable && (!expandable.rowExpandable || expandable.rowExpandable(r));
              const isOpen = canExpand && expandedKeys.includes(k);
              return (
              <Fragment key={k}>
              <tr
                className={[rowProps && rowProps.onClick ? styles.rowClickable : "", rowProps?.className || ""].filter(Boolean).join(" ") || undefined}
                onClick={rowProps?.onClick}
              >
                {expandable ? (
                  <td className={styles.expandCol}>
                    {canExpand ? (
                      <button
                        type="button"
                        className={styles.expandBtn}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "收起详情" : "展开详情"}
                        onClick={(e) => { e.stopPropagation(); toggleRow(k, r); }}
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                    ) : null}
                  </td>
                ) : null}
                {columns.map((c) => {
                  const cell = c.render ? c.render(r, i) : (((r as any)[c.key] ?? "—") as ReactNode);
                  // 2026-11-05 热修：无 render 时直接渲染单元格值（可能是服务端预算好的 ReactNode），
                  //   不再 String() 强转 —— 否则服务端预渲染的 <span> 会变成 "[object Object]"。
                  return c.rowHeader ? (
                    <th key={c.key} scope="row" className={[alignClass(c.align), styles.rowHead].filter(Boolean).join(" ")}>{cell}</th>
                  ) : (
                    <td key={c.key} className={alignClass(c.align)}>{cell}</td>
                  );
                })}
              </tr>
              {isOpen ? (
                <tr className={styles.expandedRow}>
                  <td colSpan={colCount}>{expandable!.expandedRowRender(r, i)}</td>
                </tr>
              ) : null}
              </Fragment>
              );
            })
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
