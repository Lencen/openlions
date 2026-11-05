"use client";
// 2026-10-20 B7 收尾：/todo 的积压趋势（此前是 B7 唯一的缺口：6/7 页有趋势）。
// 口径由接口 /api/todo-backlog-trend 给出（新增=createdAt / 关闭=doneAt / 积压=期末未关闭），
// 前端只负责展示；取不到就明说"暂无时序数据"，不拿 0 冒充（规范铁律 2）。
// 2026-11-04 P1 收尾：内联样式清零（改 page.module.css 的 .trendPanel/.axisCol/... 类），取数未改。
import Sparkline from "@/components/Sparkline";
import LoadingBlock from "@/components/LoadingBlock";
import { useApi } from "@/lib/api";
import { fmtNum, fmtState } from "@/lib/format";
import styles from "../page.module.css";

export default function TodoBacklogTrend() {
  const { data, loading, error } = useApi<any>("/api/todo-backlog-trend");
  const days: any[] = Array.isArray(data?.days) ? data.days : [];
  const totals = data?.totals || {};
  const enough = days.length >= 2;
  const series = days.map((d) => Number(d.backlog) || 0);
  const start = Number(totals.backlogStart) || 0;
  const end = Number(totals.backlogEnd) || 0;
  const delta = end - start;

  return (
    <div className={"panel " + styles.trendPanel}>
      <div className="panel-header">
        <span className="panel-title">近 {data?.windowDays || 14} 天积压趋势</span>
      </div>
      <div className={styles.panelBody}>
        {loading && !data ? (
          <LoadingBlock lines={1} height={60} label="积压趋势加载中" />
        ) : error ? (
          <span className={styles.dim}>趋势取不到（{String((error as any)?.message || error).slice(0, 60)}）；下方列表与指标不受影响</span>
        ) : !enough ? (
          <span className={styles.dim}>暂无时序数据：读不到 Todo 的 createdAt / doneAt（库不可达或表为空），所以不画趋势（不拿 0 冒充）</span>
        ) : (
          <div className={styles.trendRow}>
            {/* 2026-10-25 R6：趋势图补「坐标轴语义」——此前只有一条线，读者不知道纵轴是几个人、
                横轴是哪几天（评审 §3-6）。这里给上/下界与首末日，单位写进标题。 */}
            <div className={styles.axisWrap}>
              <div className={styles.axisCol}>
                <span className={"tiny " + styles.num}>{fmtNum(Math.max(...series))}</span>
                <span className={"tiny " + styles.num}>{fmtNum(Math.min(...series))}</span>
              </div>
              <Sparkline data={series} width={560} height={56} />
              <div className={styles.axisColRight}>
                <span className="tiny">条</span>
                <span className="tiny">条</span>
              </div>
            </div>
            <div className={"tiny " + styles.min120}>
              {String(days[0]?.date ?? "")} → {String(days[days.length - 1]?.date ?? "")}
            </div>
            <span className={styles.dim}>
              期初 {fmtState(data ? start : undefined, { loading: loading && !data, error: !!error })} 条 → 现在 {fmtNum(end)} 条
              （{delta >= 0 ? "+" : ""}{delta}）；近 {data.windowDays} 天 新增 {fmtNum(Number(totals.added) || 0)} · 关闭 {fmtNum(Number(totals.closed) || 0)}
            </span>
          </div>
        )}
        {data?.basis ? <div className={styles.basis}>口径：{data.basis}</div> : null}
      </div>
    </div>
  );
}
