import Sparkline from "./Sparkline";

interface Props {
  label: string;
  value: string | number;
  delta?: string;
  deltaDir?: "up" | "down";
  /** 2026-10-20 视觉层级：hero = 每页只允许一个的主数字（44px + 渐变顶条） */
  size?: "normal" | "hero";
  /** R3：hero 卡内嵌趋势线（无数据时不画，避免出现假的 0 线） */
  trend?: number[];
  hint?: string;
}

export default function KPICard({ label, value, delta, deltaDir, size = "normal", trend, hint }: Props) {
  return (
    <div className={"kpi-card" + (size === "hero" ? " kpi-card-hero" : "")}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {delta && <div className={`kpi-delta ${deltaDir || ""}`}>{delta}</div>}
      {hint ? <div className="kpi-hint">{hint}</div> : null}
      {size === "hero" && trend && trend.filter((n) => Number.isFinite(n)).length >= 2 ? (
        <div className="kpi-spark"><Sparkline data={trend} width={220} height={40} /></div>
      ) : null}
    </div>
  );
}