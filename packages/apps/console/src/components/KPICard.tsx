import type { ReactNode } from "react";
import Link from "next/link";
import Sparkline from "./Sparkline";
import { Tooltip } from "@/components/primitives";
import { DASH, LOADING, UNKNOWN, fmtClock, fmtTime } from "@/lib/format";
import styles from "./KPICard.module.css";

/** 数值色档位。语义由**调用方**定（上升不一定是好），这里只负责把语义映射到令牌。 */
export type KpiTone = "info" | "ok" | "warn" | "crit" | "mute";

/** 业务状态色档：与飞轮业务 STATUS_META 的五档一一对应（多一档「无数据」，不含涨跌用的 mute）。 */
export type BusinessTone = "ok" | "warn" | "crit" | "nodata" | "info";

/** 业务口径卡的状态 chip：文案与色档都由调用方给（这里不写死任何业务词）。 */
export interface BusinessStatus {
  /** chip 文案（业务侧取 STATUS_META[status].label，如 达标/关注/未达标/无数据/参考）。 */
  label: string;
  /** chip 色档；同时驱动左描边与备注色。 */
  tone: BusinessTone;
}

/** 卡片形态。kpi = 通用指标卡（默认，47 个老调用点零变化）；business = 飞轮业务口径卡。 */
export type KpiVariant = "kpi" | "business";

/** tone -> 趋势线颜色（trend 与数值同语义；未给 tone 时保持 Sparkline 默认色，老调用点不变）。 */
const TONE_INK: Record<KpiTone, string> = {
  info: "var(--primary)",
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  crit: "var(--status-crit)",
  mute: "var(--text-muted)",
};

export interface Props {
  /** 2026-11-05 phase2（ord-027）：variant="business" 时渲染业务口径卡解剖（口径/来源/责任人/复算/下钻）。
   *  默认 "kpi"，通用档的 DOM 与样式与 phase1 完全一致。 */
  variant?: KpiVariant;
  label: string;
  /** 数值。宽成 ReactNode 是为了容纳老的 string/number 与「…」占位、以及带样式的富文本。 */
  value: ReactNode;
  /** 2026-11-05（ord-027 收敛）：单位。四态词（加载中… / 未知 / —）后面不接单位。 */
  unit?: string;
  /** 说明文字（数值下方）。老的 KPICard 就有，语义不变。 */
  hint?: ReactNode;
  /** 数值色。**不传 = 不染色**（与收敛前的 KPICard 一致，47 个老调用点零变化）。 */
  tone?: KpiTone;
  /** 标签左侧图标。 */
  icon?: ReactNode;
  /** 脚注（贴底，放明细/分解）。 */
  footer?: ReactNode;
  /** 数据时刻（毫秒时间戳或 ISO 字符串）。给了就显示「截至 HH:MM」。 */
  asOf?: number | string | null;
  /** 超过这个时长追加「· 数据可能已过期」。默认 30 分钟。 */
  staleAfterMs?: number;
  /** 趋势文本（如「环比 +12」）。配 deltaTone 用时进「数据时刻」行；只给 deltaDir 时保持老的 chip 外观。 */
  delta?: ReactNode;
  /** 趋势文本色。语义由调用方定；**传了它就按它上色，且优先于 deltaDir**（不再渲染 up/down 类）。 */
  deltaTone?: KpiTone;
  /** @deprecated 老的涨跌方向（上绿下红）。保留兼容：只给 delta + deltaDir 的老调用点视觉不变。 */
  deltaDir?: "up" | "down";
  /** 2026-10-20 视觉层级：hero = 每页只允许一个的主数字（44px + 渐变顶条） */
  size?: "normal" | "hero";
  /** R3：卡内嵌趋势线（无有效数据时不画，避免出现假的 0 线） */
  trend?: number[];

  /* ── 以下仅 variant="business" 使用（原 flywheel/business MetricCard 的解剖字段） ── */
  /** 副行（原 m.sub(s)）。 */
  sub?: ReactNode;
  /** 状态 chip 的文案与色档；不传则不渲染 chip（但左描边仍按 info）。 */
  status?: BusinessStatus;
  /** 阈值文案（如「≥ 95%」）。 */
  threshold?: ReactNode;
  /** 口径（怎么算的）。 */
  caliber?: ReactNode;
  /** 来源（哪张表/哪个接口）。 */
  source?: ReactNode;
  /** 责任人。 */
  owner?: ReactNode;
  /** 备注；文字色跟随 status（原实现同样如此）。 */
  note?: ReactNode;
  /** 复算命令。 */
  verify?: ReactNode;
  /** 下钻链接。 */
  href?: string;
  /** 稳定选择器 data-metric（沿用原业务卡的 DOM 钩子，check-flywheel-business-ui.cjs 依赖）。 */
  metricKey?: string;
}

