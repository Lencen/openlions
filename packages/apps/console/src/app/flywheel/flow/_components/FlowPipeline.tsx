"use client";
// flywheel/flow 页 · 7 步流水线面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批6（B/飞轮业务）：内联 style 清零（12 → 0）。
//   阶段色（接口 color 字段的 var(--info)/--table-knowledge/--table-practice/--status-ok 四个令牌）
//   与「本 5 分钟在动」态改由 [data-tone] / [data-live] 属性选择器承载；取数量与 props 未动。
import type { Step } from "./types";
import { fmtN } from "./format";
import styles from "./FlowPipeline.module.css";

/** 接口 color 字段 -> data-tone 取值（四个已知令牌；新增令牌会落到默认中性色） */
const TONE_BY_COLOR: Record<string, string> = {
  "var(--info)": "info",
  "var(--table-knowledge)": "knowledge",
  "var(--table-practice)": "practice",
  "var(--status-ok)": "ok",
};

export default function FlowPipeline({ steps }: { steps: Step[] }) {
  return (
    <div className={"panel " + styles.wrap}>
      <div className="panel-header">
        <span className="panel-title">飞轮 7 步流水线 · 实时量(5分钟 / 1小时 / 24小时)</span>
        <span className={styles.headerNote}>节点量 = 该步近窗工作量(口径见卡内说明, 2026-09-09 修正映射); 绿点=本 5 分钟在动</span>
      </div>
      <div className={styles.steps}>
        {steps.map((s, i) => {
          const live = (s.qty?.m5 || 0) > 0;
          return (
            <div key={s.id} className={styles.step} data-tone={TONE_BY_COLOR[s.color] ?? "default"}>
              <div className={styles.stepBox} data-live={live}>
                <div className={styles.headRow}>
                  <div className={styles.stepLabel}>{s.label}</div>
                  {live && <span className={styles.dot} title="本5分钟在动" />}
                </div>
                <div className={styles.desc}>{s.desc}</div>
                <div className={styles.qty}>{fmtN(s.qty?.m5)}<span className={styles.unit}> /5m</span></div>
                <div className={styles.sub}>1h {fmtN(s.qty?.h1)} · 24h {fmtN(s.qty?.h24)}</div>
              </div>
              {i < steps.length - 1 && (
                <div className={styles.arrow}>→</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
