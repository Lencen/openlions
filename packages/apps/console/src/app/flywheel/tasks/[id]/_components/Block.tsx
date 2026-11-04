"use client";
// 任务详情页 · 契约/产出文本块 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { fmtNum } from "@/lib/format";
import { TRUNCATE_HINT } from "./constants";

export default function Block({
  title, text, mono, fullLength, taskId,
}: { title: string; text?: string | null; mono?: boolean; fullLength?: number | null; taskId?: string }) {
  if (!text) return null;
  const actual = String(text).length;
  const truncated = typeof fullLength === "number" && fullLength > actual;
  return (
    <div style={{ marginBottom: "var(--sp-3)" }}>
      <div style={{ fontSize: "var(--fs-base)", fontWeight: 600, color: "var(--primary)", marginBottom: "var(--sp-1)", display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <span>{title}</span>
        <span className="tiny" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{fmtNum(actual)} 字</span>
        {truncated ? (
          <Tooltip title={TRUNCATE_HINT}>
            <span className="pill warn" style={{ fontSize: "var(--fs-xs)" }}>
              ⚠ 已截断 · 全文 {fmtNum(fullLength)} 字
            </span>
          </Tooltip>
        ) : null}
        {truncated && taskId ? (
          <a href={`/api/task-detail?id=${taskId}`} target="_blank" rel="noreferrer" className="tiny">看接口原文 →</a>
        ) : null}
      </div>
      <div
        style={{
          fontSize: "var(--fs-base)", lineHeight: 1.8, whiteSpace: "pre-wrap", wordBreak: "break-word",
          background: "var(--bg-surface2)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)",
          padding: "var(--sp-2-5) var(--sp-3)", color: "var(--text-dim)", fontFamily: mono ? "var(--font-mono)" : undefined,
          maxHeight: 420, overflow: "auto",
        }}
      >
        {text}
      </div>
    </div>
  );
}
