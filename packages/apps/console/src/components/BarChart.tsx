"use client";

interface Bar { label: string; value: number; color: string; }
interface Props { bars: Bar[]; }

export default function BarChart({ bars }: Props) {
  const max = Math.max(...bars.map(b => b.value), 1);
  return (
    <div className="bar-chart">
      {bars.map((b, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label">{b.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(b.value / max) * 100}%`, background: b.color }} />
          </div>
          <span className="bar-value">{b.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
