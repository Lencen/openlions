// FlywheelFlow · P2 呈现层（批1）：内联样式清零（每一步的横排对齐改由 FlywheelFlow.module.css 的 .stepWrap 承担）。
import styles from "./FlywheelFlow.module.css";

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
        <span key={i} className={styles.stepWrap}>
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
