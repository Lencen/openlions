/**
 * reflect-select.ts — 2026-09-09 P2.5 finding 选取: 参数化权重 + 语义近重复合并 + 证据校准 + 多样性贪心 Top10
 * 设计: docs/flywheel-reflection-task-info-plan-2026-09-09.md §9.2(d) + 权重/校准两点优化
 * 权重可通过 env 调 (REFLECT_SCORE_P0/P1/P2, REFLECT_SCORE_CONF, REFLECT_SCORE_RECURRING, REFLECT_MAX_PER_TOPIC)
 */
import type { StructuredFinding } from "./reflect";

function normTxt(s: string): string {
  return String(s || "").toLowerCase().replace(/[^0-9a-z一-鿿]/g, "");
}
function dice(a: string, b: string): number {
  const na = normTxt(a), nb = normTxt(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const big = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (!set.size) set.add(s);
    return set;
  };
  const A = big(na), B = big(nb);
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
function hasQuote(s: string): boolean {
  return /[“"「」『』]|用户[:：]|原话|说[:：]/.test(String(s || ""));
}
function priNum(p?: string): number {
  const w: Record<string, number> = {
    P0: Number(process.env.REFLECT_SCORE_P0) || 30,
    P1: Number(process.env.REFLECT_SCORE_P1) || 20,
    P2: Number(process.env.REFLECT_SCORE_P2) || 10,
  };
  return w[p || "P2"] ?? 10;
}
function esNum(e?: string): number {
  const w: Record<string, number> = { 强: 3, 中: 1.5, 弱: 0.4 };
  return w[e || "中"] ?? 1.5;
}
function calibrateConfidence(f: StructuredFinding): number {
  const conf = typeof f.confidence === "number" ? f.confidence : 0.5;
  const ev = String(f.evidenceSnippet || "");
  const evScore = Math.min(ev.length / 200, 1) * 0.35 + (hasQuote(ev) ? 0.25 : 0);
  // 规则校准: LLM 自评区分度不足(大量 0.5) → 用证据长度/原文引用修正
  return Number(Math.max(0.1, Math.min(0.98, conf * 0.55 + evScore + 0.2)).toFixed(2));
}

export function selectTopFindings(findings: StructuredFinding[], theme: string): { picked: StructuredFinding[]; meta: { total: number; nearDupRemoved: number; lowConfidence: number } } {
  const confK = Number(process.env.REFLECT_SCORE_CONF) || 8;
  const recBonus = Number(process.env.REFLECT_SCORE_RECURRING) || 2;
  const maxPerTopic = Number(process.env.REFLECT_MAX_PER_TOPIC) || 3;
  const rawScore = (f: StructuredFinding) =>
    priNum(f.priority) + (typeof f.confidence === "number" ? f.confidence : 0.5) * confK + esNum(f.evidenceStrength);

  // 1) 近重复合并 (what 的 bigram dice >= 0.75, 保留分高者) — 治同义不同写/跨 chunk 重复
  const deduped: StructuredFinding[] = [];
  for (const f of findings) {
    const dupe = deduped.find((g) => dice(g.what, f.what) >= 0.75);
    if (dupe) {
      if (rawScore(f) > rawScore(dupe)) {
        const i = deduped.indexOf(dupe);
        deduped[i] = f;
      }
      continue;
    }
    deduped.push(f);
  }
  const nearDupRemoved = findings.length - deduped.length;

  // 2) confidence 规则校准
  for (const f of deduped) f.confidence = calibrateConfidence(f);

  // 3) 贪心 Top10 + 主题多样性 + RECURRING 加权
  const scored = deduped.map((f) => ({ f, s: rawScore(f) + (f.status === "RECURRING" ? recBonus : 0) }))
    .sort((a, b) => b.s - a.s);
  const topicCount = new Map<string, number>();
  const picked: StructuredFinding[] = [];
  for (const it of scored) {
    if (picked.length >= 10) break;
    const t = it.f.relatedTopic || "general";
    const c = topicCount.get(t) ?? 0;
    if (c >= maxPerTopic) continue;
    topicCount.set(t, c + 1);
    picked.push(it.f);
  }
  for (const it of scored) {
    if (picked.length >= 10) break;
    if (!picked.includes(it.f)) picked.push(it.f);
  }
  console.log(
    "[reflect] theme=" + theme + " P2.5 findings=" + findings.length +
    " 近重复去除=" + nearDupRemoved + " → top" + picked.length + ": " +
    picked.map((f) => f.priority + ":" + f.id + ":conf" + f.confidence).join(" ")
  );
  const meta = { total: findings.length, nearDupRemoved, lowConfidence: deduped.filter((f) => (f.confidence ?? 1) < 0.6).length };
  return { picked, meta };
}
