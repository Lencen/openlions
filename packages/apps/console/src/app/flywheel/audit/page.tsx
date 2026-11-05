"use client";
// 飞轮执行数据记录 (2026-09-01 重构) — 业务审计
// 时间线: 什么时间扫描/提炼/反思/改进 + 错误记录
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 两张手写 .tbl 表 → 白名单 DataTable。
//   列/字段/文案不变；阶段徽标底色从内联 STAGE_COLORS 改成 [data-stage] 属性选择器（默认底仍是 --text-3）。
//   取数（/api/flywheel-audit?limit=50&stage=…）、15s 轮询与 AbortController 一字未改。
import { useEffect, useState } from "react";
import Link from "next/link";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface AuditData {
  events: Array<{ stage: string; sourceType: string; sourceTitle: string; createdAt: number }>;
  errors: Array<{ errorType: string; stage: string; sessionId: string; message: string; occurredAt: number }>;
  byStage: Array<{ stage: string; c: number }>;
  todayEvents: number;
  todayErrors: number;
}

// 2026-10-13 round 76-CU: 徽标文字原来写死深色墨 #0a0e1a —— 亮色主题下压在 --brand(#0B6E82) 上只有 ~3.1,
//   暗色下才勉强对。改用通用墨色令牌 --on-accent(亮 #fff / 暗 #0a0e14 / hc #000), 三主题都对。
// 2026-11-05 P2：底色不再走内联 map —— 这里只保留「有哪些阶段」（顺序 = 改前 map 的键顺序），
//   每个阶段的底色在 page.module.css 的 .stageBadge[data-stage="…"] 里。
const STAGE_KEYS = [
  "MEMORIZE", "KNOWLEDGE", "REFLECT", "PRACTICE",
  "EVALUATE", "LEARN", "CALL_LLM", "OUTCOME",
  "REFLECTION_TO_TASK",
];

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  // P1-6: 固定 Asia/Shanghai, 防 UTC 机器上时间差 8h
  return d.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) + " " +
    d.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
};

type EventRow = AuditData["events"][number];
type ErrorRow = AuditData["errors"][number];

const eventColumns: DataColumn<EventRow>[] = [
  { key: "createdAt", title: "时间", render: (e) => <span className={"nowrap mono " + styles.cellSm}>{fmtTime(e.createdAt)}</span> },
  {
    key: "stage",
    title: "阶段",
    render: (e) => <span className={"badge " + styles.stageBadge + " " + styles.stageBadgeSm} data-stage={e.stage}>{e.stage}</span>,
  },
  { key: "sourceType", title: "来源", render: (e) => <span className={styles.cellBase}>{e.sourceType}</span> },
  { key: "sourceTitle", title: "详情", render: (e) => <span className={styles.cellDim}>{(e.sourceTitle || "").slice(0, 60)}</span> },
];

const errorColumns: DataColumn<ErrorRow>[] = [
  { key: "occurredAt", title: "时间", render: (e) => <span className={"nowrap mono " + styles.cellSm}>{fmtTime(e.occurredAt)}</span> },
  { key: "errorType", title: "类型", render: (e) => <span className="badge badge-red">{e.errorType}</span> },
  { key: "stage", title: "阶段", render: (e) => <>{e.stage}</> },
  { key: "sessionId", title: t('common.session'), render: (e) => <span className={"mono " + styles.cellSm}>{(e.sessionId || "").slice(0, 30)}</span> },
  { key: "message", title: "消息", render: (e) => <span className={styles.cellDim}>{(e.message || "").slice(0, 60)}</span> },
];

