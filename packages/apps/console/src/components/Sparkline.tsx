"use client";
import { useId } from "react";

interface Props {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}

/** 轻量 SVG sparkline 趋势线 */
export default function Sparkline({
  data,
  width = 140,
  height = 40,
  color = "#5eead4",
  fill = true,
}: Props) {
  const gid = useId();
  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="暂无数据">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--border)" strokeDasharray="3 3" strokeWidth="1" />
      </svg>
    );
  }
  const max = Math.max(...data, 1);
  const step = width / Math.max(data.length - 1, 1);
  const y = (v: number) => (height - (v / max) * (height - 4) - 2).toFixed(1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${y(v)}`);
  const line = pts.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  const lastX = width;
  const lastY = y(data[data.length - 1]);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="趋势图">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <polygon points={area} fill={`url(#${gid})`} />}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r="2.2" fill={color} />
    </svg>
  );
}
