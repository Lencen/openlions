/**
 * dup-content-guard.ts — 「内容几乎相同的重复条目」去重判据 (2026-09-18)
 *
 * 事故(人类决策卡 todo_apply_tzmzyh0ba9v6_1789697703789 -> 落地待办 todo_land_jvijaydsfs4s):
 *   人类:operator 明确拍板「重复内容需要清理」(A=按平台建议执行)。平台库只读复算的实况:
 *     · Knowledge 活跃 48138 行中, 有 1231 组**标题逐字相同**、正文互为复述的条目, 冗余 1580 行;
 *       最极端一组标题「VERIFY_AGENT_OUTPUT 判定口径」34 行, 正文都是同一口径的不同措辞
 *       (例: "VERIFIED=能通过平台数据/代码/接口复现…" vs "VERIFIED = 能用平台数据/代码/接口复现…");
 *     · Memory 活跃 46140 行中, 同标题冗余 3039 行。
 *
 * 根因(机制, 非一次特判):
 *   平台已有的去重兜底 structured-dedup.ts 只认 **完全相同** 的 (theme, contentHash)。
 *   但飞轮每轮反思都会让 LLM **重新措辞**同一知识点 -> contentHash 不同 -> 兜底不命中 -> 每轮各写一行。
 *   实测「卡住任务双重判定条件」4 行正文: 判据完全一致, 只是"两类/两种/①"等措辞漂移。
 *
 * 本模块只做**确定性**近重复判据, 不做语义猜测(不调 LLM):
 *   - 标题键: 归一化(去空白/标点、小写)后**逐字相同**才进同一候选组 —— 强闸, 防止把不同主题合错;
 *   - 正文相似: 归一化后的 **4-gram shingle** 的 containment / Jaccard;
 *   - 判定重复: containment >= 0.55(一段是另一段的复述/子集) 或 Jaccard >= 0.35(互相复述)。
 *     阈值由平台库真实复述对校准(同一「VERIFY_AGENT_OUTPUT 判定口径」的两条改写: containment 0.617 /
 *     Jaccard 0.420; 不同主题对: 0.000), 落在"同义改写命中、不同主题不误判"之间。
 *   - canonical 取**正文最长**者(信息最全), 同长取最早; 冗余行只置 supersededBy/supersededAt(**不删行**)。
 *
 * 诚实边界:
 *   - 只覆盖「标题逐字相同」的近重复; 标题漂移(如「VERIFY_AGENT_OUTPUT判定口径」缺空格)不在本阈值内,
 *     由调用方可选 titleFuzzy 放宽, 默认关闭。
 *   - 相似度是字面 n-gram, 不识别"换一个说法但零字面重叠"的语义重复 -> 宁可不合并。
 *   - supersede 是非破坏的: 原行与内容全部保留, 可 --rollback 还原。
 */

export type DupTable = "knowledge" | "memory" | "practice";

export interface DupRow {
  id: string;
  title: string | null;
  content: string;
  theme?: string | null;
  qualityScore?: number | null;
  createdAt?: string | number | null;
}

export interface DupCluster {
  /** 归一化标题键(同组唯一) */
  titleKey: string;
  /** 组内代表标题(原样, 便于人读) */
  title: string;
  /** 保留的 canonical 行 id(正文最长的那个) */
  canonicalId: string;
  /** 被 supersede 的冗余行(按 id 稳定排序) */
  redundantIds: string[];
  /** 冗余行 -> 与 canonical 的相似度(0~1, 便于审计) */
  scores: Record<string, number>;
}

export interface DupPlan {
  table: DupTable;
  clusters: DupCluster[];
  /** 将被 supersede 的行总数 */
  redundantTotal: number;
}

