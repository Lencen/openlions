"use client";

/**
 * 反思主题星云 (Constellation)
 * 7 主题 SVG 节点 — 节点大小反映 count, 颜色按 count 排名
 *
 * 接 reflectionConstellation.getConstellation API
 */

import { useEffect, useState } from "react";

interface ConstellationData {
  themes: Array<{ theme: string; count: number; examples: string[] }>;
  total: number;
  totalThemes: number;
}

const PALETTE = [
  "var(--brand-mind)",     // 青绿
  "var(--brand-axon)",     // 紫
  "var(--brand-synapse)",  // 琥珀
  "var(--status-ok)",      // 绿
  "var(--status-warn)",    // 橙
  "var(--brand-flow)",     // 天蓝
  "var(--status-info)",    // info
  "var(--status-frozen)",  // 灰
];

export function Constellation() {
  const [data, setData] = useState<ConstellationData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function fetchData() {
      try {
        const r = await fetch(
          "/api/trpc/reflectionConstellation.getConstellation?input=" +
            encodeURIComponent(JSON.stringify({ limit: 10 }))
        ).then((x) => x.json());
        if (alive) setData(r.result?.data ?? null);
      } catch (e) {
        console.error("Constellation fetch failed:", e);
      } finally {
        if (alive) setLoading(false);
      }
    }
    fetchData();
    const id = setInterval(fetchData, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (loading) {
    return (
      <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-dim)", fontSize: 13 }}>
        加载主题星云...
      </div>
    );
  }

  if (!data || data.themes.length === 0) {
    return (
      <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-dim)" }}>
        暂无主题
      </div>
    );
  }

  const themes = data.themes;
  const maxCount = Math.max(...themes.map((t) => t.count), 1);
  const W = 460;
  const H = 280;
  const cx = W / 2;
  const cy = H / 2;

  // 螺旋布局 — 中心最大节点, 外围按 count 排
  const positions = themes.map((t, i) => {
    if (i === 0) return { x: cx, y: cy, r: 28 + (t.count / maxCount) * 22 };
    // 螺旋: r = a + b*theta
    const theta = i * 0.8 + 0.5;
    const r = 60 + (themes[0].count - t.count) * 0.04;
    return {
      x: cx + r * Math.cos(theta),
      y: cy + r * Math.sin(theta),
      r: 8 + (t.count / maxCount) * 18,
    };
  });

  return (
    <div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W }}>
        {/* 连线 (中心 ↔ 外围) */}
        {positions.slice(1).map((p, i) => (
          <line
            key={`l-${i}`}
            x1={cx}
            y1={cy}
            x2={p.x}
            y2={p.y}
            stroke="var(--border-hi)"
            strokeWidth={1}
            strokeDasharray="2,3"
            opacity={0.4}
          />
        ))}

        {/* 节点 */}
        {themes.map((t, i) => {
          const p = positions[i];
          const color = PALETTE[i % PALETTE.length];
          return (
            <g key={t.theme}>
              {/* 光晕 */}
              <circle cx={p.x} cy={p.y} r={p.r + 4} fill={color} fillOpacity={0.15} />
              {/* 节点主体 */}
              <circle
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={color}
                fillOpacity={0.7}
                stroke={color}
                strokeWidth={1.5}
              />
              {/* count 数字 */}
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                fontSize={Math.max(10, Math.min(14, p.r * 0.6))}
                fontWeight="700"
                fill="var(--ink-inverse)"
                fontFamily="var(--font-mono)"
              >
                {t.count}
              </text>
              {/* 主题标签 */}
              {i === 0 ? (
                <text
                  x={p.x}
                  y={p.y - p.r - 8}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill="var(--ink-primary)"
                >
                  {t.theme}
                </text>
              ) : (
                <text
                  x={p.x}
                  y={p.y + p.r + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--ink-tertiary)"
                >
                  {t.theme.length > 6 ? t.theme.slice(0, 6) + "…" : t.theme}
                </text>
              )}
            </g>
          );
        })}

        {/* 右上 hover 提示 */}
        <text
          x={W - 8}
          y={16}
          textAnchor="end"
          fontSize="9"
          fill="var(--ink-dim)"
          fontFamily="var(--font-mono)"
        >
          HOVER: 显示关联
        </text>
      </svg>
    </div>
  );
}
