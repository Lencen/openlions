"use client";
// flywheel/flow 页 · 心跳状态 + 积压告警面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { t } from "@/i18n";
import type { FlowData } from "./types";
import { fmtAge, fmtN } from "./format";

export default function FlowStatus({
  d,
  age,
  alive,
  pausedWarn,
  q,
}: {
  d: FlowData | null;
  age: number;
  alive: boolean;
  pausedWarn: boolean;
  q: (k: string) => number;
}) {
  return (
    <>
      <div className="panel" style={{ borderLeft: alive ? "4px solid var(--status-ok)" : "4px solid var(--status-warn)", marginBottom: "var(--sp-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--fs-xl)", fontWeight: 700 }}>{alive ? "🟢 飞轮在转" : pausedWarn ? "🟡 最近 10 分钟无事件(可能健康暂停/轮间间隔)" : "⚪ 等待首轮"}</span>
          {d?.heartbeat?.lastEvent && (
            <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>
              最近事件 <b>{d.heartbeat.lastEvent.stage}</b> · {d.heartbeat.lastEvent.sourceType}
              {d.heartbeat.lastEvent.title ? " · " + String(d.heartbeat.lastEvent.title).slice(0, 60) : ""} · {fmtAge(age)} 前
            </span>
          )}
          {/* 2026-10-13 round 76-DR: 数据未到(d=null)时 q() 一律返回 0 -> 加载中显示"运行中任务: **0**"(实测就绪后是 1), 属假计数。 */}
          <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>LLM 调用 24h: <b>{d ? fmtN(d?.heartbeat?.llm24) : "…"}</b></span>
          <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>运行中任务: <b>{d ? fmtN(q("jobRunning")) : "…"}</b></span>
          {d?.heartbeat?.runningTheme && d.heartbeat.runningTheme.length > 0 && (
            <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>反思中主题: {d.heartbeat.runningTheme.map((r: any) => r.theme).join("、")}</span>
          )}
        </div>
      </div>

      {(q("sessionPending") > 300 || q("groupPending") > 500 || q("sessionFailed") > 100 || q("dlq") > 20) && (
        <div className="panel" style={{ borderLeft: "4px solid var(--status-crit)", marginBottom: "var(--sp-4)" }}>
          <span style={{ fontSize: "var(--fs-md)" }}>{t('flow.backlog', { a: fmtN(q("sessionPending")), b: fmtN(q("groupPending")), c: fmtN(q("sessionFailed")), d: fmtN(q("dlq")) })}</span>
        </div>
      )}
    </>
  );
}
