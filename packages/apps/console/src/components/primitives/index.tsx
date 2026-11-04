"use client";
// 2026-09-18 Phase2 antd 绞杀: 自研原子件层(primitives)。
//
// 目的: 让 console 不再需要 antd —— 之前 48 个文件直接从 antd 导入(见 UI 门 antd-zero 项), 且共用一份 components/ui.tsx 的原子件。
//   本模块提供**同 API 形状的自研实现**(纯 DOM + 主题 CSS 变量), 迁移时只改 import 路径:
//     - 从 antd 导入 Tooltip  ->  改从 "@/components/primitives" 导入 Tooltip(逐文件一行改动)
//   刻意不做的事: 不 re-export antd(那是假迁移), 不再引入第二套设计语言(样式全程用 --sp/--fs/--radius/--border/
//   --bg-surface*/--text*/--primary 主题变量, 三主题 light/dark/hc 自动跟随)。
//
// 分批判定标准(与 docs/platform-logic/task-decomposition-spec-2026-09-18.md G1/G3 一致):
//   一个文件一组、单文件 <=15 分钟、验收 = 该文件不再出现 antd 导入 + 3004 路由 200 + 附 commit
//   (注意: 本行**不能**写出那个被门扫描的导入片段, 否则这个文件自己会被算成 antd 引用 —— 已踩过)。
//
// 已实现(按 console 实际用量排序, 覆盖前 8 名): Tooltip(25) Tag(16) Button(14) Alert(9) Skeleton(6)
//   Empty(4) Card(4) Menu(2) + 图标 ReloadOutlined/CheckCircleOutlined/ExclamationCircleOutlined。
//   未实现组件在迁移到该文件时再补(不预先空写)。

import type { CSSProperties, ReactNode } from "react";
import { Fragment, cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState } from "react";

type Style = CSSProperties;

