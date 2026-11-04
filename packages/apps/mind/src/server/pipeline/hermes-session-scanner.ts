import { PrismaClient } from "../../../node_modules/.prisma/mind-client";
import { Prisma } from "../../../node_modules/.prisma/mind-client";
import { prisma } from "../../lib/prisma";
import { logger } from "@lions/logger";

const log = logger.child("hermes-scanner");

// Local PrismaClient instance used for Hermes own DB operations

// 2026-06-18: 用真实 hermes work/state.db (旧路径 .hermes/state.db 是 5/26 历史快照, 仅 159 条)
// 用 env override, 默认指向 hermes work
const HERMES_DB_PATH = process.env.HERMES_DB_PATH
  || "~/.hermes/state.db";

export interface HermesSession {
  id: string;
  source: string;
  title: string | null;
  startedAt: Date;
  endedAt: Date | null;
  messageCount: number;
  lastMessageAt: Date | null;
}

export interface HermesMessage {
  sessionId: string;
  role: string;
  content: string | null;
  timestamp: Date;
  toolName: string | null;
  toolCalls: string | null;
}

export interface HermesSyncResult {
  newSessions: HermesSession[];
  updatedSessions: HermesSession[];
  allSessions: HermesSession[];
  errors: string[];
}

function hermesTimestampToDate(ts: number): Date {
  return new Date(ts * 1000);
}

