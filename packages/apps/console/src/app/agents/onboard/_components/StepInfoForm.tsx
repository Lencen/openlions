"use client";
// agents/onboard 页 · Step 0 填写信息 (从 page.tsx 抽出, 页面瘦身)
import { t } from "@/i18n";
import { AGENT_CHANNELS } from "@/config/agentChannels";
import type { OnboardForm } from "./types";
import styles from "./StepInfoForm.module.css";

// 2026-11-05 P2 批9：10 处内联 style 清零 -> StepInfoForm.module.css；
//   按钮不可用态改用 data-disabled 属性选择器，不在 JSX 里算 opacity。
export default function StepInfoForm({
  form,
  setForm,
  onNext,
}: {
  form: OnboardForm;
  setForm: (f: OnboardForm) => void;
  onNext: () => void;
}) {
  const blocked = !form.agent_id || !form.display_name;
  return (
    <section className={styles.form}>
      <h2 className={styles.title}>{t('onboard.step1')}</h2>
      {[
        { k: "agent_id", label: "智能体编号", ph: "agent-e", hint: "小写字母+横杠，唯一标识" },
        { k: "display_name", label: "显示名称", ph: "agent-x / 雷欧", hint: "在平台上显示的名称" },
        { k: "host", label: "终端主机", ph: "operator", hint: "运行所在的终端" },
      ].map(f => (
        <div key={f.k} className={styles.field}>
          <label className={styles.label}>{f.label}</label>
          <input
            value={(form as any)[f.k]} onChange={e => setForm({ ...form, [f.k]: e.target.value })}
            placeholder={f.ph}
            className={styles.control}
          />
          <div className={styles.hint}>{f.hint}</div>
        </div>
      ))}
      <div className={styles.field}>
        <label className={styles.label}>{t('onboard.framework')}</label>
        <select aria-label="接入渠道" value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value })}
          className={styles.control}>
          {AGENT_CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>{t(c.labelKey)}</option>
          ))}
        </select>
      </div>
      <button onClick={onNext} disabled={blocked} data-disabled={blocked}
        className={styles.submit}>
        下一步 →
      </button>
    </section>
  );
}
