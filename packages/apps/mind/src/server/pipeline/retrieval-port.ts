/**
 * retrieval-port.ts — RetrievalPort 的现有实现 adapter（2026-10-27）
 *
 * 只做类型适配，不改 context-seed 行为；用于以后替换检索实现时保持调用方不变。
 */
import { searchContext } from "./context-seed";
import type { ContextHit, RetrievalPort, RetrievalQuery } from "./ports";

export function createRetrievalPort(): RetrievalPort {
  return {
    async search(q: RetrievalQuery): Promise<ContextHit[]> {
      const hits = await searchContext({
        query: q.query,
        theme: q.theme,
        kinds: q.kinds as any,
        limit: q.limit,
        agentId: q.agentId ?? null,
        scopeSql: q.scopeSql,
      });
      return hits.map((h) => ({
        kind: h.kind,
        id: h.id,
        title: h.title,
        snippet: h.snippet,
        score: h.score,
        source: h.source,
        theme: h.theme,
      }));
    },
  };
}
