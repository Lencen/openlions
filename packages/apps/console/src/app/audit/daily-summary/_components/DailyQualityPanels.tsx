"use client";
import type { DailyReport } from "./shared";
import styles from "../page.module.css";

const QUALITY_LABELS: Record<string, string> = { high: "高", mid: "中", low: "低", zero: "未评分" };
// 2026-11-05 P2 呈现层：原来这里是 QUALITY_COLORS / ERROR_COLORS 两张色表 + errBg()（拼 color-mix），
//   内联到 style。现改为语气键 data-tone / 错误类型 data-err，令牌本体移到 ../page.module.css
//   （与 flywheel/_components/shared.ts 的 --err-* 令牌同源，未新增硬编码色）。
const QUALITY_TONES: Record<string, string> = { high: "ok", mid: "warn", low: "dim", zero: "muted" };
const ERR_TYPES = ["RATE_LIMIT", "SCHEMA_INVALID", "NETWORK", "AUTH_ERROR", "TIMEOUT", "UNKNOWN", "SERVER_ERROR"];

/** 数据质量 / 热门主题 / 改进任务 / 错误分类 */
export default function DailyQualityPanels({ d }: { d: DailyReport }) {
  return (
    <>
      <div className="grid-2">
        {/* 数据质量 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">数据质量（记忆）</span></div>
          <div className={styles.dqRow}>
            {Object.entries(d.quality).map(([k, v]) => (
              <div key={k} className={styles.dqCell}>
                <div className={styles.dqVal} data-tone={QUALITY_TONES[k] || undefined}>{v}</div>
                <div className={styles.dqLabel}>{QUALITY_LABELS[k] || k}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 热门主题 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">热门主题</span></div>
          <div className={styles.dqChipWrap}>
            {d.themes.map((t) => (
              <span key={t.theme} className="badge badge-blue">{t.theme} <b>{t.count}</b></span>
            ))}
            {d.themes.length === 0 && <span className={styles.dhEmpty}>无</span>}
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* 改进任务 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">改进任务</span></div>
          <div className={styles.dhPadY}>
            <div className={styles.dhCap}>完成</div>
            <div className={styles.dhChipsGap}>
              {d.tasks.done.map((t) => (
                <span key={t.type} className="badge badge-green">{t.type} <b>{t.count}</b></span>
              ))}
              {d.tasks.done.length === 0 && <span className={styles.dhEmpty}>无</span>}
            </div>
            <div className={styles.dhCap}>积压</div>
            <div className={styles.dhChips}>
              {d.tasks.pending.map((t) => (
                <span key={t.type} className="badge badge-red">{t.type} <b>{t.count}</b></span>
              ))}
              {d.tasks.pending.length === 0 && <span className={styles.dhEmpty}>无</span>}
            </div>
          </div>
        </div>

        {/* 错误分类 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">错误分类</span></div>
          <div className={styles.dqChipWrap}>
            {d.errors.map((e) => (
              <span key={e.type} className={"badge " + styles.dqErrBadge} data-err={ERR_TYPES.includes(e.type) ? e.type : "UNKNOWN"}>
                {e.type} <b>{e.count}</b>
              </span>
            ))}
            {d.errors.length === 0 && <span className={styles.dhOk}>✅ 无错误</span>}
          </div>
        </div>
      </div>
    </>
  );
}
