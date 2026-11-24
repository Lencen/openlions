"use client";
import type { ReactNode } from "react";
import styles from "./Bento.module.css";

/** 四态统一渲染（empty ≠ unavailable；error 显示原因+重试；forbidden 整页替换）。 */
export default function BentoState({ phase, title, detail, onRetry, children }: {
  phase: "loading" | "empty" | "error" | "unavailable" | "forbidden";
  title?: string; detail?: ReactNode; onRetry?: () => void; children?: ReactNode;
}) {
  if (phase === "loading") {
    return <div className={styles.state} data-phase="loading" role="status" aria-busy="true"><span className={styles.skel} aria-hidden="true" /><p>加载中…</p></div>;
  }
  const tone = phase === "forbidden" ? "crit" : phase === "error" ? "warn" : "mute";
  // 2026-11-19 设计 实测「失败态 role=alert 节点数=0，屏幕阅读器拿不到播报」。
  // 注意 axe 不会报这条——它只测已有 DOM 的属性错，不测「该出现而没出现」。
  // 异步落到失败态属 urgent -> alert；空态非紧急 -> status（aria-live 由 role 隐含）。
  const liveRole = phase === "empty" ? "status" : "alert";
  return (
    <div className={styles.state} data-phase={phase} data-tone={tone} role={liveRole}>
      <strong>{title || (phase === "empty" ? "暂无数据" : phase === "error" ? "加载失败" : phase === "forbidden" ? "无权限" : "数据不可得")}</strong>
      {detail ? <p>{detail}</p> : null}
      {onRetry ? <button type="button" className="btn" onClick={onRetry}>重试</button> : null}
      {children}
    </div>
  );
}
