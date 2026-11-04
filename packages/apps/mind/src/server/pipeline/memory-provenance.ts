// memory-provenance.ts — 记忆来源链（B4）。纯函数，便于单测。
// 目标：回答"这条记忆从哪来"——记忆 -> 实践 -> 会话/反思 -> 飞轮回溯事件 -> 取代链。
export interface ProvStep { kind: string; id: string; label: string; asOf: string | null; }
export interface ProvInput {
  memory: { id: string; title?: string | null; summary?: string | null; sourceType?: string | null; sourceId?: string | null; sourcePracticeId?: string | null; supersededBy?: string | null; supersededAt?: Date | number | null; createdAt?: Date | number | null } | null;
  practice?: { id: string; title?: string | null; completedAt?: Date | number | null; createdAt?: Date | number | null } | null;
  events?: Array<{ id: string; stage?: string | null; taskId?: string | null; createdAt?: Date | number | null }>;
}
const iso = (v?: Date | number | null): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const n = Number(v); return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
export function buildProvenanceChain(input: ProvInput): ProvStep[] {
  const m = input.memory;
  if (!m) return [];
  const steps: ProvStep[] = [];
  steps.push({ kind: "memory", id: m.id, label: m.title || (m.summary || "记忆").slice(0, 40), asOf: iso(m.createdAt) });
  if (m.sourcePracticeId) {
    steps.push({ kind: "practice", id: m.sourcePracticeId, label: input.practice?.title || "实践", asOf: iso(input.practice?.completedAt ?? input.practice?.createdAt) });
  }
  if (m.sourceType && m.sourceId) {
    steps.push({ kind: String(m.sourceType).toLowerCase(), id: m.sourceId, label: m.sourceType + " · " + String(m.sourceId).slice(0, 16), asOf: iso(m.createdAt) });
  }
  for (const e of input.events || []) {
    steps.push({ kind: "event", id: e.id, label: (e.stage || "事件") + (e.taskId ? " · " + String(e.taskId).slice(0, 8) : ""), asOf: iso(e.createdAt) });
  }
  if (m.supersededBy) steps.push({ kind: "superseded-by", id: m.supersededBy, label: "已被新记录取代", asOf: iso(m.supersededAt) });
  return steps;
}