/** 归一化: 折叠空白、小写、去掉中英标点(保留 CJK 与 alnum)。 */
export function normText(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[!-/:-@\[-`{-~]/g, "")
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, "")
    .trim();
}

/** 标题键: 归一化后逐字相同才视为同一候选组。 */
export function titleKey(title: unknown): string {
  return normText(title);
}

/** 正文 shingle 集合(默认 4-gram; 短文本退化为整体)。 */
export function shingles(s: unknown, n = 4): Set<string> {
  const t = normText(s);
  const out = new Set<string>();
  if (!t) return out;
  if (t.length <= n) { out.add(t); return out; }
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}

/** Jaccard: |A∩B| / |A∪B|。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** Containment: |A∩B| / min(|A|,|B|) —— 一段是另一段的复述/子集时为高值。 */
export function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / small.size;
}

export const DUP_CONTAINMENT_MIN = 0.55;
export const DUP_JACCARD_MIN = 0.35;

/** 两段正文是否近重复(字面 n-gram 判据)。 */
export function isNearDuplicateContent(a: string, b: string): { dup: boolean; score: number; containment: number; jaccard: number } {
  const sa = shingles(a), sb = shingles(b);
  const c = containment(sa, sb), j = jaccard(sa, sb);
  const dup = c >= DUP_CONTAINMENT_MIN || j >= DUP_JACCARD_MIN;
  return { dup, score: Number(Math.max(c, j).toFixed(3)), containment: Number(c.toFixed(3)), jaccard: Number(j.toFixed(3)) };
}

/** canonical 排序: 正文最长(信息最全) > qualityScore 高 > createdAt 早 > id 小。 */
export function pickCanonical(rows: DupRow[]): DupRow {
  const len = (r: DupRow) => normText(r.content).length;
  const ts = (r: DupRow) => {
    const v = r.createdAt;
    if (v == null) return Number.MAX_SAFE_INTEGER;
    const n = typeof v === "number" ? v : Date.parse(String(v));
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };
  return [...rows].sort((x, y) => {
    if (len(y) !== len(x)) return len(y) - len(x);
    const qx = Number(x.qualityScore ?? 0), qy = Number(y.qualityScore ?? 0);
    if (qy !== qx) return qy - qx;
    if (ts(x) !== ts(y)) return ts(x) - ts(y);
    return String(x.id) < String(y.id) ? -1 : 1;
  })[0];
}

/**
 * 从一堆行里找出近重复簇。
 * 先按 titleKey 分组(强闸), 再在组内用并查集把近重复行连起来。
 * 单例组与不含重复的组不返回。
 */
export function findDupClusters(rows: DupRow[], opts?: { minGroup?: number }): DupCluster[] {
  const minGroup = Math.max(2, Number(opts?.minGroup ?? 2));
  const byTitle = new Map<string, DupRow[]>();
  for (const r of rows) {
    const k = titleKey(r.title);
    if (!k) continue;
    const arr = byTitle.get(k);
    if (arr) arr.push(r); else byTitle.set(k, [r]);
  }
  const clusters: DupCluster[] = [];
  for (const [key, group] of byTitle) {
    if (group.length < minGroup) continue;
    const parent = group.map((_, i) => i);
    const best: number[] = group.map(() => 0);   // 与簇内任一成员的**最高**相似度(审计用)
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (i: number, j: number) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const r = isNearDuplicateContent(group[i].content, group[j].content);
        if (!r.dup) continue;
        if (r.score > best[i]) best[i] = r.score;
        if (r.score > best[j]) best[j] = r.score;
        union(i, j);
      }
    }
    const comps = new Map<number, number[]>();
    for (let i = 0; i < group.length; i++) {
      const root = find(i);
      const arr = comps.get(root);
      if (arr) arr.push(i); else comps.set(root, [i]);
    }
    for (const idxs of comps.values()) {
      if (idxs.length < 2) continue;
      const members = idxs.map((i) => group[i]);
      const canonical = pickCanonical(members);
      const scores: Record<string, number> = {};
      const redundant: string[] = [];
      for (const k of idxs) {
        const m = group[k];
        if (m.id === canonical.id) continue;
        redundant.push(m.id);
        // 记录与簇内任一成员的最高相似度(不只对 canonical) —— 传递闭包下对 canonical 可能偏低, 但这仍是近重复
        scores[m.id] = best[k];
      }
      redundant.sort();
      clusters.push({ titleKey: key, title: String(canonical.title ?? ""), canonicalId: canonical.id, redundantIds: redundant, scores });
    }
  }
  clusters.sort((a, b) => b.redundantIds.length - a.redundantIds.length || (a.titleKey < b.titleKey ? -1 : 1));
  return clusters;
}

/** 汇总成一个可落地的计划(纯数据, 便于 dry-run 打印/审计)。 */
export function buildDupPlan(table: DupTable, rows: DupRow[], opts?: { minGroup?: number }): DupPlan {
  const clusters = findDupClusters(rows, opts);
  return { table, clusters, redundantTotal: clusters.reduce((n, c) => n + c.redundantIds.length, 0) };
}

// =====================================================================================
// 决策卡 / 落地待办的跨来源去重判据 (机制修复: 平台自身不再重复产卡片/落地单)
//
// 事故: 同一句人类决定「重复内容需要清理」在 2026-09-18T02:32 的同一批里被 3 张不同来源的
//   improving 任务各自产出一张 `todo_apply_*` 决策卡(tzmz8ljjvqai/tzmzhlx6f3kf/tzmzyh0ba9v6),
//   每张卡被人类回复后又各自生成一张【落地】待办(uvit270yfp47/jvijaydsfs4s/zkriezcifvjs)。
//   平台自己成了"大量重复内容"的产源。
// =====================================================================================

/** 决策卡业务身份键: 同一「业务域 + 事件类型」= 同一类人类决策问题(与 human-card-dedup.businessCardKey 同口径)。 */
export function decisionBusinessKey(domain: unknown, cueKind: unknown): string {
  return normText(domain) + "|" + normText(cueKind);
}

/**
 * 纯判据: 给定「本次要建的决策卡」与「已存在的同类卡」, 该不该再建。
 * 事故实证: 2026-09-18T02:15:03 同一批 improving 任务产出的 3 张 `todo_apply_*` 卡,
 *   标题逐字相同(「【需您拍板】平台里积了大量重复内容——要不要清理」), 只是 theme/domain 略有差异
 *   (主题分别是 零工具通道卡住/候选结论验证/提案独立复核, 业务域是 平台记忆库/知识提案审批)。
 *   因此判据以**卡片标题归一化后逐字相同**为主闸(标题由 buildBusinessDecisionCard 由业务域+事件类型生成),
 *   业务域+事件类型相同为辅助; 任一命中且既有卡仍在流转/已终态 -> 不再建重复卡。
 */
export function shouldSkipApplyCard(input: {
  domain: unknown; cueKind: unknown; cardTitle: unknown;
  existing: Array<{ id: string; status: string; title?: unknown; domain?: unknown; cueKind?: unknown }>;
}): { skip: boolean; existingId?: string; reason: string } {
  const nt = normText(input.cardTitle);
  const bk = decisionBusinessKey(input.domain, input.cueKind);
  if (!nt && (!bk.trim() || bk === "|")) return { skip: false, reason: "卡片标题与业务身份都为空, 不抑制(保守)" };
  for (const e of input.existing) {
    const sameTitle = !!nt && normText(e.title) === nt;
    const sameBiz = bk !== "|" && decisionBusinessKey(e.domain, e.cueKind) === bk;
    if (!sameTitle && !sameBiz) continue;
    return {
      skip: true,
      existingId: String(e.id),
      reason: "同类人类决策卡 " + e.id + "(" + e.status + ") 已存在 ["
        + (sameTitle ? "标题逐字相同" : "业务域|事件类型=" + bk) + "], 本任务不再重复建卡",
    };
  }
  return { skip: false, reason: "无同类决策卡, 照常建" };
}

/**
 * 纯判据: 给定「本次要生成的落地待办」与「已存在的落地待办」, 该不该再建。
 * 同一句决定文本(归一化逐字相同)+ 同一来源问题标题 = 同一件要做的事 -> 复用已存在的落地待办。
 */
export function shouldReuseLandingTodo(input: {
  decisionText: unknown; sourceTitle: unknown;
  existing: Array<{ id: string; status: string; decisionText?: unknown; sourceTitle?: unknown }>;
}): { reuse: boolean; existingId?: string; reason: string } {
  const dt = normText(input.decisionText);
  const st = normText(input.sourceTitle);
  if (!dt || dt.length < 5) return { reuse: false, reason: "决定文本过短, 不抑制(保守)" };
  for (const e of input.existing) {
    if (normText(e.decisionText) !== dt) continue;
    if (st && normText(e.sourceTitle) && normText(e.sourceTitle) !== st) continue;
    return {
      reuse: true,
      existingId: String(e.id),
      reason: "同一决定「" + String(input.decisionText).slice(0, 40) + "」+ 同一来源问题已有落地待办 " + e.id
        + "(" + e.status + "), 复用它而不是再建一张",
    };
  }
  return { reuse: false, reason: "无同决定落地待办, 照常建" };
}
