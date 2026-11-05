"use client";
// 2026-10-26：详情页统一解剖（老板反馈「详情页各写一套」）。
// 固定顺序：①结论/标题 ②关键字段（定义网格）③分段正文 ④技术信息（折叠）⑤时间线/关联。
// 目标：抽屉（CognitiveDetailDrawer / 待办抽屉）与独立详情页（/cognitive/*/detail、/sessions/detail…）
// 用**同一批**组件，避免"同一实体两种长相"。
import type { ReactNode } from "react";
import styles from "./index.module.css";

/** 区块外壳：统一标题样式与上下间距（不再每页自造 panel/panel-header） */
export function DetailSection({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="dt-section">
      <header className="dt-section-head">
        <h3 className="dt-section-title">{title}</h3>
        {extra ? <span className="dt-section-extra">{extra}</span> : null}
      </header>
      <div className="dt-section-body">{children}</div>
    </section>
  );
}

export type DetailField = {
  label: string;
  value: ReactNode;
  /** mono: id/哈希/路径；wide: 独占整行（长文本） */
  kind?: "mono" | "wide";
};

/** 关键字段：定义列表（label 12px 灰 / value 14px），比原来手写 .tbl 表格轻一档 */
export function DetailFields({ title, items, cols = 2 }: { title: string; items: DetailField[]; cols?: 1 | 2 }) {
  return (
    <DetailSection title={title}>
      <dl className={"dt-fields" + (cols === 1 ? " one" : "")}>
        {items.map((it) => (
          <div className={"dt-field" + (it.kind === "wide" ? " wide" : "")} key={it.label}>
            <dt>{it.label}</dt>
            <dd className={it.kind === "mono" ? "mono" : undefined}>{it.value === "" || it.value === null || it.value === undefined ? "—" : it.value}</dd>
          </div>
        ))}
      </dl>
    </DetailSection>
  );
}

/** 长正文：保留换行，行高 1.8，字号比正文大一档 */
export function DetailProse({ title, text, empty = "(无内容)" }: { title: string; text?: string | null; empty?: string }) {
  return (
    <DetailSection title={title}>
      <div className="dt-prose">{text ? text : empty}</div>
    </DetailSection>
  );
}

/** 技术信息：默认折叠（界面不出现裸 key=value / 路径 / 哈希） */
export function DetailTech({ items }: { items: { k: string; v: unknown }[] }) {
  const rows = items.filter((it) => it.v !== undefined && it.v !== null && it.v !== "");
  if (!rows.length) return null;
  return (
    <section className="dt-section">
      <details className="tech-detail">
        <summary>技术信息（{rows.length} 项）</summary>
        <dl className={"dt-fields one " + styles.techFields}>
          {rows.map((it) => (
            <div className="dt-field" key={it.k}>
              <dt>{it.k}</dt>
              <dd className="mono">{String(it.v)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

export type DetailEvent = { at?: string | null; text: string; tone?: "ok" | "warn" | "crit" | "idle" };

/** 时间线：结论「什么时候发生了什么」，点用状态色（只表状态） */
export function DetailTimeline({ title = "时间线", events }: { title?: string; events: DetailEvent[] }) {
  if (!events.length) return null;
  return (
    <DetailSection title={title}>
      <ol className="dt-timeline">
        {events.map((e, i) => (
          <li className="dt-tl-item" key={i} data-state={e.tone || "idle"}>
            <span className="dt-tl-dot" aria-hidden="true" />
            <span className="dt-tl-text">{e.text}</span>
            {e.at ? <span className="dt-tl-at mono">{e.at}</span> : null}
          </li>
        ))}
      </ol>
    </DetailSection>
  );
}
