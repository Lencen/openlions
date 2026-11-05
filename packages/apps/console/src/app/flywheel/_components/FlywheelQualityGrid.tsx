"use client";
// 数据质量 (堆叠条) + LLM 调用观测 + 错误分类
//
// 2026-11-04（ord-20261104-032）：呈现层内联样式清零（23 处 → 0），LLM 入口表由自写表格换成白名单 DataTable
//   （列：入口/调用/成功/平均耗时，一列没删）。动态色（质量档 / 错误类型 / resolver 动作）走 data-* 属性选择器。
//   取数、文案、数字口径未动。
import { QUALITY_LABELS, fmt } from "./shared";
import { t } from "@/i18n";
import { entityLabel } from "@/config/artifactTypes";
import type { DashboardData } from "./shared";
import { DataTable } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import TableCopyButton from "@/components/TableCopyButton";
import styles from "../page.module.css";

/** 5% 一档的宽度类（组件内不写内联 style） */
const pctClass = (v: number, m: Record<string, string>) =>
  m["p" + Math.round((Math.max(0, Math.min(1, v)) * 100) / 5) * 5] || m.p0;
const toneOfRate = (rate: number) => (rate >= 90 ? "ok" : rate >= 60 ? "warn" : "crit");

type Entry = DashboardData["llmStats"]["byEntry"][number];

export default function FlywheelQualityGrid({
  d,
  llmTotal,
  llmOkRate,
  totalErrors,
}: {
  d: DashboardData;
  llmTotal: number;
  llmOkRate: number;
  totalErrors: number;
}) {
  const entryColumns: DataColumn<Entry>[] = [
    { key: "entry", title: "入口", render: (en) => en.entry },
    { key: "calls", title: "调用", align: "right", render: (en) => en.calls },
    { key: "ok", title: "成功", align: "right", render: (en) => en.ok },
    { key: "avgMs", title: "平均耗时", align: "right", render: (en) => Math.round(en.avgMs) + "ms" },
  ];

  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-header"><span className="panel-title">数据质量分布</span></div>
        <div className="stack-legend">
          {(["high","mid","low","zero"] as const).map(k => (
            <span key={k} className={styles.qgLegendRow}>
              <span className={"dot " + styles.qgDot} data-band={k} />
              {QUALITY_LABELS[k]}
            </span>
          ))}
        </div>
        {(["memory","knowledge","reflection","practice"] as const).map(type => {
          const items = d.qualityByType[type] || [];
          const total = items.reduce((s: number, x: any) => s + x.c, 0) || 1;
          const byBand: Record<string, number> = { high: 0, mid: 0, low: 0, zero: 0 };
          items.forEach((q: any) => { byBand[q.b] = q.c; });
          return (
            <div key={type} className={styles.qgBlock}>
              <div className={styles.qgSub}>
                {entityLabel(type)} <span className={styles.qgTotal}>· {fmt(total)}</span>
              </div>
              <div className="stack-bar">
                {(["high","mid","low","zero"] as const).map(k => (
                  byBand[k] > 0 && (
                    <div key={k} className={"stack-seg " + styles.qgSeg + " " + pctClass(byBand[k] / total, styles as unknown as Record<string, string>)} data-band={k} />
                  )
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">LLM 调用观测 (24h)</span></div>
        {llmTotal === 0 ? (
          <div className={styles.qgEmpty}>暂无 CALL_LLM 事件 (P1-C 打点待首次 LLM 调用)</div>
        ) : (
          <>
            <div className={styles.qgStats}>
              <div><span className={styles.qgStatK}>总调用</span><div className={styles.qgStatV}>{fmt(llmTotal)}</div></div>
              <div><span className={styles.qgStatK}>成功</span><div className={styles.qgStatV} data-tone="ok">{fmt(d.llmStats.ok24h)}</div></div>
              <div><span className={styles.qgStatK}>失败</span><div className={styles.qgStatV} data-tone="crit">{fmt(d.llmStats.fail24h)}</div></div>
              <div><span className={styles.qgStatK}>成功率</span><div className={styles.qgStatV} data-tone={toneOfRate(llmOkRate)}>{llmOkRate}%</div></div>
            </div>
            <TableCopyButton />
            <DataTable columns={entryColumns} rows={d.llmStats.byEntry} rowKey={(en) => en.entry} />
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">错误分类 (24h)</span></div>
        {d.errors.length === 0 ? (
          <div className={styles.qgEmptyOk}>✅ 无错误</div>
        ) : (
          <>
            {d.errors.map(e => (
              <div key={e.errorType} className={"theme-row " + styles.qgErrRow}>
                <span className={"theme-name " + styles.qgErrName} data-err={e.errorType}>{e.errorType}</span>
                <div className="theme-bar-wrap">
                  <div className={"theme-bar " + styles.qgErrBar + " " + pctClass(e.cnt / totalErrors, styles as unknown as Record<string, string>)} data-err={e.errorType} />
                </div>
                <span className="theme-cnt">{e.cnt}</span>
              </div>
            ))}
            <div className={styles.qgRes}>
              {t('biz.resolver.decision1h')}
              {d.resolverStats.length === 0 ? <span> 无数据</span> : d.resolverStats.map(r => (
                <span key={r.resolverAction} className={styles.qgResItem}>
                  <strong className={styles.qgResNum} data-act={r.resolverAction}>{r.cnt}</strong> {r.resolverAction}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
