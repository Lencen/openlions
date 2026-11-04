"use client";

/**
 * 7 阶段转化率 (Stage Conversion)
 * 接 flywheelRiver.getConversion API
 * 显示每阶段 count + 占总事件 %
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

interface ConversionRow {
  stage: string;
  count: number;
  rate: number;
}

export function StageConversion() {
  const [rows, setRows] = useState<ConversionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function fetchData() {
      try {
        const r = await fetch("/api/trpc/flywheelRiver.getConversion").then((x) => x.json());
        if (alive) {
          const data = r.result?.data ?? [];
          // 按 STAGE_ORDER 排
          const map = new Map(data.map((d: ConversionRow) => [d.stage, d]));
          const ordered = STAGE_ORDER.map((s) => map.get(s) ?? ({ stage: s, count: 0, rate: 0 } as ConversionRow)) as ConversionRow[];
          setRows(ordered);
        }
      } catch (e) {
        console.error("StageConversion fetch failed:", e);
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
        加载转化率...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => {
        const colorVar = STAGE_COLORS[r.stage];
        return (
          <div key={r.stage} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: colorVar,
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, fontSize: 13, color: "var(--ink-primary)" }}>{STAGE_LABELS[r.stage]}</div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--ink-primary)",
                fontFeatureSettings: '"tnum" 1',
                minWidth: 60,
                textAlign: "right",
              }}
            >
              {r.count.toLocaleString("en-US")}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--ink-tertiary)",
                minWidth: 50,
                textAlign: "right",
              }}
            >
              {r.rate.toFixed(1)}%
            </div>
            <div
              style={{
                width: 80,
                height: 6,
                background: "var(--surface)",
                borderRadius: 3,
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: `${Math.min(r.rate, 100)}%`,
                  height: "100%",
                  background: colorVar,
                  opacity: 0.85,
                  transition: "width 0.5s var(--ease-out)",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