/** 指标卡唯一实现（2026-11-05 ord-027：KpiCard 超集，MetricCard 改为 deprecated 别名）。
 *  解剖固定：标签(可带图标) → 数值+单位 → 说明 → 数据时刻/趋势 → 趋势线 → 脚注。
 *  · 老契约（label/value/delta/deltaDir/size/trend/hint）语义与外观一律不变；
 *  · 新增 unit/tone/icon/footer/asOf/staleAfterMs/deltaTone，取自原 MetricCard（铁律 2：实时数字要带数据时刻）。
 *  · 2026-11-05 phase2：variant="business" 收编飞轮业务口径卡，解剖照原 MetricCard：
 *    标签 → 数值 → 副行 → 状态 chip+阈值 → 口径 → 来源/责任人 → 备注 → 复算 → 下钻。 */
export default function KPICard({
  variant = "kpi",
  label,
  value,
  unit,
  hint,
  tone,
  icon,
  footer,
  asOf,
  staleAfterMs = 30 * 60 * 1000,
  delta,
  deltaTone,
  deltaDir,
  size = "normal",
  trend,
  sub,
  status,
  threshold,
  caliber,
  source,
  owner,
  note,
  verify,
  href,
  metricKey,
}: Props) {
  // ── business 档：原业务卡的 DOM 与样式（逐条等价），不走 .kpi-card 的通用解剖 ──
  if (variant === "business") {
    const st: BusinessTone = status?.tone ?? "info";
    return (
      <article className={"panel " + styles.biz} data-metric={metricKey} data-status={st}>
        <div className={"tiny " + styles.bizLabel}>
          {icon ? <span className={styles.icon}>{icon}</span> : null}
          {label}
        </div>
        <div className={styles.bizValue}>{value}</div>
        {sub ? <div className={"tiny " + styles.bizSub}>{sub}</div> : null}
        <div className={styles.bizFoot}>
          {status ? <span className={"badge " + styles.bizPill} data-status={st}>{status.label}</span> : null}
          {threshold ? <span className="tiny">阈值 {threshold}</span> : null}
        </div>
        {caliber ? <div className={"tiny " + styles.bizLineFirst}>口径：{caliber}</div> : null}
        {source || owner ? <div className={"tiny " + styles.bizLine}>来源：{source} · 责任人：{owner}</div> : null}
        {note ? <div className={"tiny " + styles.bizNote}>{note}</div> : null}
        {verify ? <div className={"tiny " + styles.bizVerify}>复算：<code>{verify}</code></div> : null}
        {href ? <Link href={href} className={"tiny " + styles.bizDrill}>下钻 →</Link> : null}
      </article>
    );
  }

  // 过期判定是纯计算，放在渲染之前（与原 MetricCard 一致）。
  const asOfMs = asOf == null ? NaN : typeof asOf === "number" ? asOf : new Date(asOf).getTime();
  const isStale = Number.isFinite(asOfMs) && Date.now() - asOfMs > staleAfterMs;
  // 四态词后面不接单位，否则会渲染成「加载中…条」。
  const isStateWord = typeof value === "string" && (value === LOADING || value === UNKNOWN || value === DASH);
  // 老 KPICard 的守卫（至少 2 个有限值）优先于原 MetricCard 的 length>1，NaN 数据不会画出假线。
  const hasTrend = !!trend && trend.filter((n) => Number.isFinite(n)).length >= 2;
  const legacyDelta = delta != null && deltaTone == null;
  const tonedDelta = delta != null && deltaTone != null;
  return (
    <div className={"kpi-card" + (size === "hero" ? " kpi-card-hero" : "")}>
      <div className="kpi-label">
        {icon ? <span className={styles.icon}>{icon}</span> : null}
        {label}
      </div>
      <div className={"kpi-value " + styles.value} data-tone={tone}>
        {value}
        {unit && !isStateWord ? <span className={styles.unit}>{unit}</span> : null}
      </div>
      {legacyDelta ? <div className={"kpi-delta " + (deltaDir || "")}>{delta}</div> : null}
      {hint ? <div className="kpi-hint">{hint}</div> : null}
      {asOf != null || tonedDelta ? (
        <div className={styles.meta}>
          {asOf != null ? (
            <Tooltip title={"数据时刻 " + fmtTime(asOf)}>
              <span className={styles.asof} data-stale={isStale}>
                截至 {fmtClock(asOf)}{isStale ? " · 数据可能已过期" : ""}
              </span>
            </Tooltip>
          ) : null}
          {tonedDelta ? <span className={styles.delta} data-tone={deltaTone}>{delta}</span> : null}
        </div>
      ) : null}
      {hasTrend ? (
        <div className="kpi-spark">
          <Sparkline
            data={trend as number[]}
            color={tone ? TONE_INK[tone] : undefined}
            width={220}
            height={size === "hero" ? 40 : 34}
          />
        </div>
      ) : null}
      {footer ? <div className={styles.foot}>{footer}</div> : null}
    </div>
  );
}
