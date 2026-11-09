"use client";
// cost 页 · 指标卡行 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { KpiCard, Pill } from "@/components/ui";
import { t } from "@/i18n";
import { fmtCompact, fmtNum, fmtPct, fmtPctOf, fmtTime, fmtTokens, relTime } from "@/lib/format";
import styles from "./CostMetrics.module.css";
import pageStyles from "../page.module.css";

// 2026-11-06 P2 收尾：本文件内联 style 清零，估算 token 脚注的动态色下沉 CostMetrics.module.css。

export function CostHero({ data, agent }: { data: any; agent?: string | null }) {
  // 2026-11-06 页头口径统一（UIUX PAGE-HEADER-31 §3 #18）：标题 / 一句说明 / 面包屑已上移到 page.tsx，
  //   这里只保留原 hero 的 tags 与 meta（窗口口径 / 不折算金额 / 数据时刻 / 刷新频率），字段与取值未改。
  return (
    <div className={pageStyles.heroStrip}>
      <div className="hero-tags">
        <Pill tone="info">{data?.range?.label || "近 24 小时"}</Pill>
        <Pill tone="warn">{t("cost.noAmount")}</Pill>
        {agent ? <Pill tone="mute">{t("cost.agentFilterNote")}</Pill> : null}
      </div>
      <div className={"tiny " + pageStyles.heroMeta}>
        {t("common.dataTime")}{" "}
        {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
        <br />
        最近一次调用 {data?.summary?.lastAt ? relTime(data.summary.lastAt) : "-"}
        <br />
        每 10 秒自动刷新
      </div>
    </div>
  );
}

export default function CostMetrics({
  data,
  loadingAll,
}: {
  data: any;
  loadingAll: boolean;
}) {
  const s = data?.summary ?? {};
  const all = data?.allTime ?? {};
  return (
    <div className="metric-row">
      {/* 2026-09-11 P2「估算 token 单列(不进总量)」: 总量 = summary.totalTokens, **纯实测**;
          估算量 (tok≈) 不再相加, 单独成卡/成列。 */}
      {/* 2026-10-15（数据展示规范 铁律 2）：给「结论数字」带上**数据时刻**。
          只在这一张加，而不是 9 张都加 —— 规范铁律 1 是「一眼看到最重要那个数字」，
          9 行「截至 16:50」会把层级压平；行级数据时刻已在页面头部。 */}
      <KpiCard
        label={t("cost.total.label")}
        tone="warn"
        value={loadingAll ? "…" : fmtTokens(s.totalTokens)}
        unit={t("cost.unit")}
        asOf={data?.asOf}
        hint={<Tooltip title={t("cost.total.hint", { n: fmtNum(s.measuredCalls) })}><span>{fmtNum(s.measuredCalls)} 次实测调用</span></Tooltip>}
        trend={data?.trend?.tokens}
        footer={
          <>
            <span>{t("cost.total.platform", { v: fmtCompact(s.platformTokens) })}</span>
            <span className="tiny">{t("cost.total.agent", { v: fmtCompact(s.agentTokens) })}</span>
            <span className={"tiny " + styles.estimateFoot} data-est={(s.estimatedTokens || 0) > 0}>
              {t("cost.estimatedShort", { v: fmtTokens(s.estimatedTokens) })}
            </span>
          </>
        }
      />
      <KpiCard
        label={t("cost.estimated.label")}
        tone={(s.estimatedTokens || 0) > 0 ? "warn" : "mute"}
        value={loadingAll ? "…" : fmtTokens(s.estimatedTokens)}
        unit={t("cost.unit")}
        hint={<Tooltip title={t("cost.estimated.hint")}><span>{t("cost.estimated.tag")}</span></Tooltip>}
        trend={data?.trend?.estimatedTokens}
        footer={
          <>
            <span>{t("cost.estimated.footer", { n: fmtNum(s.estimatedCalls), v: fmtTokens(s.agentEstimatedTokens) })}</span>
            <span className="tiny">{t("cost.estimated.combined", { v: fmtCompact(s.combinedTokens) })}</span>
          </>
        }
      />
      <KpiCard
        label={t("cost.agentReported.label")}
        tone={(s.agentTokens || 0) > 0 ? "ok" : "mute"}
        value={loadingAll ? "…" : fmtTokens(s.agentTokens)}
        unit={t("cost.unit")}
        hint={t("cost.agentReported.hint")}
        trend={data?.trend?.agentTokens}
        footer={
          <>
            <span>{t("cost.agentReported.footer", { n: fmtNum(s.agentCount), m: fmtNum(s.agentCalls) })}</span>
            <span className="tiny">{t("cost.share", { v: fmtPctOf(s.agentTokens, s.totalTokens, 2) })}</span>
          </>
        }
      />
      <KpiCard label={t("cost.calls.label")} tone="info" value={loadingAll ? "…" : fmtNum(s.calls)} unit="次" hint={t("cost.calls.hint", { ok: fmtNum(s.okCalls), fail: fmtNum(s.failCalls) })} trend={data?.trend?.calls} />
      {/* 2026-10-15（规范 §1）：百分比要带**分子/分母**，避免「比率无锚点」。 */}
      <KpiCard label="调用成功率" tone={(s.successRate ?? 0) >= 0.95 ? "ok" : "warn"} value={loadingAll ? "…" : fmtPct(s.successRate)} hint={loadingAll ? "…" : t("cost.successRate.hint") + " · " + fmtNum(s.okCalls) + "/" + fmtNum(s.calls)} />
      <KpiCard label={t("cost.avg.label")} tone="info" value={loadingAll ? "…" : fmtTokens(s.avgTokensPerMeasuredCall)} unit={t("cost.avg.unit")} hint={loadingAll ? "…" : t("cost.avg.hint", { n: fmtNum(Math.round((s.avgDurationMs || 0) / 1000)) })} />
      <KpiCard
        label={t("cost.unmeasured.label")}
        tone={s.unmeasuredCalls ? "warn" : "mute"}
        value={loadingAll ? "…" : fmtNum(s.unmeasuredCalls)}
        unit="次"
        hint={s.unmeasuredCalls ? t("cost.unmeasured.hint", { n: fmtNum(s.charsUnmeasured) }) : t("cost.unmeasured.all")}
      />
      <KpiCard
        label={t("cost.history.label")}
        tone="mute"
        value={loadingAll ? "…" : fmtCompact(all.tokens)}
        unit={t("cost.unit")}
        hint={t("cost.history.hint", { n: fmtNum(all.calls) })}
        footer={
          <span className="tiny">
            {t("cost.history.footer", { v: fmtCompact(all.estimatedTokens), since: all.firstAt ? fmtTime(all.firstAt) : "-" })}
          </span>
        }
      />
    </div>
  );
}
