// B4 智能体详情 5 页 · 本地 Bento 组件（2026-11-15）
// 只被 app/agents/detail/** 与 app/agents/[id]/** 引用；不改共享组件（components/bento 不在此列，
// 本批次要求 gutter16/padding24 与 784/384/1184 计算宽度，故在页目录内落地本地栅格）。
// 全部是服务端安全组件（无 hooks / 无事件），可直接被 server component 渲染。
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import { fmtTime, type AgentRow, type LiveAgent } from "../_data";
import s from "./b4.module.css";

const SPAN: Record<number, string> = { 3: s.s3, 4: s.s4, 6: s.s6, 8: s.s8, 12: s.s12 };

export function B4Grid({ children }: { children: ReactNode }) {
  return <div className={s.grid}>{children}</div>;
}

export function B4Card({
  title, sub, actions, span = 4, state, children,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  span?: number;
  state?: "ok" | "unavailable";
  children?: ReactNode;
}) {
  return (
    <section className={s.card + " " + (SPAN[span] || s.s4)} data-state={state || "ok"}>
      {title || actions ? (
        <header className={s.cardHead}>
          <div>
            <h2 className={s.cardTitle}>{title}</h2>
            {sub ? <p className={s.cardSub}>{sub}</p> : null}
          </div>
          {actions ? <div className={s.cardActions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={s.cardBody}>{children}</div>
    </section>
  );
}

/** KPI（4×s3）：有值 / n/a+原因 两态；na 时不写 0。 */
export function B4Kpi({
  span = 3, label, value, unit, hint, tone, na,
}: {
  span?: number;
  label: ReactNode;
  value?: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: "ok" | "warn" | "crit";
  na?: ReactNode;
}) {
  const isNa = na != null;
  return (
    <div className={s.card + " " + (SPAN[span] || s.s3)}>
      <span className={s.kpiLabel}>{label}</span>
      <span className={s.kpiValue} data-na={isNa ? "true" : "false"} data-tone={tone || ""}>
        {isNa ? "n/a" : value}
        {!isNa && unit ? <em className={s.kpiUnit}>{unit}</em> : null}
      </span>
      {isNa ? <span className={s.kpiHint}>原因：{na}</span> : hint ? <span className={s.kpiHint}>{hint}</span> : null}
    </div>
  );
}

/** 四态统一块：empty ≠ unavailable；error 带端点/状态码/重试链接（服务端组件用真实链接刷新）。 */
export function B4State({
  phase, title, detail, retryHref, children,
}: {
  phase: "loading" | "empty" | "error" | "unavailable";
  title?: ReactNode;
  detail?: ReactNode;
  retryHref?: string;
  children?: ReactNode;
}) {
  if (phase === "loading") {
    return (
      <div className={s.state} data-phase="loading">
        <span className={s.skel} /><span className={s.skel + " " + s.skelSm} /><p>加载中…</p>
      </div>
    );
  }
  const tone = phase === "error" ? "crit" : phase === "unavailable" ? "warn" : "mute";
  return (
    <div className={s.state} data-phase={phase} data-tone={tone}>
      <strong>{title || (phase === "empty" ? "暂无数据" : phase === "error" ? "加载失败" : "数据不可得")}</strong>
      {detail ? <p>{detail}</p> : null}
      {retryHref ? <a className={s.stateLink} href={retryHref}>重新加载</a> : null}
      {children}
    </div>
  );
}

/** 标签→值 定义列表（比表格更轻，s4 侧栏/摘要槽用它） */
export function B4Kv({ items }: { items: Array<{ label: ReactNode; value: ReactNode; mono?: boolean }> }) {
  return (
    <dl className={s.kv}>
      {items.map((it, i) => (
        <Fragment key={i}>
          <dt>{it.label}</dt>
          <dd className={it.mono ? s.mono : undefined}>{it.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function B4Chips({ items }: { items: string[] }) {
  return (
    <div className={s.chips} aria-label="页面层级">
      {items.map((c, i) => (
        <span key={c + i} className={s.chip + (i === items.length - 1 ? " " + s.chipOn : "")}>{c}</span>
      ))}
    </div>
  );
}

/** 页头（s12 语义）：面包屑 + 标题 + 副标题 + 对象标识回显 + chips 4 + 数据时刻。 */
export function B4PageHead({
  id, page, title, subtitle, agent, live, asOf, chips,
}: {
  id: string;
  page: string;
  title: string;
  subtitle: string;
  agent?: AgentRow | null;
  live?: LiveAgent | null;
  asOf?: string | null;
  chips?: string[];
}) {
  const display = agent?.display_name || live?.displayName || id;
  const roleLabel = live?.roleLabel || agent?.role || "";
  const channel = live?.channel || agent?.channel || "-";
  const host = agent?.host || live?.host || "-";
  return (
    <>
      <div className="breadcrumb">
        <span>成员</span>
        <span className="sep">/</span>
        <Link href="/agents" className={s.crumbLink}>智能体</Link>
        <span className="sep">/</span>
        <span>{display}</span>
        <span className="sep">/</span>
        <span className="current">{page}</span>
      </div>
      <PageHeader>
        <PageTitle>{title}</PageTitle>
        <div className="page-subtitle">{subtitle}</div>
        <div className="page-subtitle">
          <span className={s.mono}>{agent?.agent_id || id}</span>
          {roleLabel ? ` · ${roleLabel}` : ""}
          {` · ${channel} · ${host}`}
        </div>
      </PageHeader>
      <div className={s.headMeta}>
        <B4Chips items={chips || ["#", "智能体", page, "只读"]} />
        <span className={s.asOf}>
          数据时刻：{asOf ? <span className={s.asOfMono}>{fmtTime(asOf)}</span> : "n/a（接口未下发 asOf）"}
        </span>
      </div>
    </>
  );
}
