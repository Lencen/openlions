"use client";

interface Step { label: string; count: number; color: string; }
interface Props { steps: Step[]; }

export default function FunnelChart({ steps }: Props) {
  const max = steps[0]?.count || 1;
  return (
    <div className="funnel">
      {steps.map((s, i) => {
        const pct = (s.count / max) * 100;
        const conv = i > 0 ? ((s.count / steps[i-1].count) * 100).toFixed(0) : "100";
        return (
          <div key={i} className="funnel-step">
            <span className="step-label">{s.label}</span>
            <div className="step-bar" style={{ width: `${pct}%`, background: "color-mix(in srgb, " + s.color + " 13%, transparent)", border: "1px solid " + "color-mix(in srgb, " + s.color + " 27%, transparent)" }}>
              <span style={{ color: s.color }}>{conv}%</span>
            </div>
            <span className="step-count">{s.count.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
