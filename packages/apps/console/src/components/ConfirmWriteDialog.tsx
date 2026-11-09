"use client";
// 2026-11-09 · 0.4.40-04：平台写操作二次确认弹窗（PLATFORM-WRITE-UX §1–§3）
//   规范要点：展示变更摘要 + before/after 对比表 + 风险提示 + 勾选确认；
//   Esc = 取消；主按钮 danger 语义；对比表只读；>20 项时只列前 20 + 「另有 N 项」。
//   本组件只管"确认"，不自己发请求 —— 提交与错误回填由调用方通过 onConfirm / busy / error 传入。
import { useEffect, useRef } from "react";
import styles from "./ConfirmWriteDialog.module.css";

export type WriteChange = {
  /** 字段名（中文 + 英文 key，规范 §3 第 1 列） */
  field: string;
  /** 原值；空值显示「（空）」 */
  before: string;
  /** 新值；删除显示「（删除）」 */
  after: string;
  /** 新增 / 修改 / 删除 / 未变 */
  change: "新增" | "修改" | "删除" | "未变";
};

export default function ConfirmWriteDialog({
  open,
  title,
  summary,
  changes,
  risk,
  acknowledged,
  onAcknowledge,
  busy,
  error,
  confirmText = "确认提交",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title?: string;
  summary?: string;
  changes: WriteChange[];
  risk?: string;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  busy?: boolean;
  error?: string | null;
  confirmText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // 规范 §2 可访问性：弹窗打开后焦点进入弹窗；Esc = 取消
    const t = window.setTimeout(() => firstRef.current?.focus(), 20);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(t); document.removeEventListener("keydown", onKey); };
  }, [open, busy, onCancel]);

  if (!open) return null;
  const shown = changes.slice(0, 20);
  const rest = changes.length - shown.length;

  return (
    <div className={styles.mask} onMouseDown={() => { if (!busy) onCancel(); }}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title || "确认修改平台配置？"}
        ref={boxRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.head}>
          <div className={styles.title}>{title || "确认修改平台配置？"}</div>
          <div className={styles.summary}>
            {summary || "本次将修改 " + changes.length + " 项配置，变更立即生效。请确认下方「原值 → 新值」无误。"}
          </div>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>字段</th><th>原值</th><th>新值</th><th>变化</th></tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.field}>
                  <td className={styles.field}>{c.field}</td>
                  <td className={styles.old}>{c.before || "（空）"}</td>
                  <td className={styles.new}>{c.after || "（删除）"}</td>
                  <td><span className={styles.tag + " " + styles["tag" + (c.change === "新增" ? "Add" : c.change === "删除" ? "Del" : c.change === "未变" ? "Same" : "Mod")]}>{c.change}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {rest > 0 ? <div className={styles.rest}>另有 {rest} 项未展开</div> : null}
        </div>

        {risk ? <div className={styles.risk}>{risk}</div> : null}
        {error ? <div className={styles.error} role="alert">{error}</div> : null}

        <label className={styles.check}>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={!!busy}
            onChange={(e) => onAcknowledge(e.target.checked)}
          />
          <span>我已核对变更内容，确认提交</span>
        </label>

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel} disabled={!!busy}>取消</button>
          <button
            type="button"
            ref={firstRef}
            className={styles.confirm}
            onClick={onConfirm}
            disabled={!!busy || !acknowledged}
            title={acknowledged ? "立即生效，无二次撤销" : "需先勾选「我已核对变更内容」"}
          >
            {busy ? "提交中…" : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
