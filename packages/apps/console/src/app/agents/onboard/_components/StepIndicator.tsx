"use client";
// agents/onboard 页 · 步骤指示器 (从 page.tsx 抽出, 页面瘦身)
const STEPS = ["填写信息", "选择服务", "确认提交", "获取密钥"];

export default function StepIndicator({ step }: { step: number }) {
  return (
    // 步骤指示器
    <div style={{ display: "flex", gap: 0, marginBottom: "var(--sp-6)" }}>
      {STEPS.map((label, i) => (
        <div key={i} style={{ flex: 1, textAlign: "center" }}>
          <div style={{
            height: 36, width: 36, borderRadius: "50%", margin: "0 auto var(--sp-1-5)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "var(--fs-lg)", fontWeight: 700,
            background: i <= step ? "var(--primary)" : "var(--bg-surface)",
            color: i <= step ? "var(--on-accent)" : "var(--text-muted)",
            border: i === step ? "2px solid var(--primary)" : "1px solid var(--border)",
          }}>{i + 1}</div>
          <div style={{ fontSize: "var(--fs-sm)", color: i <= step ? "var(--text)" : "var(--text-muted)" }}>{label}</div>
          {i < STEPS.length - 1 && <div style={{ height: 2, background: i < step ? "var(--primary)" : "var(--border)", margin: "var(--sp-2) 20% 0" }} />}
        </div>
      ))}
    </div>
  );
}