/* ────────────────────────── Tooltip ────────────────────────── */
export function Tooltip({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  if (!title) return <>{children}</>;
  const isText = typeof title === "string";
  return (
    <span className={"ui-tip" + (className ? " " + className : "")} data-tip={isText ? (title as string) : undefined}>
      {children}
      {isText ? null : <span className="ui-tip-pop">{title}</span>}
    </span>
  );
}

/* ────────────────────────── Tag ────────────────────────── */
// 2026-10-13 round 76-AU: antd 预设色名原来是**直接当 CSS 颜色关键字**用(color="blue" -> color:blue=#0000FF),
//   在深色/高对比下只有 1.6(不达 AA)。这里把常见预设名映射到跟随主题的令牌; 非预设值(令牌/hex)原样透传。
const TAG_PRESET: Record<string, string> = {
  blue: "var(--info)", geekblue: "var(--table-skill)", cyan: "var(--table-memory)",
  green: "var(--status-ok)", lime: "var(--status-ok)", success: "var(--status-ok)",
  gold: "var(--status-warn)", orange: "var(--status-warn)", warning: "var(--status-warn)",
  red: "var(--status-crit)", volcano: "var(--status-crit)", error: "var(--status-crit)",
  magenta: "var(--table-reflection)", purple: "var(--table-knowledge)", processing: "var(--primary)",
};

export function Tag({
  children, className, style, color, variant, onClick,
}: { children?: ReactNode; className?: string; style?: Style; color?: string; variant?: "filled" | "outlined"; onClick?: () => void }) {
  const tagColor = color ? (TAG_PRESET[color] || color) : undefined;
  return (
    <span
      className={"ui-tag " + (variant === "outlined" ? "ui-tag-outlined" : "ui-tag-filled") + (className ? " " + className : "")}
      style={tagColor ? { ...style, borderColor: tagColor, color: tagColor } : style}
      onClick={onClick}
    >
      {children}
    </span>
  );
}

/* ────────────────────────── Button ────────────────────────── */
export function Button({
  children, className, style, size, icon, onClick, type, disabled, htmlType, loading, danger, block, title, href, target, ghost,
}: {
  children?: ReactNode; className?: string; style?: Style; size?: "small" | "middle" | "large";
  icon?: ReactNode; onClick?: (e: unknown) => void; type?: "primary" | "default" | "text" | "link";
  disabled?: boolean; htmlType?: "button" | "submit" | "reset"; loading?: boolean; danger?: boolean; block?: boolean; title?: string;
  href?: string; target?: string;
  ghost?: boolean; // antd Button ghost: 透明底(实测 TodoTable/DiscussionPanel 与 type="primary" 同用)
}) {
  // href 形态(antd Button href 渲染 a 标签; 实测 flywheel/tasks/[id] 在用) —— 渲染 <a class="ui-btn ...">
  if (href) {
    const acls = ["ui-btn", "ui-btn-" + (size || "middle"), "ui-btn-" + (type === "primary" ? "primary" : type === "text" ? "text" : type === "link" ? "link" : "default"), className || ""].filter(Boolean).join(" ");
    return (
      <a className={acls} style={style} href={href} target={target} rel={target === "_blank" ? "noreferrer" : undefined} title={title}>
        {icon}
        {children}
      </a>
    );
  }
  const cls = [
    "ui-btn", "ui-btn-" + (size || "middle"),
    type === "primary" ? "ui-btn-primary" : type === "text" ? "ui-btn-text" : type === "link" ? "ui-btn-link" : "ui-btn-default",
    danger ? "ui-btn-danger" : "", block ? "ui-btn-block" : "", ghost ? "ui-btn-ghost" : "", className || "",
  ].filter(Boolean).join(" ");
  return (
    <button className={cls} style={style} onClick={onClick} disabled={disabled || loading} type={htmlType || "button"} title={title}>
      {loading ? <span className="ui-btn-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

/* ────────────────────────── Alert ────────────────────────── */
export function Alert({
  message, title, description, type = "info", showIcon, className, style, action, closable, onClose,
}: {
  message?: ReactNode;
  // 平台里两种写法都在用: antd 的 message= 与 title=(实测 agents-live/cost/lineage/tasks 共 5 处用 title)。
  //   自研件同时接受, 少一个别名就要改 5 个调用点 —— 与 Card.styles 同一个教训。
  title?: ReactNode; description?: ReactNode; type?: "success" | "info" | "warning" | "error";
  showIcon?: boolean; className?: string; style?: Style; action?: ReactNode;
  closable?: boolean; onClose?: () => void; // antd 的可关闭形态(实测 agents-live 等在用)
}) {
  const [closed, setClosed] = useState(false);
  if (closable && closed) return null;
  const head = message !== undefined ? message : title;
  const icon: Record<string, string> = { success: "✓", info: "i", warning: "!", error: "✕" };
  return (
    <div className={"ui-alert ui-alert-" + type + (className ? " " + className : "")} style={style} role="status">
      {showIcon ? <span className="ui-alert-icon" aria-hidden="true">{icon[type]}</span> : null}
      <div className="ui-alert-body">
        {head ? <div className="ui-alert-msg">{head}</div> : null}
        {description ? <div className="ui-alert-desc">{description}</div> : null}
      </div>
      {action ? <div className="ui-alert-action">{action}</div> : null}
      {closable ? (
        <button type="button" className="ui-drawer-x" aria-label="关闭"
          onClick={() => { setClosed(true); onClose?.(); }}>✕</button>
      ) : null}
    </div>
  );
}

/* ────────────────────────── Skeleton ────────────────────────── */
export function Skeleton({
  active, paragraph, title, style, className,
}: { active?: boolean; paragraph?: { rows?: number } | boolean; title?: boolean | { width?: number | string }; style?: Style; className?: string }) {
  const rows = paragraph === true ? 3 : paragraph && typeof paragraph === "object" ? Number(paragraph.rows ?? 3) : 0;
  const titleWidth = title && typeof title === "object" ? title.width : "40%";
  return (
    <div className={"ui-skel" + (active ? " ui-skel-active" : "") + (className ? " " + className : "")} style={style}>
      {title ? <div className="ui-skel-bar" style={{ width: titleWidth }} /> : null}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="ui-skel-bar" style={{ width: i === rows - 1 ? "60%" : "100%" }} />
      ))}
    </div>
  );
}

/* ────────────────────────── Empty ────────────────────────── */
const PRESENTED_IMAGE_SIMPLE = "simple";
export function Empty({ description, image, children, className, style }: { description?: ReactNode; image?: string; children?: ReactNode; className?: string; style?: Style }) {
  void image;
  return (
    <div className={"ui-empty" + (className ? " " + className : "")} style={style}>
      <div className="ui-empty-art" aria-hidden="true">◍</div>
      {description ? <div className="ui-empty-desc">{description}</div> : null}
      {children}
    </div>
  );
}
Empty.PRESENTED_IMAGE_SIMPLE = PRESENTED_IMAGE_SIMPLE;

/* ────────────────────────── Card ────────────────────────── */
export function Card({
  title, extra, children, className, style, size, bordered, bodyStyle, hoverable, onClick, styles,
}: {
  title?: ReactNode; extra?: ReactNode; children?: ReactNode; className?: string; style?: Style;
  size?: "small" | "default"; bordered?: boolean; bodyStyle?: Style; hoverable?: boolean; onClick?: () => void;
  // antd v5/v6 的 styles={{ body }} 形态: ui.tsx 在用(tsc 基线因此从 8 -> 9 时才暴露) —— 这里显式支持,
  //   不靠"把调用点改一改"绕过去: 调用点越多, 少一个 API 就要改 N 处(与单一来源原则同理)。
  styles?: { body?: Style; header?: Style };
}) {
  const cls = ["ui-card", size === "small" ? "ui-card-sm" : "", bordered === false ? "ui-card-plain" : "", hoverable ? "ui-card-hover" : "", className || ""].filter(Boolean).join(" ");
  return (
    <div className={cls} style={style} onClick={onClick}>
      {title || extra ? (
        <div className="ui-card-head">
          <div className="ui-card-title">{title}</div>
          {extra ? <div className="ui-card-extra">{extra}</div> : null}
        </div>
      ) : null}
      <div className="ui-card-body" style={{ ...bodyStyle, ...(styles && styles.body ? styles.body : {}) }}>{children}</div>
    </div>
  );
}

/* ────────────────────────── Menu ────────────────────────── */
export type MenuItem = { key: string; label?: ReactNode; title?: string; children?: MenuItem[]; disabled?: boolean };
export function Menu({
  items, selectedKeys, openKeys, onOpenChange, onClick, mode, style, className,
}: {
  items?: MenuItem[]; selectedKeys?: string[]; openKeys?: string[]; onOpenChange?: (keys: string[]) => void;
  onClick?: (info: { key: string }) => void; mode?: "inline" | "vertical" | "horizontal"; style?: Style; className?: string;
}) {
  // 受控/非受控都支持(与 antd 一致): 传了 openKeys 就是受控, 否则内部自管。
  const [inner, setInner] = useState<string[]>([]);
  const controlled = Array.isArray(openKeys);
  const open = controlled ? (openKeys as string[]) : inner;
  const toggle = (key: string) => {
    const next = open.includes(key) ? open.filter((k) => k !== key) : [...open, key];
    if (!controlled) setInner(next);
    onOpenChange?.(next);
  };
  const selected = new Set(selectedKeys || []);
  // 2026-09-22 递归渲染(前置-2): 带 children 的条目继续作为可展开子菜单, 任意层级;
  //   depth>0 的父级额外加 ui-menu-sub-title-nav/ui-menu-group-nested, 让它看起来像普通条目(不是分组标题)。
  const renderItems = (list: MenuItem[], depth: number): ReactNode =>
    list.map((it) => {
      const hasKids = Array.isArray(it.children) && it.children.length > 0;
      if (!hasKids) {
        return (
          <div key={it.key} className={"ui-menu-item" + (selected.has(it.key) ? " ui-menu-item-sel" : "") + (it.disabled ? " ui-menu-item-dis" : "")}
               title={it.title}
               onClick={() => !it.disabled && onClick?.({ key: it.key })}>
            {it.label}
          </div>
        );
      }
      const isOpen = open.includes(it.key);
      return (
        <div key={it.key} className={"ui-menu-group" + (depth > 0 ? " ui-menu-group-nested" : "")}>
          <div
            className={"ui-menu-sub-title" + (depth > 0 ? " ui-menu-sub-title-nav" : "") + (isOpen ? " ui-menu-sub-open" : "") + (it.disabled ? " ui-menu-item-dis" : "")}
            onClick={() => !it.disabled && toggle(it.key)}
            role="button" tabIndex={0} aria-expanded={isOpen}>
            <span className={"ui-menu-caret" + (isOpen ? " open" : "")} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            </span>
            {it.label}
          </div>
          {isOpen ? <div className="ui-menu-children">{renderItems(it.children!, depth + 1)}</div> : null}
        </div>
      );
    });
  return (
    // 2026-10-22 a11y：子项原来是 role="menuitem"，但容器是 <nav> 而非 role="menu"，
    //   axe 判 critical（aria-required-parent）。给容器加 role="menu" 又会引出 aria-required-children
    //   （子菜单标题是 role="button"）。最终采用：容器保持 <nav>，子项改 role="button" + 键盘可达，
    //   这样既不违反 ARIA 父子约束，也保留可聚焦/可激活语义。
    <nav
      className={"ui-menu ui-menu-" + (mode || "inline") + (className ? " " + className : "")}
      style={style}
    >
      {renderItems(items || [], 0)}
    </nav>
  );
}

/* ────────────────────────── 图标(自研, 替代 @ant-design/icons) ────────────────────────── */
export function ReloadOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">⟳</span>;
}
export function CheckCircleOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">✓</span>;
}
export function ExclamationCircleOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">!</span>;
}
/* ══════════════════════════════════════════════════════════════════════════════
   第 3 批原子件(2026-09-18): Timeline / Progress / Segmented / Collapse / Descriptions /
   Switch / Drawer / Input(+TextArea/Search) / Select / Modal / Dropdown + 常用图标。
   实现口径: 与 antd **同 API 形状**(props 同名同义), 迁移只改 import 行;
   样式复用 .ui-* 类(globals.css), 三主题随 data-theme 生效。
   ══════════════════════════════════════════════════════════════════════════════ */

