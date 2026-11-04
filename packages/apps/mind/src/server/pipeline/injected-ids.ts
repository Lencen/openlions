/**
 * injected-ids.ts — CONTEXT_INJECTED 事件里"注入了哪些产物"的解析 (2026-09-11, P0 记忆→使用闭环)
 *
 * 背景(实测): CONTEXT_INJECTED 事件历史上存在三种 sourceTitle 形态 ——
 *   {"agentId":..,"ids":["cm...","cm..."]}   (claim 路径, 95 条) -> 可归因
 *   "ids=cm...,cm..."                        (claim-by-id 路径, 8 条) -> submit 侧 JSON.parse 必然失败, 使用计数丢失
 *   "mem=3 kn=2"                             (context-seed 路径, 106 条) -> 从来没有记过 id, 无法归因
 * 后果: "记忆->使用"闭环里有一部分注入永远无法计入"被使用", 使用率指标偏低且不可解释。
 *
 * 本模块把解析收敛到一处(纯函数, 无依赖, 可单元测试), 三条路径统一写 JSON 形态, 同时兼容旧数据。
 * 注意: 返回空数组不等于"没注入", 也可能是"这条历史事件没记 id" —— 调用方不要把它当成负例。
 */

export function parseInjectedIds(sourceTitle: unknown): string[] {
  const t = String(sourceTitle ?? "").trim();
  if (!t) return [];
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const ids = Array.isArray(j?.ids) ? j.ids : [];
      return ids.map((x: unknown) => String(x)).filter(Boolean);
    } catch {
      return [];
    }
  }
  // 旧格式: ids=<id1>,<id2> (claim-by-id 路径 2026-09-11 之前)
  const legacy = /(?:^|\s)ids=([A-Za-z0-9_,-]+)/.exec(t);
  if (legacy) return legacy[1].split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}


/**
 * extractCitedIds — 从产出正文里找"被引用的注入 id"（2026-10-26，ASSET_CITED 前向）
 *
 * 口径（必须与回填脚本一致）：
 *   · 只认**完整 id**；不接受 6 位尾号（尾号会命中普通单词，假阳性不可控）；
 *   · 边界：id 前后不能紧邻字母/数字，避免 "cmabc" 命中 "cmabcX"；
 *   · 去重、保序；上限 50，防止异常产出把事件撑爆。
 * 注意：命中只说明"产出里出现了这个 id"，不等于"语义上采用了它"；
 *   采用仍以回填/验收为准，看板需标注"引用≠采用"。
 */
export function extractCitedIds(text: unknown, injectedIds: unknown): string[] {
  const out: string[] = [];
  const src = String(text ?? "");
  const ids = Array.isArray(injectedIds) ? injectedIds : [];
  if (!src || !ids.length) return out;
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw || "");
    if (!id || seen.has(id)) continue;
    let from = 0;
    let hit = false;
    while (from <= src.length - id.length) {
      const i = src.indexOf(id, from);
      if (i < 0) break;
      const before = i > 0 ? src[i - 1] : "";
      const after = i + id.length < src.length ? src[i + id.length] : "";
      const boundary = !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
      if (boundary) { hit = true; break; }
      from = i + 1;
    }
    if (hit) { seen.add(id); out.push(id); if (out.length >= 50) break; }
  }
  return out;
}

/** 生成统一的注入事件 sourceTitle(三条路径共用, 保证有的解析就有得写) */
export function buildInjectedTitle(input: {
  agentId?: string | null;
  source: string;
  count: number;
  kinds?: string[];
  ids: string[];
}): string {
  return JSON.stringify({
    agentId: input.agentId || null,
    source: input.source,
    count: input.count,
    kinds: input.kinds || [],
    ids: input.ids,
  }).slice(0, 900);
}
