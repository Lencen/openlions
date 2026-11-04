interface Props {
  name: string;
  port: number;
  status: "ok" | "crit";
  detail?: string;
}

export default function ServiceCard({ name, port, status, detail }: Props) {
  return (
    <div className="service-card">
      <div>
        <div className="svc-name" style={{ color: status === "ok" ? "var(--status-ok)" : "var(--status-crit)" }}>{name}</div>
        <div className="svc-port">:{port}{detail ? ` · ${detail}` : ""}</div>
      </div>
      <span className={`status-badge ${status}`}>
        <span className="pulse-dot" style={{ background: `var(--status-${status})` }} />
        {status === "ok" ? "运行中" : "未运行"}
      </span>
    </div>
  );
}
