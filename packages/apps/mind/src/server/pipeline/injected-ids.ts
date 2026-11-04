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
