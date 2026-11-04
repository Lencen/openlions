"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";

// 飞轮执行数据记录 (2026-09-01 重构) — 业务审计
// 时间线: 什么时间扫描/提炼/反思/改进 + 错误记录

interface AuditData {
  events: Array<{ stage: string; sourceType: string; sourceTitle: string; createdAt: number }>;
  errors: Array<{ errorType: string; stage: string; sessionId: string; message: string; occurredAt: number }>;
  byStage: Array<{ stage: string; c: number }>;
  todayEvents: number;
  todayErrors: number;
}

// 2026-10-13 round 76-CU: 徽标文字原来写死深色墨 #0a0e1a —— 亮色主题下压在 --brand(#0B6E82) 上只有 ~3.1,
//   暗色下才勉强对。改用通用墨色令牌 --on-accent(亮 #fff / 暗 #0a0e14 / hc #000), 三主题都对。
const STAGE_COLORS: Record<string, string> = {
  MEMORIZE: "var(--table-memory)", KNOWLEDGE: "var(--brand)", REFLECT: "var(--status-crit)", PRACTICE: "var(--warn)",
  EVALUATE: "var(--info)", LEARN: "var(--info)", CALL_LLM: "var(--text-3)", OUTCOME: "var(--status-ok)",
  REFLECTION_TO_TASK: "var(--warn)",
};

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  // P1-6: 固定 Asia/Shanghai, 防 UTC 机器上时间差 8h
  return d.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) + " " +
    d.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
};

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
      <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>飞轮引擎</span><span className="sep">/</span><span className="current">执行数据记录</span></div>
      <div className="page-header"><div className="page-title">执行数据记录（业务审计）</div>
        <div className="page-subtitle">今日事件 {data?.todayEvents ?? "-"} · 错误 {data?.todayErrors ?? "-"} · 15s 刷新</div>
      </div>
      {error && <div style={{ color: "var(--status-crit)", marginBottom: "var(--sp-2)" }}>⚠ {error}</div>}

      {/* 今日各阶段统计 */}
      <div className="panel">
        <div className="panel-header"><span className="panel-title">今日执行分布</span></div>
        <div style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap" }}>
          {byStage.map((s) => (
            <div key={s.stage} style={{ fontSize: "var(--fs-md)" }}>
              <span className="badge" style={{ background: STAGE_COLORS[s.stage] || "var(--text-3)", color: "var(--on-accent)" }}>{s.stage}</span>{" "}
              <strong>{s.c}</strong>
            </div>
          ))}
          {loading && <span style={{ color: "var(--text-dim)" }}>加载中…</span>}
          {!loading && byStage.length === 0 && <span style={{ color: "var(--text-dim)" }}>今日暂无</span>}
        </div>
      </div>

      {/* 阶段过滤 + 错误切换 */}
      <div className="panel" style={{ marginBottom: "var(--sp-3)" }}>
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setStage("")} style={{ padding: "var(--sp-1) var(--sp-2-5)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: stage === "" ? "var(--primary)" : "transparent", color: stage === "" ? "var(--on-primary)" : "var(--text)", fontWeight: stage === "" ? 600 : 400, cursor: "pointer", fontSize: "var(--fs-base)" }}>全部</button>
          {Object.keys(STAGE_COLORS).map((s) => (
            <button key={s} onClick={() => setStage(stage === s ? "" : s)} style={{ padding: "var(--sp-1) var(--sp-2-5)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: stage === s ? "var(--primary)" : "transparent", color: stage === s ? "var(--on-primary)" : "var(--text)", fontWeight: stage === s ? 600 : 400, cursor: "pointer", fontSize: "var(--fs-base)" }}>{s}</button>
          ))}
          <span style={{ marginLeft: "auto" }}>
            <button onClick={() => setShowErrors(!showErrors)} style={{ padding: "var(--sp-1) var(--sp-2-5)", borderRadius: "var(--radius-sm)", border: "1px solid var(--status-crit)", background: showErrors ? "var(--status-crit)" : "transparent", color: showErrors ? "var(--on-accent)" : "var(--status-crit)", cursor: "pointer", fontSize: "var(--fs-base)" }}>错误记录 ({errors.length})</button>
          </span>
        </div>
      </div>

      {/* 时间线 */}
      {!showErrors ? (
        <div className="panel">
          <div className="panel-header"><span className="panel-title">执行时间线 (最近 50 条)</span></div>
          <TableCopyButton />
          <table className="tbl"><thead><tr><th>时间</th><th>阶段</th><th>来源</th><th>详情</th></tr></thead><tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(e.createdAt)}</td>
                <td><span className="badge" style={{ background: STAGE_COLORS[e.stage] || "var(--text-3)", color: "var(--on-accent)", fontSize: "var(--fs-sm)" }}>{e.stage}</span></td>
                <td style={{ fontSize: "var(--fs-base)" }}>{e.sourceType}</td>
                <td style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>{(e.sourceTitle || "").slice(0, 60)}</td>
              </tr>
            ))}
            {/* 2026-10-13 round 76-DY: 加载中 events 还是空数组 -> 会显示「暂无事件」(实测就绪后有事件) -> 假空态。
                同页上方那处 [今日暂无] 早就用 loading 守卫了, 表格这处漏了。 */}
            {loading ? <tr><td colSpan={4} style={{ padding: "var(--sp-4)", color: "var(--text-dim)", textAlign: "center" }}>…</td></tr> : events.length === 0 && <tr><td colSpan={4} style={{ padding: "var(--sp-4)", color: "var(--text-dim)", textAlign: "center" }}>暂无事件</td></tr>}
          </tbody></table>
        </div>
      ) : (
        <div className="panel">
          <div className="panel-header"><span className="panel-title">错误记录 (最近 20 条)</span></div>
          <TableCopyButton />
          <table className="tbl"><thead><tr><th>时间</th><th>类型</th><th>阶段</th><th>{t('common.session')}</th><th>消息</th></tr></thead><tbody>
            {errors.map((e, i) => (
              <tr key={i}>
                <td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(e.occurredAt)}</td>
                <td><span className="badge badge-red">{e.errorType}</span></td>
                <td>{e.stage}</td>
                <td className="mono" style={{ fontSize: "var(--fs-sm)" }}>{(e.sessionId || "").slice(0, 30)}</td>
                <td style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>{(e.message || "").slice(0, 60)}</td>
              </tr>
            ))}
            {errors.length === 0 && <tr><td colSpan={5} style={{ padding: "var(--sp-4)", color: "var(--status-ok)", textAlign: "center" }}>✅ 无错误</td></tr>}
          </tbody></table>
        </div>
      )}
      {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/flywheel/tasks">被审任务 →</Link>
        <Link href="/system/guards">守门规则 →</Link>
      </div>
    </main></div>
  );
}
