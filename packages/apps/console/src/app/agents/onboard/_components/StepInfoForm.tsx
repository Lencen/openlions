"use client";
// agents/onboard 页 · Step 0 填写信息 (从 page.tsx 抽出, 页面瘦身)
import { t } from "@/i18n";
import { AGENT_CHANNELS } from "@/config/agentChannels";
import type { OnboardForm } from "./types";

export default function StepInfoForm({
  form,
  setForm,
  onNext,
}: {
  form: OnboardForm;
  setForm: (f: OnboardForm) => void;
  onNext: () => void;
}) {
  return (
    <section style={{ maxWidth: 500 }}>
      <h2 style={{ fontSize: "var(--fs-xl)", marginBottom: "var(--sp-4)" }}>{t('onboard.step1')}</h2>
      {[
        { k: "agent_id", label: "智能体编号", ph: "agent-e", hint: "小写字母+横杠，唯一标识" },
        { k: "display_name", label: "显示名称", ph: "agent-x / 雷欧", hint: "在平台上显示的名称" },
        { k: "host", label: "终端主机", ph: "operator", hint: "运行所在的终端" },
      ].map(f => (
        <div key={f.k} style={{ marginBottom: "var(--sp-4)" }}>
          <label style={{ fontSize: "var(--fs-base)", color: "var(--text-muted)", display: "block", marginBottom: "var(--sp-1)" }}>{f.label}</label>
          <input
            value={(form as any)[f.k]} onChange={e => setForm({ ...form, [f.k]: e.target.value })}
            placeholder={f.ph}
            style={{ width: "100%", padding: "var(--sp-2-5) var(--sp-3)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)",
              background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text)" }}
          />
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginTop: "var(--sp-0-5)" }}>{f.hint}</div>
        </div>
      ))}
      <div style={{ marginBottom: "var(--sp-4)" }}>
        <label style={{ fontSize: "var(--fs-base)", color: "var(--text-muted)", display: "block", marginBottom: "var(--sp-1)" }}>{t('onboard.framework')}</label>
        <select aria-label="接入渠道" value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value })}
          style={{ width: "100%", padding: "var(--sp-2-5) var(--sp-3)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)",
            background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text)" }}>
          {AGENT_CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>{t(c.labelKey)}</option>
          ))}
        </select>
      </div>
      <button onClick={onNext} disabled={!form.agent_id || !form.display_name}
        style={{ padding: "var(--sp-2-5) var(--sp-6)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)", cursor: "pointer",
          background: "var(--primary)", color: "var(--on-primary)", border: "none",
          opacity: !form.agent_id || !form.display_name ? 0.4 : 1 }}>
        下一步 →
      </button>
    </section>
  );
}
