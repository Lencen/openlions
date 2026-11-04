import { sessionApiKey } from "@/lib/secret";
import { NextRequest, NextResponse } from "next/server";
import { startOrganizeTask } from "@/server/pipeline/global-organizer";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * P1-4 (2026-07-12): 让 OrganizeCron 自动重试 FAILED 任务
 *
 * 修复前: FAILED 的 groupKey 永远卡 FAILED 状态, _global_organizer_task 表 FAILED 数只增不减
 *
 * 修复后:
 *   - GET /api/v1/global-organizer/retry-failed?windowHours=24
 *   - 从 _global_organizer_task 查最近 N 小时内 FAILED 的 DISTINCT groupKey
 *   - 校验这些 groupKey 在 session DB 是否还存在 (过滤误传)
 *   - 把仍然存在的 SessionGroup 重置成 PENDING (调 session PATCH API)
 *   - 立即 startOrganizeTask 重跑
 *   - 不存在的 groupKey 直接跳过 (误传, 重试也是失败)
 *
 * 预期效果:
 *   - 网络/超时类失败自动恢复
 *   - 误传类失败自动归档 (留在 _global_organizer_task 历史里, 但不再被重试)
 */

const SESSION_API_BASE = process.env.LIONS_SESSION_API_BASE || "http://localhost:3002/api/v1";
const SESSION_API_KEY = sessionApiKey();

interface FailedGroup {
  groupKey: string;
  lastFailTs: number;
  failCount: number;
  lastError: string | null;
}

async function checkSessionExists(groupKey: string): Promise<boolean> {
  const res = await fetch(
    `${SESSION_API_BASE}/session-groups/${encodeURIComponent(groupKey)}`,
    { headers: { "X-API-Key": SESSION_API_KEY } },
  );
  return res.ok;
}

async function resetToPending(groupKey: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SESSION_API_BASE}/session-groups/${encodeURIComponent(groupKey)}/status`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": SESSION_API_KEY,
        },
        body: JSON.stringify({ extractStatus: "PENDING" }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const windowHours = parseInt(url.searchParams.get("windowHours") ?? "24", 10);
  const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
  const dryRun = url.searchParams.get("dryRun") === "true";

  if (Number.isNaN(windowHours) || windowHours < 1) {
    return NextResponse.json({ error: "windowHours must be positive integer" }, { status: 400 });
  }

  const sinceTs = Date.now() - windowHours * 3600 * 1000;

  // 坑19: Prisma SQLite $queryRaw 对大 INTEGER 必须 CAST AS REAL + 字符串拼接
  const rows = await prisma.$queryRawUnsafe<Array<{
    groupKey: string;
    lastFail: number;
    failCount: number;
    lastError: string | null;
  }>>(
    `SELECT groupKey,
            CAST(MAX(startedAt) AS REAL) as lastFail,
            COUNT(*) as failCount,
            (SELECT error FROM _global_organizer_task t2
             WHERE t2.groupKey = _global_organizer_task.groupKey
               AND t2.status = 'FAILED'
             ORDER BY t2.startedAt DESC LIMIT 1) as lastError
     FROM _global_organizer_task
     WHERE status = 'FAILED' AND startedAt >= ${sinceTs}
     GROUP BY groupKey
     ORDER BY lastFail DESC
     LIMIT ${limit}`,
  ) as any[];

  // Prisma BigInt 转 Number
  const failedGroups: FailedGroup[] = rows.map((r) => ({
    groupKey: r.groupKey,
    lastFailTs: Number(r.lastFail),
    failCount: Number(r.failCount),
    lastError: r.lastError,
  }));

  const results = {
    windowHours,
    dryRun,
    timestamp: new Date().toISOString(),
    candidates: failedGroups.length,
    willRetry: [] as Array<{ groupKey: string; taskId: string; resetOk: boolean }>,
    skipped: [] as Array<{ groupKey: string; reason: string; lastError: string | null }>,
  };

  for (const g of failedGroups) {
    // 1. 校验 groupKey 仍在 session DB
    const exists = await checkSessionExists(g.groupKey);
    if (!exists) {
      results.skipped.push({
        groupKey: g.groupKey,
        reason: "groupKey 不在 session DB (误传, 重试也是失败)",
        lastError: g.lastError,
      });
      continue;
    }

    if (dryRun) {
      results.willRetry.push({
        groupKey: g.groupKey,
        taskId: "(dry-run, 未启动)",
        resetOk: true,
      });
      continue;
    }

    // 2. 重置 SessionGroup → PENDING
    const resetOk = await resetToPending(g.groupKey);

    // 3. 启动 organize 任务
    const taskId = startOrganizeTask(g.groupKey);

    results.willRetry.push({ groupKey: g.groupKey, taskId, resetOk });
  }

  return NextResponse.json(results);
}