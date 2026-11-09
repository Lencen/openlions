"use client";
// flywheel/flow 页 · 取数失败提示条
// 2026-11-05 页头口径统一（UIUX PAGE-HEADER-31 §3 #10）：面包屑/标题/一句说明已上移到 page.tsx，
//   本文件只剩错误提示。文件名沿用 FlowHeader（仅 page.tsx 引用），不改名以免扩大改动面。
import styles from "../page.module.css";

export default function FlowHeader({ err }: { err: string }) {
  if (!err) return null;
  return <div className={styles.flowErr}>⚠ {err}</div>;
}
