"use client";
// agents/onboard 页 · Step 2 确认提交 (从 page.tsx 抽出, 页面瘦身)
// 2026-11-05 P2 呈现层：内联 style 清零（类在 ../page.module.css，sc* 前缀），结构与文案未动。
import type { OnboardForm } from "./types";
import { channelLabel } from "@/config/agentChannels";
import { t } from "@/i18n";
import styles from "../page.module.css";

export default function StepConfirm({
  form,
  selectedList,
  error,
  loading,
  onPrev,
  onSubmit,
}: {
  form: OnboardForm;
  selectedList: string;
  error: string;
  loading: boolean;
  onPrev: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className={styles.scSection}>
      <h2 className={styles.scTitle}>确认注册信息</h2>
      <div className={styles.scCard}>
        <div className={styles.scGrid}>
          <span className={styles.scK}>智能体编号</span><span className={styles.scVStrong}>{form.agent_id}</span>
          <span className={styles.scK}>名称</span><span>{form.display_name}</span>
          <span className={styles.scK}>框架</span><span>{channelLabel(form.channel)}</span>
          <span className={styles.scK}>终端</span><span>{form.host}</span>
          <span className={styles.scK}>服务</span>
          <span>{selectedList}</span>
          <span className={styles.scK}>{t('field.validity')}</span><span>{t('onboard.ttlValue')}</span>
        </div>
      </div>
      {error && <div className={styles.scError}>{error}</div>}
      <div className={styles.scActions}>
        <button onClick={onPrev} className={styles.scBtn}>← 上一步</button>
        <button onClick={onSubmit} disabled={loading} className={styles.scBtnPrimary}>
          {loading ? "注册中..." : "确认注册"}
        </button>
      </div>
    </section>
  );
}