/* ────────────────────────── Timeline ────────────────────────── */
export function Timeline({ items, children, className, style, mode, reverse, pending }: {
  // items 的正文两种写法都有: children=(antd 文档) 与 content=(实测 DiscussionPanel 用 content) —— 都收
  items?: { key?: string | number; children?: ReactNode; content?: ReactNode; label?: ReactNode; color?: string; dot?: ReactNode }[];
  children?: ReactNode; className?: string; style?: Style; mode?: "left" | "right" | "alternate"; reverse?: boolean; pending?: ReactNode;
}) {
  void mode;
  const list = items ? (reverse ? [...items].reverse() : items) : [];
  return (
    <div className={"ui-tl" + (className ? " " + className : "")} style={style}>
      {list.map((it, i) => (
        <div className="ui-tl-item" key={it.key || String(i)}>
          <span className="ui-tl-dot" style={it.color ? { background: it.color, borderColor: it.color } : undefined}>{it.dot}</span>
          <div className="ui-tl-body">
            {it.label ? <div className="ui-tl-label">{it.label}</div> : null}
            {it.children ?? it.content}
          </div>
        </div>
      ))}
      {children}
      {pending ? <div className="ui-tl-item"><span className="ui-tl-dot ui-tl-dot-pending" /><div className="ui-tl-body">{pending}</div></div> : null}
    </div>
  );
}

/* ────────────────────────── Progress ────────────────────────── */
export function Progress({ percent = 0, status, strokeColor, railColor, showInfo = true, size, className, style, format }: {
  percent?: number; status?: string; strokeColor?: string; showInfo?: boolean;
  // size 三种形态平台都在用: "small" / 数字 / { height }(实测 OverviewQualityPanels 用 {height: 6})
  size?: "small" | "default" | number | { height?: number }; railColor?: string; className?: string; style?: Style; format?: (p: number) => ReactNode;
}) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const sizeObj = size && typeof size === "object" ? size.height : undefined;
  const h = size === "small" ? 4 : typeof size === "number" ? size : typeof sizeObj === "number" ? sizeObj : 8;
  const color = strokeColor || (status === "exception" ? "var(--status-crit)" : status === "success" ? "var(--status-ok)" : "var(--primary)");
  return (
    <div className={"ui-prog" + (className ? " " + className : "")} style={style}>
      <div className="ui-prog-track" style={{ height: h, background: railColor || undefined }}>
        <div className="ui-prog-fill" style={{ width: p + "%", background: color }} />
      </div>
      {showInfo ? <span className="ui-prog-text">{format ? format(p) : p + "%"}</span> : null}
    </div>
  );
}

/* ────────────────────────── Segmented ────────────────────────── */
export function Segmented({ options, value, onChange, className, style, block, size, defaultValue }: {
  options?: (string | { label: ReactNode; value: string | number })[];
  value?: string | number; defaultValue?: string | number; onChange?: (v: any) => void;
  className?: string; style?: Style; block?: boolean; size?: "small" | "middle" | "large";
}) {
  const [inner, setInner] = useState<string | number | undefined>(defaultValue);
  const cur = value !== undefined ? value : inner;
  const norm = (options || []).map((o) => (typeof o === "string" ? { label: o, value: o } : o));
  return (
    <div className={"ui-seg" + (block ? " ui-seg-block" : "") + (className ? " " + className : "")} style={style} role="tablist">
      {norm.map((o) => (
        <button key={String(o.value)} type="button" role="tab" aria-selected={cur === o.value}
          className={"ui-seg-item" + (cur === o.value ? " ui-seg-sel" : "") + (size === "small" ? " ui-seg-sm" : "")}
          onClick={() => { if (value === undefined) setInner(o.value); onChange?.(o.value); }}>{o.label}</button>
      ))}
    </div>
  );
}

