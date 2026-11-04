"use client";
import { interactiveProps } from "@/components/a11y";
// agents/onboard 页 · Step 1 选择服务 (从 page.tsx 抽出, 页面瘦身)
export default function StepSelectServices({
  services,
  loading,
  selected,
  onToggle,
  onPrev,
  onNext,
}: {
  services: any[];
  loading?: boolean;
  selected: Set<string>;
  onToggle: (name: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const newServices = (services || []).filter((s: any) => s.name?.startsWith("lions_") || s.name === "mcp_agent_chat");
  return (
    <section>
      <h2 style={{ fontSize: "var(--fs-xl)", marginBottom: "var(--sp-4)" }}>
        勾选参与的服务
        <span style={{ fontSize: "var(--fs-base)", color: "var(--text-muted)", marginLeft: "var(--sp-2)" }}>已选 {selected.size} / {newServices.length}</span>
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
        {newServices.map((svc: any) => {
          const checked = selected.has(svc.name);
          return (
            <div key={svc.name} {...interactiveProps(selected.has(svc.name))} onClick={() => onToggle(svc.name)}
              style={{ padding: "var(--sp-4)", borderRadius: "var(--radius-md)", cursor: "pointer",
                border: checked ? "2px solid var(--primary)" : "1px solid var(--border)",
                background: checked ? "var(--bg-hover)" : "var(--bg-surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: "var(--fs-lg)" }}>{svc.display_name || svc.name}</span>
                <span style={{ fontSize: "var(--fs-xl)" }}>{checked ? "✅" : "⬜"}</span>
              </div>
              <div style={{ fontSize: "var(--fs-base)", color: "var(--text-muted)", marginTop: "var(--sp-1)" }}>{svc.description}</div>
              <div style={{ display: "flex", gap: "var(--sp-1)", marginTop: "var(--sp-2)", flexWrap: "wrap" }}>
                {(svc.available_perms || []).map((p: string) => (
                  <span key={p} style={{ fontSize: "var(--fs-xs)", padding: "var(--sp-0-5) var(--sp-1-5)", borderRadius: "var(--radius-xs)", background: "var(--bg)", color: "var(--text-muted)" }}>{p}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {!loading && newServices.length === 0 && (
        <div style={{ padding: "var(--sp-4)", color: "var(--text-muted)" }}>暂无可选业务服务</div>
      )}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <button onClick={onPrev} style={{ padding: "var(--sp-2-5) var(--sp-5)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)", cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text)" }}>← 上一步</button>
        <button onClick={onNext} disabled={selected.size === 0}
          style={{ padding: "var(--sp-2-5) var(--sp-6)", borderRadius: "var(--radius-md)", fontSize: "var(--fs-lg)", cursor: "pointer", background: "var(--primary)", color: "var(--on-primary)", border: "none", opacity: selected.size === 0 ? 0.4 : 1 }}>
          下一步 →
        </button>
      </div>
    </section>
  );
}
