"use client";
/**
 * FlywheelImprovementPanel.tsx — 飞轮第⑥段「改进行动」执行明细（2026-10-23）
 *
 * 背景：后端确认「改进任务的审核/执行状态走 console 的 /todo 或 /flywheel，不单独开页面」。
 *   此前 /flywheel 只统计第⑥段的完成数（一个数字），看不到"谁在跑、卡在哪、为什么失败"。
 *   这里接 /api/flywheel-tasks?scope=MECHANISM（真实任务表），展示：
 *     - 按状态分布（进行中 / 待办 / 阻塞 / 失败 / 已完成；已废弃折叠）
 *     - 最近 6 条改进任务（标题 + 状态 chip + 更新时间）
 *     - 出口链接：/flywheel/executions（全部执行记录）
 * 状态 chip 复用消息页的 .msg-state 配色，保证全站同一套语义色。
 */
import Link from "next/link";
import { useApi } from "@/lib/api";
import styles from "../page.module.css";

const ORDER = ["IN_PROGRESS", "PENDING", "BLOCKED", "FAILED", "DONE"] as const;
const LABEL: Record<string, string> = {
  IN_PROGRESS: "进行中", PENDING: "待办", BLOCKED: "阻塞", FAILED: "失败", DONE: "已完成",
  DEPRECATED: "已废弃", DROPPED: "已丢弃",
};
const CHIP: Record<string, string> = {
  IN_PROGRESS: "s-processing", PENDING: "s-pending", BLOCKED: "s-stale",
  FAILED: "s-failed", DONE: "s-delivered", DEPRECATED: "s-stale", DROPPED: "s-stale",
};

const fmt = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false }).slice(5, 16);
};

export default function FlywheelImprovementPanel() {
  const { data, loading, error } = useApi<any>("/api/flywheel-tasks?scope=MECHANISM&limit=6", { pollMs: 60000 });
  const byStatus: Record<string, number> = data?.counts?.byStatus || {};
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const deprecated = (byStatus.DEPRECATED || 0) + (byStatus.DROPPED || 0);

  return (
    <section className={"panel " + styles.fiPanel}>
      <div className={"panel-header " + styles.fiHead}>
        <span className={"panel-title " + styles.fiTitle}>
          ⑥ 改进行动 · 执行明细
        </span>
        <Link href="/flywheel/executions" className={styles.fiLink}>
          全部执行记录 →
        </Link>
      </div>

      {error ? (
        <div className="msg-error" role="alert"><span>改进任务读取失败：{String((error as any)?.message || error).slice(0, 60)}</span></div>
      ) : loading && !data ? (
        <div className={"tiny " + styles.fiMuted}>正在读取改进任务…</div>
      ) : (
        <>
          <div className="fi-chips">
            {ORDER.map((k) => (
              <span key={k} className={"msg-state " + CHIP[k]}>
                {LABEL[k]} {Number(byStatus[k] || 0).toLocaleString("zh-CN")}
              </span>
            ))}
            {deprecated > 0 ? (
              <span className="msg-state s-stale" title="历史遗留类型（DEPRECATED/DROPPED），不计入改进口径">
                已废弃 {deprecated.toLocaleString("zh-CN")}
              </span>
            ) : null}
          </div>

          {items.length === 0 ? (
            <div className={"tiny " + styles.fiMuted}>当前没有改进任务。</div>
          ) : (
            <ul className="fi-list">
              {items.map((t) => {
                const st = String(t.status || "").toUpperCase();
                return (
                  <li key={t.id} className="fi-row">
                    <span className={"msg-state " + (CHIP[st] || "s-pending")}>{LABEL[st] || st || "—"}</span>
                    <span className="fi-title" title={t.title}>{t.title || "(无标题)"}</span>
                    <span className="fi-time">{fmt(t.doneAt || t.updatedAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className={"tiny " + styles.fiNote}>
            口径：任务表 improvementType ∈ 机制修复（GOAL_GAP / THEME_IMPROVE / PLATFORM_REVIEW）· 数据时刻 {fmt(data?.asOf)}
          </div>
        </>
      )}
    </section>
  );
}