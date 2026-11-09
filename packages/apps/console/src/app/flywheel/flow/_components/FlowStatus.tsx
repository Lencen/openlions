"use client";
// flywheel/flow 页 · 心跳状态 + 积压告警面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批9：内联 style 清零（9 -> 0）；存活态的左边框颜色改由 data-alive 属性选择器承载。
//   取数（d / q）、文案与对外 props 形状未动；本组件不含表格。
import { t } from "@/i18n";
import type { FlowData } from "./types";
import { fmtAge, fmtN } from "./format";
import styles from "./FlowStatus.module.css";

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
      <div className={"panel " + styles.statusPanel} data-alive={alive}>
        <div className={styles.statusRow}>
          <span className={styles.statusTitle}>{alive ? "🟢 飞轮在转" : pausedWarn ? "🟡 最近 10 分钟无事件(可能健康暂停/轮间间隔)" : "⚪ 等待首轮"}</span>
          {d?.heartbeat?.lastEvent && (
            <span className={styles.metric}>
              最近事件 <b>{d.heartbeat.lastEvent.stage}</b> · {d.heartbeat.lastEvent.sourceType}
              {d.heartbeat.lastEvent.title ? " · " + String(d.heartbeat.lastEvent.title).slice(0, 60) : ""} · {fmtAge(age)} 前
            </span>
          )}
          {/* 2026-10-13 round 76-DR: 数据未到(d=null)时 q() 一律返回 0 -> 加载中显示"运行中任务: **0**"(实测就绪后是 1), 属假计数。 */}
          <span className={styles.metric}>LLM 调用 24h: <b>{d ? fmtN(d?.heartbeat?.llm24) : "…"}</b></span>
          <span className={styles.metric}>运行中任务: <b>{d ? fmtN(q("jobRunning")) : "…"}</b></span>
          {d?.heartbeat?.runningTheme && d.heartbeat.runningTheme.length > 0 && (
            <span className={styles.metric}>反思中主题: {d.heartbeat.runningTheme.map((r: any) => r.theme).join("、")}</span>
          )}
        </div>
      </div>

      {(q("sessionPending") > 300 || q("groupPending") > 500 || q("sessionFailed") > 100 || q("dlq") > 20) && (
        <div className={"panel " + styles.warnPanel}>
          <span className={styles.warnText}>{t('flow.backlog', { a: fmtN(q("sessionPending")), b: fmtN(q("groupPending")), c: fmtN(q("sessionFailed")), d: fmtN(q("dlq")) })}</span>
        </div>
      )}
    </>
  );
}
