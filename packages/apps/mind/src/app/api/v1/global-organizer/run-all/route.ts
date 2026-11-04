import { sessionApiKey } from "@/lib/secret";
import { NextRequest, NextResponse } from "next/server";
import { startOrganizeTask } from "@/server/pipeline/global-organizer";

export const dynamic = "force-dynamic";

// ===== 2026-09-03: 聚合只吃"真实主题组" (聚合闭环 STEP3) =====
// 排除机器桶: cron 组 / untitled 大杂烩 / hermes 日期命名组 / uuid.che 残留 / 超大组
function isAggregatableGroupKey(groupKey: string): boolean {
  if (!groupKey) return false;
  const k = groupKey.trim();
  if (k.startsWith("cron")) return false;
  if (k.includes(":untitled") || k.endsWith(":untitled")) return false;
  if (/^\d{8}_\d{6}_/.test(k)) return false;               // hermes 日期命名 (20260712_223227_xxx)
  if (/^[0-9a-f-]{20,}/.test(k)) return false;               // uuid 残留
  if (/\.che$/.test(k)) return false;
  if (/^\d+$/.test(k)) return false;
  return true;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const status = body.status || "PENDING";
    const want = Math.max(1, Math.min(parseInt(body.limit, 10) || 1, 5));
    const fetchLimit = Math.min(want * 20, 100); // 多取以便过滤后仍有足够真实组

    const res = await fetch(
      `http://localhost:3002/api/v1/session-groups?status=${status}&limit=${fetchLimit}`,
      {
        headers: { "X-API-Key": sessionApiKey() },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `session API ${res.status}` },
        { status: 502 },
      );
    }
    const data = await res.json();
    const groups: Array<{ groupKey: string; sessionCount?: number }> = data.items || [];
    const filtered = groups
      .filter((g) => isAggregatableGroupKey(g.groupKey))
      .slice(0, want);

    const tasks = filtered.map((g) => ({
      groupKey: g.groupKey,
      taskId: startOrganizeTask(g.groupKey),
    }));

    return NextResponse.json({
      tasks,
      totalQueued: tasks.length,
      filteredFrom: groups.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
