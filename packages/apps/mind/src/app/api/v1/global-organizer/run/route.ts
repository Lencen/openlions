import { sessionApiKey } from "@/lib/secret";
import { NextRequest, NextResponse } from "next/server";
import { startOrganizeTask } from "@/server/pipeline/global-organizer";

export const dynamic = "force-dynamic";

/**
 * P1-3 (2026-07-12): 增加 groupKey 存在性预校验 + 相似 groupKey 推荐
 *
 * 修复前: 用户传错 groupKey (e.g. Memory.theme 当 groupKey) → 异步 7 步流水线跑到
 *         loadGroupMessages 才抛 404, 任务卡 FAILED 状态污染 _global_organizer_task 表
 *
 * 修复后: 入口先调 session API HEAD 校验, 失败立即返 400 + 相似 groupKey 推荐 (top 5)
 *         不产生 FAILED 任务, 失败率指标更准确
 */

const SESSION_API_BASE = process.env.LIONS_SESSION_API_BASE || "http://localhost:3002/api/v1";
const SESSION_API_KEY = sessionApiKey();

/** 字符级 Jaccard 相似度, 用于 groupKey 推荐 */
function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(""));
  const sb = new Set(b.split(""));
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

interface SessionGroupSummary {
  id: string;
  groupKey: string;
  messageCount: number;
  sessionCount: number;
  extractStatus: string;
}

/** 找最相似的 N 个 groupKey */
async function suggestSimilarGroupKeys(target: string, limit = 5): Promise<SessionGroupSummary[]> {
  try {
    const res = await fetch(
      `${SESSION_API_BASE}/session-groups?limit=200`,
      { headers: { "X-API-Key": SESSION_API_KEY } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    const items: SessionGroupSummary[] = data.items || [];
    return items
      .map((g) => ({ g, score: jaccard(target, g.groupKey) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.g);
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const groupKey = body.groupKey;

    if (!groupKey) {
      return NextResponse.json({ error: "groupKey is required" }, { status: 400 });
    }

    // === 预校验: groupKey 必须真实存在于 session DB ===
    const checkRes = await fetch(
      `${SESSION_API_BASE}/session-groups/${encodeURIComponent(groupKey)}`,
      { headers: { "X-API-Key": SESSION_API_KEY } },
    );

    if (checkRes.status === 404) {
      const suggestions = await suggestSimilarGroupKeys(groupKey);
      return NextResponse.json(
        {
          error: `Group not found: "${groupKey}"`,
          hint: "groupKey 必须是 session DB 里的真实 SessionGroup.groupKey, 不是 Memory.theme 或 Knowledge.title",
          suggestions: suggestions.map((s) => ({
            groupKey: s.groupKey,
            messageCount: s.messageCount,
            sessionCount: s.sessionCount,
            extractStatus: s.extractStatus,
          })),
          suggestionCount: suggestions.length,
        },
        { status: 400 },
      );
    }

    if (!checkRes.ok) {
      return NextResponse.json(
        { error: `session API ${checkRes.status}` },
        { status: 502 },
      );
    }

    // 校验通过, 启动异步任务
    const taskId = startOrganizeTask(groupKey);

    return NextResponse.json({
      taskId,
      groupKey,
      status: "STARTED",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}