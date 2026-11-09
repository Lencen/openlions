"use client";
// 2026-11-06 · 0.4.32-03 · /flywheel 指标带 = 数据卡 9「指标（≤4）」，顺序按卡 9 第 6 行：
//   ① 提炼失败率 ② 认知链 24h 新增 ③ 飞轮积压 ④ 六段覆盖率（n/a，缺口 G1）
// 呈现分工（2026-11-06 裁决，避免与下方判据条重复）：
//   · 本组件**只报「值」**——hint 只写口径来源，不写阈值、不标「异常/正常」色标；
//   · 阈值 + pass/fail 判定归「卡 9 判据条」（Card9Checks，读 /api/flywheel/card9）；
//     同一个数只在一处带异常色标，指标带保持中性。
// 口径来源：docs/design/uiux-bento-2026-11/data-cards/card-9-flywheel.md 行 15 / 行 26-73。
// 取数：复用页面既有的 /api/flywheel-health（本组件不发请求），只消费其只读块 card9。
// 纪律：未知不填 0（value=null ->「未知」+ 原因）；④ 不写 0、不自造口径。
import KpiCard from "@/components/KPICard";
import { LOADING, UNKNOWN } from "@/lib/format";
import { fmt } from "./shared";
import type { Card9Metrics } from "./shared";
import styles from "../page.module.css";

export default function FlywheelKpis({
  card9,
  loading,
  error,
}: {
  /** /api/flywheel-health 的 card9 块；接口失败或未返回时为 null（此时 ①②③ 显示「未知」+ 原因） */
  card9: Card9Metrics | null;
  /** 页面的 health 加载态（仅用于首屏占位，避免把「加载中」说成「未知」） */
  loading?: boolean;
  /** 页面的 health 错误文案（未知态的原因） */
  error?: string | null;
}) {
  const errText = error ? String(error).slice(0, 120) : "";
  const missing = errText ? "体检接口取不到：" + errText : "体检接口未返回 card9 指标块";
  const loadingText = loading && !card9 ? LOADING : UNKNOWN;
  const pending = !!loading && !card9;
  const reasonOf = (m?: { reason: string | null }) => (m?.reason ? String(m.reason) : missing);
  // 首屏：说「读取中」，不把加载中写成「未知 + 原因」
  const reasonHint = (m?: { reason: string | null }) =>
    pending ? "读取 /api/flywheel-health 中…" : "原因：" + reasonOf(m) + " · 不写 0";

  const ex = card9?.extractFailure;
  const re = card9?.reflection24h;
  const bl = card9?.backlog;
  const cov = card9?.coverage6;
  // 已知 = 有值且未被判成 unknown；未知/加载中一律不落 0。
  const exKnown = !!ex && ex.state !== "unknown" && ex.value !== null;
  const reKnown = !!re && re.state !== "unknown" && re.value !== null;
  const blKnown = !!bl && bl.state !== "unknown" && bl.value !== null;
  const covValue = cov && cov.value !== null ? Math.round(Number(cov.value) * 100) + "%" : null;
  const covMissing = "口径缺口 G1：字典未定义六段覆盖率的分子 / 分母 / 来源表（数据卡 9 行 15 指标④ / 行 18）；不写 0、不自造口径";

  return (
    <div className="kpi-grid">
      {/* ① 提炼失败率 —— 卡 9 指标①：源 SessionExtractionState（阈值与判定见判据条） */}
      <KpiCard
        label="① 提炼失败率"
        value={exKnown ? Number(ex!.value).toFixed(1) + (ex!.unit === "%" || !ex!.unit ? "%" : "") : loadingText}
        hint={
          exKnown
            ? "源 SessionExtractionState · 口径：status='ERROR' 行数 / 全部行数（打开页面时现算）"
            : reasonHint(ex)
        }
      />

      {/* ② 认知链 24h 新增 —— 卡 9 指标②：只认 FlywheelReflection 且 status='OK' */}
      <KpiCard
        label="② 认知链 24h 新增"
        value={reKnown ? fmt(Number(re!.value)) : loadingText}
        hint={
          reKnown
            ? "源：反思聚合表（只认成功）· 最近活动 " +
              (re?.lastActiveHours != null ? re.lastActiveHours + " 小时前" : UNKNOWN) +
              " · 24h 窗口按 createdAt（打开页面时现算）"
            : reasonHint(re)
        }
      />

      {/* ③ 飞轮积压 —— 卡 9 指标③：源 FlywheelJob（PENDING+PROCESSING） */}
      <KpiCard
        label="③ 飞轮积压"
        value={blKnown ? fmt(Number(bl!.value)) : loadingText}
        hint={
          blKnown
            ? "源：飞轮作业队列（排队中 + 处理中，打开时现算）· 与本页下方改进项不是同一口径"
            : reasonHint(bl)
        }
      />

      {/* ④ 六段覆盖率 —— 卡 9 指标④：字典未定义（缺口 G1），必须显示 n/a + 原因，不得写 0、不得自造口径 */}
      <KpiCard
        label="④ 六段覆盖率"
        value={
          covValue ?? (
            <>
              n/a<span className={styles.naReason}>（原因：口径未定义，见 G1）</span>
            </>
          )
        }
        hint={covMissing}
      />
    </div>
  );
}
