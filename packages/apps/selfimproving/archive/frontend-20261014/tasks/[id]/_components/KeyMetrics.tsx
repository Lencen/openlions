"use client";

interface KeyMetricsProps {
  estimatedEffort: string | null;
  actualEffortMs: number | null;
  executionCount: number;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
}

export function KeyMetrics({
  estimatedEffort,
  actualEffortMs,
  executionCount,
  retryCount,
  maxRetries,
  createdAt,
  updatedAt,
}: KeyMetricsProps) {
  const retryColor =
    retryCount === 0 ? "#52c41a" : retryCount >= maxRetries ? "#ff4d4f" : "#faad14";

  const formatDuration = (ms: number | null) => {
    if (!ms) return "—";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h ${minutes % 60}m`;
  };

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: 12,
    }}>
      {[
        {
          label: "估计 effort",
          value: estimatedEffort ?? "—",
          sub: null,
        },
        {
          label: "实际 effort",
          value: formatDuration(actualEffortMs),
          sub: actualEffortMs ? `${actualEffortMs}ms` : null,
        },
        {
          label: "执行次数",
          value: executionCount.toString(),
          sub: null,
        },
        {
          label: "重试",
          value: `${retryCount}/${maxRetries}`,
          sub: null,
          color: retryColor,
        },
      ].map((item) => (
        <div
          key={item.label}
          style={{
            background: "#fafafa",
            borderRadius: 6,
            padding: "12px 14px",
            border: "1px solid #f0f0f0",
          }}
        >
          <div style={{ fontSize: 11, color: "#999", marginBottom: 4 }}>{item.label}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: item.color ?? "#333" }}>
            {item.value}
          </div>
          {item.sub && (
            <div style={{ fontSize: 10, color: "#bbb", marginTop: 2 }}>{item.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
}