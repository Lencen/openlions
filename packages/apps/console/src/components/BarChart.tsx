"use client";
// BarChart · P2 呈现层（批1）：内联样式清零，只换承载方式。
//   · 颜色：调用方传的是 globals 的令牌字符串，改走 data-tone + CSS 属性选择器（映射见下 TONES）；
//   · 宽度：改走 1% 档位类（.p0~.p100，见 BarChart.module.css），四舍五入到整数百分比，肉眼无差。
//   ⚠ 新增调用色请同步 TONES 与 BarChart.module.css；未登记的颜色回退主色。
import styles from "./BarChart.module.css";

interface Bar { label: string; value: number; color: string; }
interface Props { bars: Bar[]; }

/** 令牌字符串 -> 语气键（与 BarChart.module.css 的 [data-tone] 一一对应） */
const TONES: Record<string, string> = {
  "var(--primary)": "primary",
  "var(--brand)": "brand",
  "var(--info)": "info",
  "var(--text-muted)": "muted",
  "var(--text-3)": "text3",
  "var(--status-ok)": "ok",
  "var(--status-warn)": "warn",
  "var(--status-crit)": "crit",
  "var(--table-memory)": "memory",
  "var(--table-knowledge)": "knowledge",
  "var(--table-practice)": "practice",
  "var(--table-skill)": "skill",
  "var(--table-reflection)": "reflection",
};

export default function BarChart({ bars }: Props) {
  const max = Math.max(...bars.map(b => b.value), 1);
  return (
    <div className="bar-chart">
      {bars.map((b, i) => {
        // 非 0 值至少给 1%：否则占比 <0.5% 的条会被取整成 0 宽（改前是连续宽度，看得见一条细线）
        const pct = b.value > 0 ? Math.min(100, Math.max(1, Math.round((b.value / max) * 100))) : 0;
        return (
          <div key={i} className="bar-row">
            <span className="bar-label">{b.label}</span>
            <div className="bar-track">
              <div
                className={`bar-fill ${styles.fill} ${styles["p" + pct]}`}
                data-tone={TONES[b.color] || "primary"}
              />
            </div>
            <span className="bar-value">{b.value.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
