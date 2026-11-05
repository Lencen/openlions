"use client";
// 2026-11-05 P2 批2：宽度与步骤色从内联 style 改为 data-w 档位 + data-tone 属性选择器
//   （见 FunnelChart.module.css）。语义色只认下方白名单，其它颜色按主色处理。
import styles from "./FunnelChart.module.css";

interface Step { label: string; count: number; color: string; }
interface Props { steps: Step[]; }

/** 步骤色 -> 语义色调（设计令牌）；未登记的色按主色处理。 */
const TONE: Record<string, string> = {
  "var(--status-ok)": "ok",
  "var(--status-warn)": "warn",
  "var(--status-crit)": "crit",
  "var(--primary)": "primary",
  "var(--table-memory)": "memory",
  "var(--table-knowledge)": "knowledge",
};

export default function FunnelChart({ steps }: Props) {
  const max = steps[0]?.count || 1;
  return (
    <div className="funnel">
      {steps.map((s, i) => {
        const pct = Math.min(100, Math.max(0, Math.round((s.count / max) * 100)));
        const conv = i > 0 ? ((s.count / steps[i - 1].count) * 100).toFixed(0) : "100";
        return (
          <div key={i} className="funnel-step">
            <span className="step-label">{s.label}</span>
            <div
              className={"step-bar " + styles.bar}
              data-w={pct}
              data-tone={TONE[s.color] ?? "primary"}
            >
              <span className={styles.conv}>{conv}%</span>
            </div>
            <span className="step-count">{s.count.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
