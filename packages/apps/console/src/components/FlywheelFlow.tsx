interface Step {
  label: string;
  count?: string | number;
  active?: boolean;
}

interface Props {
  steps: Step[];
}

export default function FlywheelFlow({ steps }: Props) {
  return (
    <div className="fw-flow">
      {steps.map((s, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-1)" }}>
          <span className={`fw-step ${s.active ? "active" : ""}`}>
            {s.label}
            {s.count !== undefined && ` (${s.count})`}
          </span>
          {i < steps.length - 1 && <span className="fw-arrow">→</span>}
        </span>
      ))}
    </div>
  );
}
