"use client";
// agents/onboard 页 · Step 2 确认提交 (从 page.tsx 抽出, 页面瘦身)
import type { OnboardForm } from "./types";
import { channelLabel } from "@/config/agentChannels";
import { t } from "@/i18n";

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
    <section style={{ maxWidth: 500 }}>
      <h2 style={{ fontSize: "var(--fs-xl)", marginBottom: "var(--sp-4)" }}>确认注册信息</h2>
      <div style={{ padding: "var(--sp-4)", borderRadius: "var(--radius-md)", background: "var(--bg-surface)", border: "1px solid var(--border)", marginBottom: "var(--sp-4)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "var(--sp-2) var(--sp-4)", fontSize: "var(--fs-md)" }}>
          <span style={{ color: "var(--text-muted)" }}>智能体编号</span><span style={{ fontWeight: 600 }}>{form.agent_id}</span>
          <span style={{ color: "var(--text-muted)" }}>名称</span><span>{form.display_name}</span>
          <span style={{ color: "var(--text-muted)" }}>框架</span><span>{channelLabel(form.channel)}</span>
          <span style={{ color: "var(--text-muted)" }}>终端</span><span>{form.host}</span>
          <span style={{ color: "var(--text-muted)" }}>服务</span>
          <span>{selectedList}</span>
          <span style={{ color: "var(--text-muted)" }}>{t('field.validity')}</span><span>{t('onboard.ttlValue')}</span>
        </div>
      </div>
      {error && <div style={{ padding: "var(--sp-3)", borderRadius: "var(--radius-md)", background: "color-mix(in srgb, var(--status-crit) 10%, transparent)", color: "var(--status-crit)", fontSize: "var(--fs-md)", marginBottom: "var(--sp-3)" }}>{error}</div>}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <button onClick={onPrev} style={{ padding: "var(--sp-2-5) var(--sp-5)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)", cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text)" }}>← 上一步</button>
        <button onClick={onSubmit} disabled={loading}
          style={{ padding: "var(--sp-2-5) var(--sp-6)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)", cursor: "pointer", background: "var(--primary)", color: "var(--on-primary)", border: "none", opacity: loading ? 0.6 : 1 }}>
          {loading ? "注册中..." : "确认注册"}
        </button>
      </div>
    </section>
  );
}