/* ────────────────────────── Collapse ────────────────────────── */
export function Collapse({ items, activeKey, defaultActiveKey, onChange, accordion, bordered, ghost, className, style, size, expandIconPosition }: {
  items?: { key: string; label?: ReactNode; children?: ReactNode; extra?: ReactNode }[];
  activeKey?: string | string[]; defaultActiveKey?: string | string[];
  onChange?: (key: any) => void; accordion?: boolean; bordered?: boolean; ghost?: boolean; className?: string; style?: Style;
  size?: "small" | "middle" | "large" | string; expandIconPosition?: "start" | "end";
}) {
  void size; void expandIconPosition;
  const init = defaultActiveKey === undefined ? [] : Array.isArray(defaultActiveKey) ? defaultActiveKey : [defaultActiveKey];
  const [inner, setInner] = useState<string[]>(init);
  const cur = activeKey !== undefined ? (Array.isArray(activeKey) ? activeKey : [activeKey]) : inner;
  const toggle = (k: string) => {
    let next: string[];
    if (accordion) next = cur.includes(k) ? [] : [k];
    else next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    if (activeKey === undefined) setInner(next);
    onChange?.(accordion ? next[0] : next);
  };
  return (
    <div className={"ui-col" + (bordered === false || ghost ? " ui-col-plain" : "") + (className ? " " + className : "")} style={style}>
      {(items || []).map((it) => {
        const open = cur.includes(it.key);
        return (
          <div className="ui-col-item" key={it.key}>
            <div className={"ui-col-head" + (open ? " ui-col-open" : "")} onClick={() => toggle(it.key)} role="button" tabIndex={0} aria-expanded={open}>
              <span className={"ui-menu-caret" + (open ? " open" : "")} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </span>
              <span className="ui-col-label">{it.label}</span>
              {it.extra ? <span className="ui-col-extra">{it.extra}</span> : null}
            </div>
            {open ? <div className="ui-col-body">{it.children}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────────── Descriptions ────────────────────────── */
function DescriptionsItem({ label, children }: { label?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-desc-item">
      <div className="ui-desc-label">{label}</div>
      <div className="ui-desc-value">{children}</div>
    </div>
  );
}
export function Descriptions({ items, children, column, bordered, size, title, className, style, layout }: {
  items?: { key?: string | number; label?: ReactNode; children?: ReactNode; span?: number }[];
  children?: ReactNode; column?: number; bordered?: boolean; size?: "small" | "default";
  title?: ReactNode; className?: string; style?: Style; layout?: "horizontal" | "vertical";
}) {
  const cols = column || 3;
  const grid: Style = { display: "grid", gridTemplateColumns: "repeat(" + cols + ", minmax(0, 1fr))", gap: "var(--sp-2) var(--sp-4)" };
  return (
    <div className={"ui-desc" + (bordered ? " ui-desc-bordered" : "") + (layout === "vertical" ? " ui-desc-v" : "") + (className ? " " + className : "")} style={style}>
      {title ? <div className="ui-card-title" style={{ marginBottom: "var(--sp-2)" }}>{title}</div> : null}
      <div style={grid}>
        {items
          ? items.map((it, i) => (
              // span: antd 的跨列; 单列布局下无意义, 多列时按 gridColumn 展开
              <div key={it.key ?? i} style={it.span && it.span > 1 ? { gridColumn: "span " + Math.min(it.span, cols) } : undefined}>
                <DescriptionsItem label={it.label}>{it.children}</DescriptionsItem>
              </div>
            ))
          : children}
      </div>
    </div>
  );
}
Descriptions.Item = DescriptionsItem;

/* ────────────────────────── Switch ────────────────────────── */
export function Switch({ checked, onChange, size, disabled, className, style }: {
  checked?: boolean; onChange?: (v: boolean) => void; size?: "small" | "default" | "middle"; disabled?: boolean; className?: string; style?: Style;
}) {
  const on = !!checked;
  const sm = size === "small";
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => !disabled && onChange?.(!on)}
      className={"ui-switch" + (on ? " ui-switch-on" : "") + (sm ? " ui-switch-sm" : "") + (className ? " " + className : "")} style={style}>
      <span className="ui-switch-knob" />
    </button>
  );
}

/* ────────────────────────── Drawer ────────────────────────── */
/** 2026-10-13 round 76-BC: 模态/抽屉**共用**的可访问性 —— 背景滚动锁定 + 焦点移入/归还 + Escape + 焦点陷阱。 */
let __dlgLockCount = 0;
let __dlgPrevOverflow = "";
function useScrollLock(open?: boolean) {
  useEffect(() => {
    if (!open) return;
    if (__dlgLockCount === 0) { __dlgPrevOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    __dlgLockCount++;
    return () => { __dlgLockCount--; if (__dlgLockCount === 0) document.body.style.overflow = __dlgPrevOverflow; };
  }, [open]);
}
function useDialogA11y<T extends HTMLElement>(open: boolean | undefined, onClose: (() => void) | undefined, ref: { current: T | null }) {
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    prevFocus.current = (document.activeElement as HTMLElement) ?? null;
    const focusables = () => {
      const el = ref.current;
      if (!el) return [] as HTMLElement[];
      return Array.from(el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
    };
    (focusables()[0] || ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== "Tab") return;
      const fs2 = focusables();
      if (fs2.length === 0) return;
      const first = fs2[0], last = fs2[fs2.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); prevFocus.current?.focus?.(); };
  }, [open, onClose, ref]);
}
export function Drawer({ open, onClose, title, width, children, footer, placement, className, styles, destroyOnClose, destroyOnHidden, maskClosable, size }: {
  open?: boolean; onClose?: () => void; title?: ReactNode; width?: number | string; children?: ReactNode; footer?: ReactNode;
  placement?: "right" | "left" | "top" | "bottom"; className?: string;
  // antd 的 styles 是多段对象(body/header/footer/mask/content/container); 平台实际用到 body 与 container(实测报错才补)
  styles?: { body?: Style; header?: Style; footer?: Style; mask?: Style; content?: Style; container?: Style };
  destroyOnClose?: boolean; destroyOnHidden?: boolean; maskClosable?: boolean; size?: number | "default" | "large";
}) {
  void destroyOnClose; void destroyOnHidden;
  const ref = useRef<HTMLElement | null>(null);
  useScrollLock(open);
  useDialogA11y(open, onClose, ref);
  if (!open) return null;
  return (
    <div className="ui-drawer-mask" onClick={() => maskClosable !== false && onClose?.()}>
      <aside ref={ref} tabIndex={-1}
             className={"ui-drawer ui-drawer-" + (placement || "right") + (className ? " " + className : "")}
             style={{ width: placement === "left" || placement === "right" || !placement ? (width || (typeof size === "number" ? size : 520)) : "100%", ...(styles && styles.container) }}
             onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
             aria-label={typeof title === "string" ? title : undefined}>
        <div className="ui-drawer-head" style={styles && styles.header}>
          <div className="ui-card-title">{title}</div>
          <button type="button" className="ui-drawer-x" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="ui-drawer-body" style={styles && styles.body}>{children}</div>
        {footer ? <div className="ui-drawer-foot">{footer}</div> : null}
      </aside>
    </div>
  );
}

/* ────────────────────────── Input ────────────────────────── */
type InputProps = {
  value?: string | number; defaultValue?: string | number; onChange?: (e: any) => void; placeholder?: string;
  size?: "small" | "middle" | "large"; prefix?: ReactNode; suffix?: ReactNode; allowClear?: boolean;
  disabled?: boolean; style?: Style; className?: string; type?: string; onPressEnter?: (e: any) => void;
  maxLength?: number; autoFocus?: boolean; name?: string; id?: string;
};
export function Input({ value, defaultValue, onChange, placeholder, prefix, suffix, disabled, style, className, type, onPressEnter, maxLength, autoFocus, name, id }: InputProps) {
  return (
    <span className={"ui-input-wrap" + (className ? " " + className : "")} style={style}>
      {prefix ? <span className="ui-input-affix">{prefix}</span> : null}
      <input className="ui-input" value={value as any} defaultValue={defaultValue as any} onChange={onChange} placeholder={placeholder}
        disabled={disabled} type={type || "text"} maxLength={maxLength} autoFocus={autoFocus} name={name} id={id}
        onKeyDown={(e) => { if (e.key === "Enter") onPressEnter?.(e); }} />
      {suffix ? <span className="ui-input-affix">{suffix}</span> : null}
    </span>
  );
}
function TextArea({ value, defaultValue, onChange, placeholder, autoSize, rows, className, style, maxLength, disabled }: InputProps & { autoSize?: { minRows?: number; maxRows?: number } | boolean; rows?: number }) {
  const r = rows || (autoSize && typeof autoSize === "object" ? autoSize.minRows ?? 3 : 3);
  return (
    <textarea className={"ui-input ui-textarea" + (className ? " " + className : "")} style={style} value={value as any} defaultValue={defaultValue as any}
      onChange={onChange} placeholder={placeholder} rows={r} maxLength={maxLength} disabled={disabled} />
  );
}
function Search({ onSearch, enterButton, value, onChange, placeholder, style, className, size }: InputProps & { onSearch?: (v: string) => void; enterButton?: ReactNode }) {
  const [inner, setInner] = useState<string>(String(value ?? ""));
  const cur = value !== undefined ? String(value) : inner;
  return (
    <span className={"ui-input-wrap ui-input-search" + (className ? " " + className : "")} style={style}>
      <input className="ui-input" value={cur} placeholder={placeholder} size={size as any}
        onChange={(e) => { if (value === undefined) setInner(e.target.value); onChange?.(e); }}
        onKeyDown={(e) => { if (e.key === "Enter") onSearch?.(cur); }} />
      {enterButton !== undefined && enterButton !== false
        ? <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" onClick={() => onSearch?.(cur)}>{enterButton === true ? "搜索" : enterButton}</button>
        : <button type="button" className="ui-btn ui-btn-sm" onClick={() => onSearch?.(cur)} aria-label="搜索">⌕</button>}
    </span>
  );
}
Input.TextArea = TextArea;
Input.Search = Search;

/* ────────────────────────── Select ────────────────────────── */
export function Select({ value, defaultValue, onChange, options, placeholder, style, className, size, disabled, allowClear, mode, showSearch, optionFilterProp, notFoundContent, onSearch, filterOption, labelInValue, ariaLabel }: {
  value?: any; defaultValue?: any; onChange?: (v: any, opt?: any) => void;
  options?: { value: any; label?: ReactNode; disabled?: boolean; online?: boolean }[];
  placeholder?: string; style?: Style; className?: string; size?: "small" | "middle" | "large";
  disabled?: boolean; allowClear?: boolean; mode?: "multiple" | "tags";
  // showSearch: **真实现**(输入过滤 + 点选), 不是接受参数后静默降级 —— 否则长列表选择会变难用却看不出来。
  showSearch?: boolean; optionFilterProp?: string; notFoundContent?: ReactNode;
  onSearch?: (v: string) => void; filterOption?: unknown; labelInValue?: boolean;
  /** 2026-10-13 round 76-AP: 无障碍名称 —— 无可见 <label> 时用 aria-label(缺省回退到 placeholder)。 */
  ariaLabel?: string;
}) {
  void allowClear; void optionFilterProp; void onSearch; void filterOption; void labelInValue;
  const [q, setQ] = useState("");
  const [openList, setOpenList] = useState(false);
  const opts = options || [];
  const labelOf = (v: any) => {
    const o = opts.find((x) => String(x.value) === String(v));
    return o ? (typeof o.label === "string" || typeof o.label === "number" ? String(o.label) : String(o.value)) : String(v ?? "");
  };
  if (showSearch && !disabled) {
    const picked = value !== undefined ? value : defaultValue;
    const filtered = q.trim() ? opts.filter((o) => {
      const text = (typeof o.label === "string" ? o.label : String(o.value)) + " " + String(o.value);
      return text.toLowerCase().includes(q.trim().toLowerCase());
    }) : opts;
    return (
      <span className={"ui-input-wrap ui-select-search" + (className ? " " + className : "")} style={style}>
        <input className="ui-input" value={openList ? q : (picked !== undefined && picked !== "" ? labelOf(picked) : "")}
          placeholder={placeholder} disabled={disabled}
          onFocus={() => { setOpenList(true); setQ(""); }}
          onChange={(e) => { setQ(e.target.value); setOpenList(true); onSearch?.(e.target.value); }} />
        {openList ? (
          <>
            <span className="ui-dd-backdrop" onClick={() => setOpenList(false)} />
            <div className="ui-dd-menu ui-select-menu">
              {filtered.length === 0 ? <div className="ui-dd-item ui-menu-item-dis">{notFoundContent || "无匹配项"}</div> : filtered.map((o) => (
                <div key={String(o.value)} className={"ui-dd-item" + (o.disabled ? " ui-menu-item-dis" : "")}
                  onClick={() => { if (o.disabled) return; setOpenList(false); onChange?.(o.value, o); }}>{o.label ?? String(o.value)}</div>
              ))}
            </div>
          </>
        ) : null}
      </span>
    );
  }
  const multi = mode === "multiple" || mode === "tags";
  const val = value !== undefined ? value : defaultValue;
  void labelOf;
  const asArr = Array.isArray(val) ? val.map(String) : val === undefined || val === null ? [] : [String(val)];
  return (
    <select className={"ui-input ui-select" + (size === "small" ? " ui-btn-sm" : "") + (className ? " " + className : "")} style={style}
      aria-label={ariaLabel || (typeof placeholder === "string" ? placeholder : undefined)}
      multiple={multi} disabled={disabled} value={multi ? asArr : (asArr[0] ?? "")}
      onChange={(e) => {
        if (multi) {
          const picked = Array.from(e.target.selectedOptions).map((o) => o.value);
          onChange?.(picked, undefined);
        } else {
          const v = e.target.value;
          const opt = (options || []).find((o) => String(o.value) === v);
          onChange?.(v === "" ? undefined : (opt ? opt.value : v), opt);
        }
      }}>
      {placeholder && !multi ? <option value="">{placeholder}</option> : null}
      {(options || []).map((o) => <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>{typeof o.label === "string" || typeof o.label === "number" ? o.label : String(o.value)}</option>)}
    </select>
  );
}

/* ────────────────────────── Modal ────────────────────────── */
export function Modal({ open, title, onCancel, onOk, footer, width, children, maskClosable, confirmLoading, okText, cancelText, styles, className, destroyOnClose, destroyOnHidden, closable, centered }: {
  open?: boolean; title?: ReactNode; onCancel?: () => void; onOk?: () => void; footer?: ReactNode;
  width?: number | string; children?: ReactNode; maskClosable?: boolean; confirmLoading?: boolean;
  okText?: ReactNode; cancelText?: ReactNode; className?: string; destroyOnClose?: boolean; destroyOnHidden?: boolean;
  closable?: boolean; centered?: boolean;
  styles?: { body?: Style; header?: Style; footer?: Style; mask?: Style; content?: Style; container?: Style };
}) {
  void destroyOnClose; void destroyOnHidden;
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollLock(open);
  useDialogA11y(open, onCancel, ref);
  if (!open) return null;
  return (
    <div className={"ui-modal-mask" + (centered ? " ui-modal-centered" : "")} onClick={() => maskClosable !== false && onCancel?.()}>
      <div ref={ref} tabIndex={-1} className={"ui-modal" + (className ? " " + className : "")} style={{ width: width || 520, ...(styles && styles.container) }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="ui-drawer-head">
          <div className="ui-card-title">{title}</div>
          {closable === false ? null : <button type="button" className="ui-drawer-x" onClick={onCancel} aria-label="关闭">✕</button>}
        </div>
        <div className="ui-modal-body" style={styles && styles.body}>{children}</div>
        {footer === null ? null : (
          <div className="ui-modal-foot">
            {footer !== undefined ? footer : (
              <>
                <button type="button" className="ui-btn ui-btn-middle" onClick={onCancel}>{cancelText || "取消"}</button>
                <button type="button" className="ui-btn ui-btn-middle ui-btn-primary" disabled={confirmLoading} onClick={onOk}>{okText || "确定"}</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────── Dropdown ────────────────────────── */
export function Dropdown({ menu, children, className, disabled, trigger, placement, getPopupContainer }: {
  // key 可省: 分隔项 { type: "divider" } 没有 key(实测 TodoTable 就是这样用的)
  menu?: { items?: { key?: string; label?: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; type?: string; children?: { key: string; label?: ReactNode }[] }[]; onClick?: (info: { key: string }) => void };
  children?: ReactNode; className?: string; disabled?: boolean; trigger?: string[] | string; placement?: string;
  getPopupContainer?: unknown;
}) {
  void trigger; void placement; void getPopupContainer;
  const [open, setOpen] = useState(false);
  return (
    <span className={"ui-dd" + (className ? " " + className : "")}>
      <span className="ui-dd-trigger" onClick={() => !disabled && setOpen((v) => !v)}>{children}</span>
      {open ? (
        <>
          <span className="ui-dd-backdrop" onClick={() => setOpen(false)} />
          <div className="ui-dd-menu" role="menu">
            {(menu?.items || []).map((it, idx) => (
              <div key={it.key || it.type || String(idx)} role="menuitem" tabIndex={0}
                className={"ui-dd-item" + (it.danger ? " ui-dd-danger" : "") + (it.disabled ? " ui-menu-item-dis" : "")}
                onClick={() => { if (it.disabled) return; setOpen(false); it.onClick?.(); menu?.onClick?.({ key: it.key }); }}>
                {it.label}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}

/* ────────────────────────── 第 3 批图标 ────────────────────────── */
export function PlusOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">＋</span>;
}
export function UpOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">▲</span>;
}
export function DownOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">▼</span>;
}
export function SendOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">➤</span>;
}
export function SearchOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">⌕</span>;
}
export function DeleteOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">🗑</span>;
}
export function CloseOutlined({ className, style }: { className?: string; style?: Style }) {
  return <span className={"ui-icon" + (className ? " " + className : "")} style={style} aria-hidden="true">✕</span>;
}
/* ══════════════════════════════════════════════════════════════════════════════
   第 4 批(2026-09-18 收口批): Table / Form(含 useForm) / DatePicker / ConfigProvider。
   这一批之后 console 的 antd 引用应为 0(UI 门 antd-zero PASS)。
   口径仍是"与 antd 同 API 形状, 迁移只改 import":
     · Table: columns/dataSource/rowKey/pagination/size/locale.emptyText/scroll/onRow/rowClassName/loading/bordered
     · Form: useForm() 返回 [form]; form.validateFields()/resetFields()/setFieldsValue()/getFieldsValue();
             Form.Item 的 name/label/rules(required/pattern/validator)/tooltip 由本实现注入 value+onChange
     · DatePicker: showTime 决定 date / datetime-local; onChange 传 **Date 对象**(调用点写 dueAt.toISOString(),
       Date 正好有该方法) —— 不为此引入 dayjs: 多一个运行时依赖只为格式化不值得
     · ConfigProvider: 直通壳。这不是假迁移 —— console 主题自 Phase1 S3 起由 globals.css 的 CSS 变量三主题块
       (--primary、--radius-* 系列、--fs-* 系列、--panel 等) 承载; antd token 段是历史残留, 留着反而两套口径。
        踩坑记录: 在注释里写通配路径时, 紧跟星号的那个斜杠会提前闭合块注释(本次连踩两次, TS 报 6 个语法错) —— 分隔符改用顿号。
   ══════════════════════════════════════════════════════════════════════════════ */

/* ────────────────────────── Table ────────────────────────── */
export type TableColumn<T> = {
  key?: string | number; title?: ReactNode; dataIndex?: string | string[];
  render?: (value: any, record: T, index: number) => ReactNode;
  width?: number | string; align?: "left" | "center" | "right"; className?: string; ellipsis?: boolean;
};
export type TablePagination = false | {
  pageSize?: number; current?: number; total?: number; showSizeChanger?: boolean;
  pageSizeOptions?: (string | number)[]; onChange?: (page: number, pageSize: number) => void; showTotal?: (t: number) => ReactNode;
  size?: string; position?: string[]; hideOnSinglePage?: boolean; // 形态与 antd 一致, 未用到的键也接受(否则每个调用点都要改)
};
export type TableExpandable<T> = {
  expandedRowRender?: (record: T, index: number) => ReactNode;
  expandedRowKeys?: (string | number)[]; onExpand?: (expanded: boolean, record: T) => void;
  rowExpandable?: (record: T) => boolean; expandIcon?: (props: { expanded: boolean; onExpand: () => void }) => ReactNode;
  onExpandedRowsChange?: (keys: (string | number)[]) => void; // WorkPlanView 在用
};
export type TableProps<T> = {
  columns?: TableColumn<T>[]; dataSource?: T[]; rowKey?: string | ((record: T) => string);
  pagination?: TablePagination; size?: "small" | "middle" | "large" | "default"; loading?: boolean;
  locale?: { emptyText?: ReactNode }; scroll?: { x?: number | string; y?: number | string };
  rowClassName?: string | ((record: T, index: number) => string);
  onRow?: (record: T, index: number) => { onClick?: () => void; style?: Style; className?: string };
  bordered?: boolean; showHeader?: boolean; className?: string; style?: Style;
  footer?: () => ReactNode; title?: () => ReactNode; expandable?: TableExpandable<T>;
};
function pickCell(record: any, dataIndex?: string | string[]): any {
  if (dataIndex === undefined) return undefined;
  if (Array.isArray(dataIndex)) return dataIndex.reduce((acc: any, k) => (acc == null ? acc : acc[k]), record);
  return record ? record[dataIndex] : undefined;
}
export function Table<T extends object>({
  columns, dataSource, rowKey, pagination, size = "small", loading, locale, scroll, rowClassName, onRow,
  bordered, showHeader = true, className, style, footer, title, expandable,
}: TableProps<T>) {
  const rows = dataSource || [];
  const [page, setPage] = useState(1);
  // 展开行(展开态可受控 expandedRowKeys, 也可自管) —— WorkPlanView 在用 expandedRowRender
  const [openKeys, setOpenKeys] = useState<(string | number)[]>([]);
  const expandedKeys = expandable?.expandedRowKeys ?? openKeys;
  const toggleRow = (k: string | number, r: T) => {
    const has = expandedKeys.includes(k);
    const next = has ? expandedKeys.filter((x) => x !== k) : [...expandedKeys, k];
    if (!expandable?.expandedRowKeys) setOpenKeys(next);
    expandable?.onExpand?.(!has, r);
    expandable?.onExpandedRowsChange?.(next);
  };
  // false/未传 = 不分页; 传对象 = 客户端分页(平台只用到这两种, 见 DataTable 默认 pagination=false)
  const pcfg = pagination === false || pagination === undefined ? null : pagination;
  const pageSize = pcfg && pcfg.pageSize && pcfg.pageSize > 0 ? pcfg.pageSize : rows.length || 1;
  const cur = pcfg ? (pcfg.current ?? page) : 1;
  const total = pcfg?.total ?? rows.length;
  const view = pcfg ? rows.slice((cur - 1) * pageSize, cur * pageSize) : rows;
  const keyOf = (r: T, i: number) => (typeof rowKey === "function" ? rowKey(r) : rowKey ? String((r as any)[rowKey]) : String(i));
  const pages = pcfg ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const go = (p: number) => { const n = Math.min(Math.max(1, p), pages); setPage(n); pcfg?.onChange?.(n, pageSize); };
  return (
    <div className={"ui-table-wrap" + (className ? " " + className : "")} style={style}>
      {title ? <div className="ui-table-title">{title()}</div> : null}
      <div className="ui-table-scroll" style={scroll && scroll.y ? { maxHeight: scroll.y } : undefined}>
        <table className={"ui-table" + (size === "small" ? " ui-table-sm" : "") + (bordered ? " ui-table-bordered" : "")}
               style={scroll && scroll.x ? { minWidth: scroll.x } : undefined}>
          {showHeader ? (
            <thead>
              <tr>
                {expandable?.expandedRowRender ? <th style={{ width: 32 }} /> : null}
                {(columns || []).map((c, i) => <th key={c.key ?? i} style={{ width: c.width, textAlign: c.align }} className={c.className}>{c.title}</th>)}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {view.length === 0 ? (
              <tr><td colSpan={(columns || []).length || 1} className="ui-table-empty">{loading ? "加载中…" : (locale && locale.emptyText) || "暂无数据"}</td></tr>
            ) : view.map((r, i) => {
              const rowProps = onRow ? onRow(r, i) : {};
              const rc = typeof rowClassName === "function" ? rowClassName(r, i) : rowClassName || "";
              const k = keyOf(r, i);
              const canExpand = !!expandable?.expandedRowRender && (!expandable.rowExpandable || expandable.rowExpandable(r));
              const isOpen = expandedKeys.includes(k);
              void canExpand;
              return (
                <Fragment key={k}>
                  <tr className={[rc, rowProps.className || ""].filter(Boolean).join(" ")} style={rowProps.style} onClick={rowProps.onClick}>
                    {expandable?.expandedRowRender ? (
                      <td style={{ width: 32 }}>
                        {canExpand ? (
                          expandable.expandIcon
                            ? expandable.expandIcon({ expanded: isOpen, onExpand: () => toggleRow(k, r) })
                            : <button type="button" className="ui-btn ui-btn-sm ui-table-expand" aria-expanded={isOpen}
                                onClick={(e) => { e.stopPropagation(); toggleRow(k, r); }}>{isOpen ? "▾" : "▸"}</button>
                        ) : null}
                      </td>
                    ) : null}
                    {(columns || []).map((c, ci) => (
                      <td key={c.key ?? ci} style={{ textAlign: c.align }} className={(c.className || "") + (c.ellipsis ? " ui-table-ellipsis" : "")}>
                        {c.render ? c.render(pickCell(r, c.dataIndex), r, ci === 0 ? i : i) : (pickCell(r, c.dataIndex) as ReactNode)}
                      </td>
                    ))}
                  </tr>
                  {isOpen && expandable?.expandedRowRender ? (
                    <tr className="ui-table-expanded"><td colSpan={((columns || []).length || 1) + 1}>{expandable.expandedRowRender(r, i)}</td></tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {pcfg && pages > 1 ? (
        <div className="ui-table-page">
          <span className="ui-prog-text">{pcfg.showTotal ? pcfg.showTotal(total) : "共 " + total + " 条"}</span>
          <button type="button" className="ui-btn ui-btn-sm" disabled={cur <= 1} onClick={() => go(cur - 1)}>上一页</button>
          <span className="ui-prog-text">{cur} / {pages}</span>
          <button type="button" className="ui-btn ui-btn-sm" disabled={cur >= pages} onClick={() => go(cur + 1)}>下一页</button>
        </div>
      ) : null}
      {footer ? <div className="ui-table-foot">{footer()}</div> : null}
    </div>
  );
}

/* ────────────────────────── Form ────────────────────────── */
export type FormRule = {
  required?: boolean; message?: string; pattern?: RegExp; min?: number; max?: number;
  validator?: (rule: FormRule, value: any) => Promise<unknown> | unknown;
};
export type FormInstance = {
  __initial: Record<string, any>;
  __rules: Record<string, FormRule[]>;
  __errors: Record<string, string>;
  __listeners: Set<() => void>;
  getFieldsValue: () => Record<string, any>;
  setFieldsValue: (v: Record<string, any>) => void;
  setFieldValue: (name: string, value: any) => void;
  resetFields: () => void;
  validateFields: () => Promise<Record<string, any>>;
};
function createForm(): FormInstance {
  const inst: FormInstance = {
    __initial: {}, __rules: {}, __errors: {}, __listeners: new Set(),
    getFieldsValue: () => inst.__initial,
    setFieldsValue: (v) => { inst.__initial = { ...inst.__initial, ...v }; inst.__listeners.forEach((f) => f()); },
    setFieldValue: (name, value) => inst.setFieldsValue({ [name]: value }),
    resetFields: () => { inst.__initial = {}; inst.__errors = {}; inst.__listeners.forEach((f) => f()); },
    validateFields: async () => {
      const errs: Record<string, string> = {};
      for (const [name, rs] of Object.entries(inst.__rules)) {
        for (const r of rs || []) {
          const v = inst.__initial[name];
          const empty = v === undefined || v === null || v === "";
          if (r.required && empty) { errs[name] = r.message || (name + " 为必填"); break; }
          if (!empty && r.pattern && !r.pattern.test(String(v))) { errs[name] = r.message || (name + " 格式不正确"); break; }
          if (!empty && typeof r.validator === "function") {
            try { await r.validator(r, v); } catch (e) { errs[name] = (e as Error)?.message || (name + " 校验失败"); break; }
          }
        }
      }
      inst.__errors = errs;
      inst.__listeners.forEach((f) => f());
      if (Object.keys(errs).length) throw new Error("表单校验未通过: " + Object.keys(errs).join(", "));
      return inst.__initial;
    },
  };
  return inst;
}
const FormContext = createContext<FormInstance | null>(null);
export function useForm(): [FormInstance] {
  const ref = useRef<FormInstance | null>(null);
  if (!ref.current) ref.current = createForm();
  const [, force] = useState(0);
  useEffect(() => {
    const inst = ref.current as FormInstance;
    const sub = () => force((n) => n + 1);
    inst.__listeners.add(sub);
    return () => { inst.__listeners.delete(sub); };
  }, []);
  return [ref.current];
}
export function Form({ form, children, layout, initialValues, onFinish, className, style }: {
  form?: FormInstance; children?: ReactNode; layout?: "horizontal" | "vertical" | "inline";
  initialValues?: Record<string, any>; onFinish?: (values: Record<string, any>) => void; className?: string; style?: Style;
}) {
  const [self] = useForm();
  const inst = form || self;
  // initialValues 只在**尚未填过值**时铺底: 否则每次渲染都会覆盖用户输入
  if (initialValues) {
    for (const [k, v] of Object.entries(initialValues)) {
      if (inst.__initial[k] === undefined) inst.__initial[k] = v;
    }
  }
  return (
    <FormContext.Provider value={inst}>
      <form className={"ui-form ui-form-" + (layout || "horizontal") + (className ? " " + className : "")} style={style}
            onSubmit={(e) => { e.preventDefault(); void inst.validateFields().then((v) => onFinish?.(v)).catch(() => undefined); }}>
        {children}
      </form>
    </FormContext.Provider>
  );
}
Form.useForm = useForm;
function FormItem({ name, label, children, rules, style, tooltip }: {
  name?: string; label?: ReactNode; children?: ReactNode; rules?: FormRule[]; style?: Style; tooltip?: ReactNode;
}) {
  const inst = useContext(FormContext);
  if (inst && name && rules) inst.__rules[name] = rules;
  const err = inst && name ? inst.__errors[name] : "";
  const value = inst && name ? inst.__initial[name] : undefined;
  const child = inst && name && isValidElement(children)
    ? cloneElement(children as any, {
        value,
        onChange: (arg: any) => {
          const v = arg && typeof arg === "object" && "target" in arg ? (arg as any).target.value : arg;
          if (inst.__errors[name]) { delete inst.__errors[name]; }
          inst.setFieldValue(name, v);
        },
      })
    : children;
  return (
    <div className="ui-form-item" style={style}>
      {label ? (
        <label className="ui-form-label" title={typeof tooltip === "string" ? tooltip : undefined}>
          {label}{rules && rules.some((r) => r.required) ? <span className="ui-form-req"> *</span> : null}
        </label>
      ) : null}
      <div className="ui-form-control">
        {child}
        {err ? <div className="ui-form-error">{err}</div> : null}
      </div>
    </div>
  );
}
Form.Item = FormItem;

/* ────────────────────────── DatePicker ────────────────────────── */
export function DatePicker({ showTime, value, onChange, style, className, placeholder, disabled }: {
  showTime?: boolean | Record<string, unknown>; value?: Date | string | null;
  onChange?: (d: Date | null, s?: string) => void; style?: Style; className?: string; placeholder?: string; disabled?: boolean;
}) {
  const toInput = (v: Date | string | null | undefined) => {
    if (!v) return "";
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    const base = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return showTime ? base + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) : base;
  };
  return (
    <input type={showTime ? "datetime-local" : "date"} className={"ui-input" + (className ? " " + className : "")} style={style}
      value={toInput(value)} placeholder={placeholder} disabled={disabled}
      onChange={(e) => onChange?.(e.target.value ? new Date(e.target.value) : null, e.target.value)} />
  );
}

/* ────────────────────────── ConfigProvider ────────────────────────── */
export function ConfigProvider({ children, className, style }: {
  children?: ReactNode; className?: string; style?: Style;
  // 调用点仍传 locale/theme(antd 语义): 显式接受并忽略, 让布局文件零改动 —— 不为了"去掉参数"去改调用点
  locale?: unknown; theme?: unknown;
}) {
  // 直通壳(见本批文件头): 主题已由 globals.css 的 CSS 变量三主题块承载; 保留同名组件让调用点零改动。
  return <div className={"ui-config-provider" + (className ? " " + className : "")} style={style}>{children}</div>;
}
