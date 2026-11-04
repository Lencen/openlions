"use client";
// 2026-09-10 商业化改版: 统一 UI 原子件 (指标卡 / 状态块 / 卡片 / 页面头)
import type { ReactNode } from "react";
// 2026-09-18 Phase2 antd 绞杀: 五个原子件 + 图标全部改用自研实现(不再依赖 antd / @ant-design/icons)
import { Button, Card, Empty, Skeleton, Tooltip, ReloadOutlined } from "@/components/primitives";
import { t } from "@/i18n";
import Sparkline from "@/components/Sparkline";
import { DASH, LOADING, UNKNOWN, fmtClock, fmtTime } from "@/lib/format";

/** 2026-10-15（数据展示规范 §2 / 铁律 2）：指标卡 = 标题 + 大数字 + 单位/时刻 + 趋势。
 *  · `asOf`：**数据时刻**。规范明说这不是审美问题 —— 平台刚修过「把编译时的旧快照当实时数据」的 bug，
 *    所以任何实时数值都要显示它是什么时候的；超过 `staleAfterMs`（默认 30 分钟）显式标注「数据可能已过期」。
 *  · `delta` + `deltaTone`：趋势文本与它的**方向语义**。规范要求「上升不一定是好」，所以 tone **由调用方定**，
 *    而不是这里按正负自动判色（那正是把语义猜错的地方）。 */
export function MetricCard({
  label,
  value,
  unit,
  hint,
  tone = "info",
  trend,
  icon,
  footer,
  asOf,
  staleAfterMs = 30 * 60 * 1000,
  delta,
  deltaTone = "mute",
  size = "normal",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: "info" | "ok" | "warn" | "crit" | "mute";
  trend?: number[];
  icon?: ReactNode;
  footer?: ReactNode;
  /** 数据时刻（毫秒时间戳或 ISO 字符串）。给了它就一定显示「截至 HH:MM」。 */
  asOf?: number | string | null;
  /** 超过这个时长就标注「数据可能已过期」。默认 30 分钟。 */
  staleAfterMs?: number;
  /** 趋势文本（如「环比 +12」）。语义由 deltaTone 决定。 */
  delta?: ReactNode;
  deltaTone?: "info" | "ok" | "warn" | "crit" | "mute";
  /** 2026-10-20 视觉层级（本轮目标）：hero = 每页**只允许一个**的主数字（44px + 渐变顶条），
   *  其余保持 normal（26px）。审计实测：四个页面最大字号只有 20–30px、≥24px 的元素 0–1 个，
   *  没有视觉锚点 —— 这一档就是补这个锚点。 */
  size?: "normal" | "hero";
}) {
  // 过期判定放在 color 表之前（纯计算，与渲染无关）。
  const asOfMs = asOf == null ? NaN : (typeof asOf === "number" ? asOf : new Date(asOf).getTime());
  const isStale = Number.isFinite(asOfMs) && Date.now() - asOfMs > staleAfterMs;
  const isStateWord = typeof value === "string" && (value === LOADING || value === UNKNOWN || value === DASH);
  const color: Record<string, string> = {
    info: "var(--primary)",
    ok: "var(--status-ok)",
    warn: "var(--status-warn)",
    crit: "var(--status-crit)",
    mute: "var(--text-muted)",
  };
  return (
    <div className={"metric-card" + (size === "hero" ? " metric-card-hero" : "")}>
      <div className="m-head">
        <span className="m-label">
          {icon}
          {label}
        </span>
      </div>
      <div className="m-value" style={{ color: tone === "mute" ? "var(--text)" : color[tone] }}>
        {value}
        {/* 2026-10-15（round 76-ER）：四态词（加载中… / 未知 / —）后面**不接单位** ——
            否则会渲染成「加载中…条」这种读不通的东西（规范 §1：单位放表头/后缀，不逐行拼在状态上）。 */}
        {unit && !isStateWord ? <span className="m-unit">{unit}</span> : null}
      </div>
      {/* 2026-10-25 R4(决策 D11)：说明文字从「标签右侧」挪到「数值下方」——
          字号上调一档后，右对齐的说明会被挤成两行（如「需要人决/策」）。
          卡片解剖固定为：标签 → 数值+单位 → 说明 → 脚注。 */}
      {hint ? <div className="m-hint">{hint}</div> : null}
      {asOf != null || delta != null ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap", marginTop: "var(--sp-0-5)" }}>
          {asOf != null ? (
            <Tooltip title={"数据时刻 " + fmtTime(asOf)}>
              <span className="tiny" style={{ color: isStale ? "var(--status-warn)" : "var(--text-dim)" }}>
                截至 {fmtClock(asOf)}{isStale ? " · 数据可能已过期" : ""}
              </span>
            </Tooltip>
          ) : null}
          {delta != null ? (
            <span className="tiny" style={{ color: tone === "mute" ? "var(--text-muted)" : color[deltaTone] }}>{delta}</span>
          ) : null}
        </div>
      ) : null}
      {trend && trend.length > 1 ? (
        <div className="m-spark">
          <Sparkline data={trend} color={tone === "mute" ? "var(--text-muted)" : color[tone]} width={220} height={34} />
        </div>
      ) : null}
      {footer ? <div className="m-foot">{footer}</div> : null}
    </div>
  );
}

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
      <div style={{ padding: "var(--sp-2) 0" }}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} active paragraph={{ rows: 1 }} title={false} style={{ marginBottom: "var(--sp-2-5)" }} />
        ))}
      </div>
    );
  }
  return (
    <div className="state-block">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={title || "暂无数据"} />
      {desc ? <div style={{ marginTop: "var(--sp-2)" }}>{desc}</div> : null}
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
    <div className="state-block" style={{ color: "var(--status-crit)" }}>
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
      className="panel-card"
      size="small"
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <span
            style={{
              width: 3,
              height: 14,
              borderRadius: "var(--radius-xs)",
              background: tone || "var(--primary)",
              display: "inline-block",
            }}
          />
          {title}
        </span>
      }
      extra={extra}
      // 2026-10-26：去掉 height:100% —— 它让卡片强行填满网格行高，是"空一半"的直接原因；
      //   要不要等高现在由容器决定（指标行走 stretch，异构两列走 start）。
      style={{ gridColumn: span ? `span ${span}` : undefined }}
      styles={{ body: { padding: "var(--sp-4)", ...bodyStyle } }}
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
        <h1 className="hero-title page-title">{title}</h1>
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
