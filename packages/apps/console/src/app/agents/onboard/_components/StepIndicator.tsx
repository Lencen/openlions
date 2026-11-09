"use client";
// agents/onboard 页 · 步骤指示器 (从 page.tsx 抽出, 页面瘦身)
import styles from "./StepIndicator.module.css";
const STEPS = ["填写信息", "选择服务", "确认提交", "获取密钥"];

// 2026-11-05 P2 批8：内联 style 清零；已到达/当前步/连接线完成态改由 data-* 属性选择器承载。
export default function StepIndicator({ step }: { step: number }) {
  return (
    // 步骤指示器
    <div className={styles.steps}>
      {STEPS.map((label, i) => (
        <div key={i} className={styles.stepItem}>
          <div className={styles.circle} data-done={i <= step} data-current={i === step}>{i + 1}</div>
          <div className={styles.stepLabel} data-done={i <= step}>{label}</div>
          {i < STEPS.length - 1 && <div className={styles.connector} data-done={i < step} />}
        </div>
      ))}
    </div>
  );
}
