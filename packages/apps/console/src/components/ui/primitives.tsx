"use client";
// 2026-09-10 商业化改版: 统一 UI 原子件 (指标卡 / 状态块 / 卡片 / 页面头)
// 2026-11-05（ord-027 收敛）: 指标卡收口到 components/KPICard.tsx；本文件的 MetricCard 只剩 deprecated 再导出。
import type { ReactNode } from "react";
// 2026-09-18 Phase2 antd 绞杀: 五个原子件 + 图标全部改用自研实现(不再依赖 antd / @ant-design/icons)
import { Button, Card, Empty, Skeleton, Tooltip, ReloadOutlined } from "@/components/primitives";
import { t } from "@/i18n";
// 2026-11-05 P2 批6：本文件的内联 style 清零，色值/间距下沉到 primitives.module.css。
//   只改呈现层（不改导出名、props 形状、文案）；动态色一律走 data-* + 属性选择器。
import styles from "./primitives.module.css";

/** 2026-11-05 P2 批6：PanelCard 的 tone 入参历史上可写任意 CSS 值（调用方实际传的是 var(--status-warn)
 *  这类令牌）。这里把 `var(--x)` 解成令牌名交给 data-tone，由 primitives.module.css 的规则上色：
 *  · 不传 tone -> "default"（--primary，与改前 `tone || "var(--primary)"` 等价）
 *  · var(--known) -> 同名规则
 *  · 其余写法 -> "invalid"（透明，与改前 `background: 非法值` 的渲染结果一致）
 *  新增令牌时在 module.css 补一行规则即可。 */
function panelTone(tone?: string): string {
  if (!tone) return "default";
  const m = /^var\(--([a-z0-9-]+)\)$/i.exec(tone.trim());
  return m ? m[1] : "invalid";
}

/** @deprecated 2026-11-05（ord-027 裁决 A「KPI 收敛」）：MetricCard 已并入 KpiCard 一套。
 *  本名只是**再导出别名**，导出面再保留一个发布周期（判据 scripts/check-kpi-convergence.cjs 清零后删）。
 *  · 实现体已删除；唯一实现是 components/KPICard.tsx（超集：unit/tone/icon/footer/asOf/staleAfterMs/deltaTone）。
 *  · 与旧实现的唯一行为差异：旧 MetricCard 默认 tone="info"；KpiCard 不传 tone 即不染色。
 *    迁移时显式传 tone 就与原来一致（8 个 UI 调用点已按此迁移）。
 *  · 新代码请直接用 KpiCard（白名单 @/components/ui 导出同名）。 */
export { default as MetricCard } from "@/components/KPICard";

export function StateBlock({
  title,
  desc,
  action,
  loading,
  rows = 3,
  onRetry,
}: {
  title?: string;
  desc?: ReactNode;
  action?: ReactNode;
  loading?: boolean;
  rows?: number;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <div className={styles.sbLoading}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} active paragraph={{ rows: 1 }} title={false} className={styles.skItem} />
        ))}
      </div>
    );
  }
  return (
    <div className="state-block">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={title || "暂无数据"} />
      {desc ? <div className={styles.sbDesc}>{desc}</div> : null}
      {action ? <div className="sb-actions">{action}</div> : null}
      {onRetry ? (
        <div className="sb-actions">
          <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重试</Button>
        </div>
      ) : null}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className={"state-block " + styles.errBlock}>
      <div className="sb-title">数据加载失败</div>
      <div className="tiny">{message || t('common.backendHint')}</div>
      {onRetry ? (
        <div className="sb-actions">
          <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重试</Button>
        </div>
      ) : null}
    </div>
  );
}

export function PanelCard({
  title,
  extra,
  children,
  span,
  bodyStyle,
  tone,
}: {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  span?: number;
  bodyStyle?: React.CSSProperties;
  tone?: string;
}) {
  return (
    <Card
      className={"panel-card " + styles.panelCard + (span ? " " + styles["span" + Math.min(12, Math.max(1, Math.round(span)))] : "")}
      size="small"
      title={
        <span className={styles.pcTitle}>
          <span className={styles.pcBar} data-tone={panelTone(tone)} />
          {title}
        </span>
      }
      extra={extra}
      // 2026-10-26：去掉 height:100% —— 它让卡片强行填满网格行高，是"空一半"的直接原因；
      //   要不要等高现在由容器决定（指标行走 stretch，异构两列走 start）。
      // 2026-11-05 P2 批6：gridColumn 改成 .span1~.span12 档位类；body 内边距下沉到 module.css
      //   （.panelCard :global(.ui-card-body)），只在调用方显式传 bodyStyle 时才走行内透传。
      styles={bodyStyle ? { body: bodyStyle } : undefined}
    >
      {children}
    </Card>
  );
}

export function PageHero({
  title,
  subtitle,
  meta,
  tags,
}: {
  title: string;
  subtitle?: ReactNode;
  meta?: ReactNode;
  tags?: ReactNode;
}) {
  return (
    <div className="page-hero">
      <div>
        {/* 2026-10-20 信息分层批1：原来是 div —— 全站 13 个用 PageHero 的页面**一个 h1 都没有**
            （实测只有 /agents/onboard 手写了一个）。改成 h1：视觉不变，但有了语义大纲，h2 分节可以挂进来。 */}
        <h1 className="hero-title ph-title">{title}</h1>
        {subtitle ? <div className="hero-sub">{subtitle}</div> : null}
        {tags ? <div className="hero-tags">{tags}</div> : null}
      </div>
      {meta ? <div className="hero-meta">{meta}</div> : null}
    </div>
  );
}

export function Pill({ tone = "mute", children, title }: { tone?: string; children: ReactNode; title?: string }) {
  const cls = ["ok", "warn", "crit", "info", "mute"].includes(tone) ? tone : "mute";
  const node = <span className={`pill ${cls}`}>{children}</span>;
  return title ? <Tooltip title={title}>{node}</Tooltip> : node;
}
