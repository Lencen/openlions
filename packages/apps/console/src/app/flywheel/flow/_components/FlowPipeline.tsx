"use client";
// flywheel/flow 页 · 7 步流水线面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import type { Step } from "./types";
import { fmtN } from "./format";

export default function FlowPipeline({ steps }: { steps: Step[] }) {
  return (
    <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
      <div className="panel-header">
        <span className="panel-title">飞轮 7 步流水线 · 实时量(5分钟 / 1小时 / 24小时)</span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>节点量 = 该步近窗工作量(口径见卡内说明, 2026-09-09 修正映射); 绿点=本 5 分钟在动</span>
      </div>
      <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        {steps.map((s, i) => {
          const live = (s.qty?.m5 || 0) > 0;
          return (
            <div key={s.id} style={{ flex: 1, minWidth: 150, position: "relative" }}>
              <div style={{ border: live ? "1px solid " + s.color : "1px solid var(--border,#2a3a4a)", borderRadius: "var(--radius-md)", padding: "var(--sp-2-5)", background: live ? "rgba(56,161,105,.06)" : "transparent" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: "var(--fs-md)", fontWeight: 700, color: s.color }}>{s.label}</div>
                  {live && <span style={{ width: 9, height: 9, borderRadius: "var(--radius-xs)", background: s.color, display: "inline-block" }} title="本5分钟在动" />}
                </div>
                <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", margin: "var(--sp-1) 0", lineHeight: 1.45 }}>{s.desc}</div>
                <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 800 }}>{fmtN(s.qty?.m5)}<span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", fontWeight: 400 }}> /5m</span></div>
                <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>1h {fmtN(s.qty?.h1)} · 24h {fmtN(s.qty?.h24)}</div>
              </div>
              {i < steps.length - 1 && (
                <div style={{ position: "absolute", right: -9, top: "42%", color: "var(--text-dim)" }}>→</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