function runPython(script: string): string {
  const scriptPath = `/tmp/hs_${Date.now()}_${Math.random().toString(36).slice(2)}.py`;
  const fs = require("fs");
  fs.writeFileSync(scriptPath, script);
  try {
    const { execSync } = require("child_process");
    // 2026-09-14 f-002 根因修复: execSync 默认 maxBuffer=1MiB, 而 getHermesMessages()
    // 对大 session(实测 20260728_195048_baef32: 500 条消息 JSON = 1,313,126 字节 > 1MiB)
    // 会超限并抛 `spawnSync /bin/sh ENOBUFS`, 该 session 永远失败且不被 markSessionProcessed
    // -> 每轮 cron 重复报错。此处显式抬高上限到 64MiB(仍保留 timeout 防挂死)。
    return execSync(`python3 "${scriptPath}"`, { timeout: 20000, maxBuffer: 64 * 1024 * 1024 }).toString().trim();
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

export async function scanHermesSessions(): Promise<HermesSyncResult> {
  const errors: string[] = [];
  // P2 修复 2026-08-28: 删除 try/finally 里的 prisma.$disconnect()
  // scanHermesSessions 被 runHermesPipeline 调用, 后者跑在 tRPC pipeline.run / auto-rotation (Next.js 服务进程) 内,
  // disconnect 全局共享 PrismaClient 会让后续调用报 "Engine is not yet connected"。
  // 原 try/finally 的唯一作用就是 disconnect, 现已移除, 函数体直接执行。

  // Step 1: get (session_id, last_timestamp) pairs via working query
    // GROUP BY session_id only (avoids JOIN corruption)
    const pairsJson = runPython(`
import sqlite3, json
conn = sqlite3.connect('file:${HERMES_DB_PATH}?mode=ro', uri=True)
cur = conn.cursor()
cur.execute("SELECT session_id, MAX(timestamp) as mx, COUNT(*) as cnt FROM messages WHERE session_id NOT NULL GROUP BY session_id HAVING cnt >= 2 ORDER BY mx DESC LIMIT 2000")
rows = cur.fetchall()
print(json.dumps([{"sid": r[0], "mx": r[1]} for r in rows]))
conn.close()
`);
    const pairs: { sid: string; mx: number }[] = JSON.parse(pairsJson || "[]");
    log.info("scanned hermes sessions", { count: pairs.length });

    // Step 2: 一次性拉所有 session 元数据 (避免 1442 次 python 子进程)
    // 2026-06-18: 单次 python + IN 子句, 比循环快 ~100x
    const allSessions: HermesSession[] = [];
    if (pairs.length > 0) {
      const sids = pairs.map(p => p.sid);
      const mxMap: Record<string, number> = {};
      for (const p of pairs) mxMap[p.sid] = p.mx;
      // 写 sids 到临时文件, python 读 (避免 shell 转义问题)
      const sidsFilePath = `/tmp/hs_sids_${Date.now()}.json`;
      const fs = require("fs");
      fs.writeFileSync(sidsFilePath, JSON.stringify(sids));
      try {
        const allRowsJson = runPython(`
import sqlite3, json
with open('${sidsFilePath}') as f:
    sids = json.load(f)
conn = sqlite3.connect('file:${HERMES_DB_PATH}?mode=ro', uri=True)
cur = conn.cursor()
out = []
# 分批查 (sqlite IN 默认上限 ~1000)
BATCH = 500
for i in range(0, len(sids), BATCH):
    batch = sids[i:i+BATCH]
    placeholders = ",".join(["?"] * len(batch))
    try:
        cur.execute(f"SELECT id, source, title, message_count, started_at, ended_at FROM sessions WHERE id IN ({placeholders})", batch)
        for row in cur.fetchall():
            out.append({"id": row[0], "source": row[1], "title": row[2], "message_count": row[3], "started_at": row[4], "ended_at": row[5]})
    except Exception as e:
        # 部分 batch 损坏, 继续下一批
        pass
conn.close()
print(json.dumps(out))
`);
        const allRows: Array<{ id: string; source: string; title: string | null; message_count: number; started_at: number; ended_at: number | null }> = JSON.parse(allRowsJson || "[]");
        for (const row of allRows) {
          if (row && row.id) {
            allSessions.push({
              id: row.id,
              source: row.source,
              title: row.title || null,
              startedAt: hermesTimestampToDate(row.started_at),
              endedAt: row.ended_at ? hermesTimestampToDate(row.ended_at) : null,
              messageCount: row.message_count || 0,
              lastMessageAt: mxMap[row.id] ? hermesTimestampToDate(mxMap[row.id]) : null,
            });
          }
        }
      } catch (err: any) {
        errors.push(`bulk metadata fetch failed: ${err.message}`);
      } finally {
        try { fs.unlinkSync(sidsFilePath); } catch {}
      }
    }

    log.info("fetched hermes sessions", { fetched: allSessions.length, total: pairs.length });

    const newSessions: HermesSession[] = [];
    const updatedSessions: HermesSession[] = [];

    // 2026-06-18: 一次批量查 SyncLog (避免 1442 次单 SELECT)
    const allSids = allSessions.map(s => s.id);
    const existingLogs = allSids.length > 0
      ? await prisma.syncLog.findMany({
          where: { sourcePath: { in: allSids } },
          select: { sourcePath: true, messageCount: true },
        })
      : [];
    const logMap = new Map(existingLogs.map(l => [l.sourcePath, l.messageCount ?? 0]));

    for (const session of allSessions) {
      const prevCount = logMap.get(session.id);
      if (prevCount === undefined) {
        if (session.messageCount > 0) newSessions.push(session);
      } else if (session.messageCount > prevCount) {
        updatedSessions.push(session);
      }
    }

    return { newSessions, updatedSessions, allSessions, errors };
  }

export async function getHermesMessages(sessionId: string): Promise<HermesMessage[]> {
  const msgsJson = runPython(`
import sqlite3, json
conn = sqlite3.connect('file:${HERMES_DB_PATH}?mode=ro', uri=True)
cur = conn.cursor()
cur.execute("""
SELECT session_id, role, content, timestamp, tool_name, tool_calls
FROM messages
WHERE session_id = ?
ORDER BY timestamp ASC
LIMIT 500
""", ('${sessionId.replace(/'/g, "''")}',))
rows = cur.fetchall()
cols = [d[0] for d in cur.description]
print(json.dumps([dict(zip(cols, row)) for row in rows]))
conn.close()
`);

  const msgs: Record<string, unknown>[] = JSON.parse(msgsJson || "[]");
  return msgs.map((m) => ({
    sessionId: m.session_id as string,
    role: m.role as string,
    content: (m.content as string) || null,
    timestamp: hermesTimestampToDate(m.timestamp as number),
    toolName: (m.tool_name as string) || null,
    toolCalls: (m.tool_calls as string) || null,
  }));
}

export async function markSessionProcessed(
  sourcePath: string,
  messageCount: number,
  prisma: PrismaClient
): Promise<void> {
  await prisma.syncLog.upsert({
    where: { sourcePath },
    update: { lastSyncAt: new Date(), messageCount },
    create: {
      sourceType: "HERMES_SESSION",
      sourcePath,
      status: "COMPLETED",
      messageCount,
      lastSyncAt: new Date(),
    },
  });
}