export default function AuditPage() {
  const [data, setData] = useState<AuditData | null>(null);
  const [stage, setStage] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // P1-7 (2026-09-07): AbortController — 快速切换 stage 时取消旧请求, 防 stale 覆盖
    const ac = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/flywheel-audit?limit=50&${stage ? "stage=" + stage : ""}`, { signal: ac.signal });
        const d = await res.json();
        if (d.error) setError(d.error);
        else setData(d);
      } catch (e: any) { if (e?.name !== "AbortError") setError(e.message); }
    };
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15000);
    return () => { ac.abort(); clearInterval(t); };
  }, [stage]);

  const events = data?.events ?? [];
  const errors = data?.errors ?? [];
  const byStage = data?.byStage ?? [];
  // 2026-10-13 round 76-CW: 补**加载态**。原来首帧 data 为 null 时直接走到"今日暂无"——
  //   那与"今天真的没有事件"**无法区分**(假空态), 慢网络下用户会以为飞轮没跑。
  const loading = !data && !error;

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb"><span className={styles.crumbDim}>飞轮引擎</span><span className="sep">/</span><span className="current">执行数据记录</span></div>
      <PageHeader><PageTitle>执行数据记录（业务审计）</PageTitle>
        <div className="page-subtitle">今日事件 {data?.todayEvents ?? "-"} · 错误 {data?.todayErrors ?? "-"} · 15s 刷新</div>
      </PageHeader>
      {error && <div className={styles.errLine}>⚠ {error}</div>}

      {/* 今日各阶段统计 */}
      <div className="panel">
        <div className="panel-header"><span className="panel-title">今日执行分布</span></div>
        <div className={styles.stageRow}>
          {byStage.map((s) => (
            <div key={s.stage} className={styles.stageItem}>
              <span className={"badge " + styles.stageBadge} data-stage={s.stage}>{s.stage}</span>{" "}
              <strong>{s.c}</strong>
            </div>
          ))}
          {loading && <span className={styles.dimText}>加载中…</span>}
          {!loading && byStage.length === 0 && <span className={styles.dimText}>今日暂无</span>}
        </div>
      </div>

      {/* 阶段过滤 + 错误切换 */}
      <div className={"panel " + styles.panelMb3}>
        <div className={styles.filterRow}>
          <button onClick={() => setStage("")} className={styles.filterBtn} data-active={stage === "" ? "true" : undefined}>全部</button>
          {STAGE_KEYS.map((s) => (
            <button key={s} onClick={() => setStage(stage === s ? "" : s)} className={styles.filterBtn} data-active={stage === s ? "true" : undefined}>{s}</button>
          ))}
          <span className={styles.pushRight}>
            <button onClick={() => setShowErrors(!showErrors)} className={styles.filterBtn + " " + styles.filterBtnCrit} data-active={showErrors ? "true" : undefined}>错误记录 ({errors.length})</button>
          </span>
        </div>
      </div>

      {/* 时间线 */}
      {!showErrors ? (
        <div className="panel">
          <div className="panel-header"><span className="panel-title">执行时间线 (最近 50 条)</span></div>
          <TableCopyButton />
          {/* 2026-10-13 round 76-DY: 加载中 events 还是空数组 -> 会显示「暂无事件」(实测就绪后有事件) -> 假空态。
              同页上方那处 [今日暂无] 早就用 loading 守卫了, 表格这处漏了 —— 这里由 DataTable 的 loading 槽承接。 */}
          <DataTable
            columns={eventColumns}
            rows={events}
            rowKey={(_e, i) => i}
            loading={loading}
            empty={{ title: "暂无事件" }}
          />
        </div>
      ) : (
        <div className="panel">
          <div className="panel-header"><span className="panel-title">错误记录 (最近 20 条)</span></div>
          <TableCopyButton />
          <DataTable
            columns={errorColumns}
            rows={errors}
            rowKey={(_e, i) => i}
            empty={{ title: "✅ 无错误" }}
          />
        </div>
      )}
      {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className={"tiny " + styles.related}>
        <span>相关视图：</span>
        <Link href="/flywheel/tasks">被审任务 →</Link>
        <Link href="/system/guards">守门规则 →</Link>
      </div>
    </main></div>
  );
}
