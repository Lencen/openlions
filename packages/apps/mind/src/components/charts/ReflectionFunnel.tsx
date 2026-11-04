"use client";

/**
 * 反思 5 段漏斗 (Closed Loop)
 * 1199 → 1199 → 1194 → 70 → 0
 *
 * 接 reflectionConstellation.getClosedLoop API
 */

import { useEffect, useState } from "react";

interface FunnelStage {
  stage: string;
  label: string;
  value: number;
  rate: number;
}

const STAGE_COLORS = [
  "var(--brand-mind)",
  "var(--brand-axon)",
  "var(--brand-synapse)",
  "var(--status-ok)",
  "var(--status-frozen)",
];

export function ReflectionFunnel() {
  const [stages, setStages] = useState<FunnelStage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function fetchData() {
      try {
        const r = await fetch("/api/trpc/reflectionConstellation.getClosedLoop").then((x) => x.json());
        if (alive) setStages(r.result?.data ?? []);
      } catch (e) {
        console.error("Funnel fetch failed:", e);
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
      <div style={{ padding: "20px 0", color: "var(--ink-dim)", fontSize: 13, textAlign: "center" }}>
        加载漏斗...
      </div>
    );
  }

  if (stages.length === 0) {
    return (
      <div style={{ padding: "20px 0", color: "var(--ink-dim)", textAlign: "center" }}>
        暂无数据
      </div>
    );
  }

  const max = stages[0]?.value ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {stages.map((s, i) => {
        const widthPct = max > 0 ? Math.max((s.value / max) * 100, 2) : 0;
        const color = STAGE_COLORS[i] || "var(--ink-tertiary)";
        return (
          <div key={s.stage} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-tertiary)",
                width: 100,
                textAlign: "right",
                fontFamily: "var(--font-body)",
              }}
            >
              {s.label}
            </div>
            <div
              style={{
                flex: 1,
                height: 24,
                background: "var(--surface)",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: `${widthPct}%`,
                  height: "100%",
                  background: color,
                  opacity: 0.85,
                  transition: "width 0.5s var(--ease-out)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: widthPct > 20 ? "var(--ink-inverse)" : "var(--ink-primary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {s.value.toLocaleString("en-US")}
              </div>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--ink-tertiary)",
                width: 60,
                textAlign: "right",
                fontFamily: "var(--font-mono)",
              }}
            >
              {s.rate.toFixed(1)}%
            </div>
          </div>
        );
      })}
      {stages.length > 0 && stages[stages.length - 1]?.value === 0 && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 10px",
            fontSize: 11,
            color: "var(--ink-dim)",
            background: "var(--surface)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          💡 5/5 阶段已通过 — 最后效果反馈 0% (A/B 评估钩子待接入)
        </div>
      )}
    </div>
  );
}
