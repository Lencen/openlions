"use client";

/**
 * Flywheel River — 24H 事件流 (内联 SVG, 替换 demo 静态)
 *
 * 7 彩色轨道 (LEARN/REFLECT/MEMORIZE/KNOWLEDGE/PRACTICE/OUTCOME/EVALUATE)
 * 每条轨道上的 dot 按时段分布, 颜色对应 stage
 * 右侧 NOW 游标, X 轴 0-23h
 *
 * 接 flywheelRiver.getRiver API
 */

import { useEffect, useState } from "react";

const STAGE_ORDER = ["LEARN", "REFLECT", "MEMORIZE", "KNOWLEDGE", "PRACTICE", "OUTCOME", "EVALUATE"] as const;
const STAGE_LABELS: Record<string, string> = {
  LEARN: "学习",
  REFLECT: "反思",
  MEMORIZE: "记忆",
  KNOWLEDGE: "知识",
  PRACTICE: "实践",
  OUTCOME: "产出",
  EVALUATE: "评估",
};
const STAGE_COLORS: Record<string, string> = {
  LEARN: "var(--brand-mind)",
  REFLECT: "var(--brand-axon)",
  MEMORIZE: "var(--brand-synapse)",
  KNOWLEDGE: "var(--status-ok)",
  PRACTICE: "var(--status-warn)",
  OUTCOME: "var(--brand-flow)",
  EVALUATE: "var(--status-frozen)",
};

interface RiverData {
  buckets: Array<{ hour: string; stage: string; count: number }>;
  totalEvents: number;
  last24hEvents: number;
  hours: number;
}

interface FlywheelRiverProps {
  hours?: number;
  height?: number;
}

export function FlywheelRiver({ hours = 24, height = 240 }: FlywheelRiverProps) {
  const [data, setData] = useState<RiverData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function fetchData() {
      try {
        const r = await fetch(
          `/api/trpc/flywheelRiver.getRiver?input=${encodeURIComponent(JSON.stringify({ hours }))}`
        ).then((x) => x.json());
        if (alive) setData(r.result?.data ?? null);
      } catch (e) {
        console.error("FlywheelRiver fetch failed:", e);
      } finally {
        if (alive) setLoading(false);
      }
    }
    fetchData();
    const id = setInterval(fetchData, 60000); // 1min refresh
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [hours]);

  if (loading) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-dim)", fontSize: 13 }}>
        加载 24H 事件流...
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-dim)" }}>
        暂无数据
      </div>
    );
  }

  // SVG 布局
  const W = 800;
  const H = height;
  const padL = 80;
  const padR = 40;
  const padT = 10;
  const padB = 28;
  const trackCount = STAGE_ORDER.length;
  const trackH = (H - padT - padB) / trackCount;
  const trackInnerH = trackH * 0.55;

  // 按时段聚合, 给每条轨道算 count 时段
  // hour 是 "2026-06-08 14" 格式, 拿 14 部分
  const hours24 = Array.from({ length: 24 }, (_, i) => i);
  // 当前小时 (北京时间, Asia/Shanghai)
  const beijingH = parseInt(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }),
    10,
  );

  // 给每 (stage, hour) 算 count
  const byStageHour: Record<string, Record<number, number>> = {};
  for (const s of STAGE_ORDER) byStageHour[s] = {};
  for (const b of data.buckets) {
    const h = parseInt(b.hour.slice(11, 13), 10);
    if (byStageHour[b.stage]) byStageHour[b.stage][h] = b.count;
  }
  // 每条轨道的 max count (用于 dot 半径)
  const stageMax: Record<string, number> = {};
  for (const s of STAGE_ORDER) {
    const counts = Object.values(byStageHour[s]);
    stageMax[s] = Math.max(...counts, 1);
  }

  function xForHour(h: number) {
    // X 轴 0-23h 映射
    return padL + (h / 23) * (W - padL - padR);
  }
  function yForStage(i: number) {
    return padT + i * trackH + (trackH - trackInnerH) / 2 + trackInnerH / 2;
  }

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ minWidth: W }}>
        {/* X 轴 0-23h 网格 */}
        {[0, 4, 8, 12, 16, 20, 23].map((h) => (
          <g key={h}>
            <line
              x1={xForHour(h)}
              y1={padT}
              x2={xForHour(h)}
              y2={H - padB}
              stroke="var(--border-soft)"
              strokeWidth={1}
              strokeDasharray="2,3"
            />
            <text
              x={xForHour(h)}
              y={H - padB + 16}
              textAnchor="middle"
              fontSize="10"
              fill="var(--ink-dim)"
              fontFamily="var(--font-mono)"
            >
              {String(h).padStart(2, "0")}:00
            </text>
          </g>
        ))}

        {/* 7 轨道 */}
        {STAGE_ORDER.map((stage, i) => {
          const colorVar = STAGE_COLORS[stage];
          return (
            <g key={stage}>
              {/* 轨道背景 */}
              <rect
                x={padL}
                y={yForStage(i) - trackInnerH / 2}
                width={W - padL - padR}
                height={trackInnerH}
                fill="var(--surface)"
                rx="var(--radius-sm)"
              />
              {/* 轨道标签 */}
              <text
                x={padL - 8}
                y={yForStage(i) + 4}
                textAnchor="end"
                fontSize="10"
                fontWeight="600"
                fill="var(--ink-tertiary)"
                fontFamily="var(--font-body)"
              >
                {STAGE_LABELS[stage]}
              </text>

              {/* 时段 dot */}
              {hours24.map((h) => {
                const count = byStageHour[stage][h] ?? 0;
                if (count === 0) return null;
                const r = 2 + Math.sqrt(count / stageMax[stage]) * 4;
                return (
                  <circle
                    key={h}
                    cx={xForHour(h)}
                    cy={yForStage(i)}
                    r={r}
                    fill={colorVar}
                    fillOpacity={0.85}
                    stroke="var(--bg-elevated)"
                    strokeWidth={1}
                  />
                );
              })}
            </g>
          );
        })}

        {/* NOW 游标 */}
        <line
          x1={xForHour(beijingH)}
          y1={padT}
          x2={xForHour(beijingH)}
          y2={H - padB}
          stroke="var(--brand-mind)"
          strokeWidth={1.5}
          strokeDasharray="4,4"
        />
        <text
          x={xForHour(beijingH) + 6}
          y={padT + 10}
          fontSize="9"
          fontWeight="700"
          fill="var(--brand-mind)"
          fontFamily="var(--font-mono)"
        >
          NOW
        </text>
      </svg>

      {/* 图例 */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 8,
          fontSize: 11,
          color: "var(--ink-tertiary)",
          flexWrap: "wrap",
        }}
      >
        {STAGE_ORDER.map((s) => (
          <span key={s} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: STAGE_COLORS[s],
                display: "inline-block",
              }}
            />
            {STAGE_LABELS[s]}
          </span>
        ))}
        <span style={{ marginLeft: "auto", color: "var(--ink-dim)" }}>
          {data.last24hEvents} events / {hours}h
        </span>
      </div>
    </div>
  );
}
