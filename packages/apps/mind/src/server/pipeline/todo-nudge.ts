/**
 * todo-nudge.ts — 任务级催办 MVP（阶段 1，无新表）
 *
 * 数据只有两处：
 *   - Todo.meta.nudge / Todo.meta.escalation（deadline / nextAt / level / target / lastMessageId）
 *   - AuditLog（每次 scan/sent/skip/escalate/fail 留痕）
 *
 * 发送走 MACS /api/reply；client_message_id = nudge:<todoId>:<level>。
 * 不接 dsh-agent-lines，不新增表，不改 Todo 表结构。
 */
import cron, { type ScheduledTask } from "node-cron";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { todoRepo } from "@/server/lib/todo-repo";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/server/lib/audit-log";

export interface NudgeOptions {
  now?: number;
  dryRun?: boolean;
  limit?: number;
  leadMs?: number;
  cooldownMs?: number;
}

export interface NudgeResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  planned: Array<{ id: string; level: number; target: string; clientMessageId: string }>;
  errors: string[];
}

type NudgeMeta = {
  enabled?: boolean;
  deadlineAt?: number;
  target?: string;
  manager?: string;
  escalationTarget?: string;
  level?: number;
  state?: string;
  nextAt?: number;
  lastAt?: number;
  lastClientId?: string;
  lastMessageId?: string;
  sentCount?: number;
  cooldownMs?: number;
};

function macsBase(): string {
  return (process.env.MACS_BASE_URL || process.env.MACS_BASE || "http://127.0.0.1:8765").replace(/\/$/, "");
}

function macsToken(): { token?: string; apiKey?: string } {
  const direct = process.env.MIND_MACS_TOKEN || process.env.MACS_NUDGE_TOKEN;
  if (direct) return { token: direct };
  const file = process.env.MIND_MACS_TOKEN_FILE || process.env.MACS_NUDGE_TOKEN_FILE;
  if (file) {
    try { return { token: readFileSync(resolve(file.replace(/^~\//, homedir() + "/")), "utf8").trim() }; } catch { /* fall through */ }
  }
  const apiKey = process.env.MIND_MACS_API_KEY || process.env.MACS_NUDGE_API_KEY;
  return apiKey ? { apiKey } : {};
}

function senderId(): string {
  return process.env.MIND_NUDGE_SENDER_ID || "agent-d";
}

function targetAddress(target: string): string {
  if (target.includes("#")) return target;
  return senderId() + "#" + target;
}

function nudgeText(input: { id: string; title: string; priority: string; level: number; deadlineAt: number }): string {
  const deadline = new Date(input.deadlineAt).toISOString();
  return [
    "[TODO 催办 L" + input.level + "]",
    "待办 " + input.id + "「" + input.title.slice(0, 120) + "」",
    "优先级 " + input.priority + "；截止 " + deadline + "。",
    "请直接更新待办状态（DOING/DONE/BLOCKED）或在待办里写进展；无需回复本消息。",
  ].join("\n");
}

async function sendNudge(input: { id: string; title: string; priority: string; level: number; deadlineAt: number; target: string }): Promise<{ messageId: string }> {
  const auth = macsToken();
  if (!auth.token && !auth.apiKey) throw new Error("MACS_NUDGE_TOKEN_FILE / MIND_MACS_API_KEY is not configured");
  const clientMessageId = "nudge:" + input.id + ":" + input.level;
  const res = await fetch(macsBase() + "/api/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth.token ? { "x-session-token": auth.token } : { "x-api-key": auth.apiKey! }),
    },
    body: JSON.stringify({
      sender_id: senderId(),
      to: targetAddress(input.target),
      text: nudgeText(input),
      message_type: "p2p_text",
      client_message_id: clientMessageId,
      intent: "todo_nudge",
      correlation_id: "todo:" + input.id,
      ttl: 3600,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("MACS /api/reply HTTP " + res.status + ": " + JSON.stringify(body).slice(0, 200));
  const messageId = String(body.message_id || body.id || "");
  if (!messageId) throw new Error("MACS /api/reply returned no message_id");
  return { messageId };
}

function parseMeta(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw;
  try { return raw ? JSON.parse(String(raw)) : {}; } catch { return {}; }
}

async function updateTodoMeta(id: string, meta: Record<string, any>, now: number): Promise<void> {
  await prisma.$executeRaw`UPDATE "Todo" SET meta = ${JSON.stringify(meta)}, "updatedAt" = ${now} WHERE id = ${id}`;
}

function audit(action: string, id: string, meta: Record<string, any>): Promise<void> {
  return recordAudit({
    entityType: "Todo",
    entityId: id,
    action,
    actor: "todo-nudge",
    actorType: "SYSTEM",
    metadata: meta,
  });
}

/**
 * Scan open todos with meta.nudge.enabled and send at most one nudge per row.
 * Level 1/2/3; cooldown + client_message_id prevent loops.
 */
export async function runTodoNudges(opts: NudgeOptions = {}): Promise<NudgeResult> {
  const now = opts.now ?? Date.now();
  const leadMs = Math.max(0, opts.leadMs ?? Number(process.env.TODO_NUDGE_LEAD_MS || 30 * 60_000));
  const cooldownMs = Math.max(60_000, opts.cooldownMs ?? Number(process.env.TODO_NUDGE_COOLDOWN_MS || 30 * 60_000));
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const result: NudgeResult = { scanned: 0, sent: 0, skipped: 0, failed: 0, planned: [], errors: [] };

  let rows: any[] = [];
  try {
    rows = await todoRepo.all(
      "SELECT id, title, status, priority, \"dueAt\", \"ownerType\", \"ownerId\", meta FROM \"Todo\" " +
      "WHERE status IN ('OPEN','DOING','BLOCKED') AND meta IS NOT NULL AND meta LIKE '%\"nudge\"%' ORDER BY COALESCE(\"dueAt\", 9e15), \"createdAt\" ASC LIMIT " + limit
    );
  } catch (e: any) {
    result.errors.push("scan failed: " + (e?.message || e));
    return result;
  }

  for (const row of rows) {
    result.scanned++;
    const id = String(row.id);
    const meta = parseMeta(row.meta);
    const n = (meta.nudge || null) as NudgeMeta | null;
    if (!n || n.enabled !== true) { result.skipped++; continue; }
    if (n.state === "ESCALATED") { result.skipped++; continue; }
    const deadlineAt = Number(n.deadlineAt ?? row.dueAt);
    if (!Number.isFinite(deadlineAt)) { result.skipped++; await audit("TODO_NUDGE_SKIPPED", id, { reason: "NO_DEADLINE" }); continue; }

    const level = Math.max(1, Math.min(3, Number(n.level || 0) + 1));
    const nextAt = Number(n.nextAt ?? (deadlineAt - leadMs));
    if (Number.isFinite(nextAt) && now < nextAt) { result.skipped++; continue; }
    const lastAt = Number(n.lastAt || 0);
    if (lastAt && now - lastAt < Math.max(cooldownMs, Number(n.cooldownMs || 0))) { result.skipped++; await audit("TODO_NUDGE_SKIPPED", id, { reason: "COOLDOWN", level }); continue; }

    const target = level >= 3
      ? (n.escalationTarget || n.manager || n.target)
      : (level === 2 ? (n.manager || n.target) : n.target);
    if (!target) { result.skipped++; await audit("TODO_NUDGE_SKIPPED", id, { reason: "NO_TARGET", level }); continue; }

    const clientMessageId = "nudge:" + id + ":" + level;
    result.planned.push({ id, level, target, clientMessageId });
    if (opts.dryRun) continue;

    try {
      const sent = await sendNudge({ id, title: String(row.title || ""), priority: String(row.priority || "P2"), level, deadlineAt, target });
      const next: Record<string, any> = {
        ...meta,
        nudge: {
          ...n,
          enabled: true,
          deadlineAt,
          target: n.target || target,
          manager: n.manager || null,
          escalationTarget: n.escalationTarget || null,
          level,
          state: level >= 3 ? "ESCALATED" : "SENT",
          lastAt: now,
          nextAt: level >= 3 ? null : now + cooldownMs,
          lastClientId: clientMessageId,
          lastMessageId: sent.messageId,
          sentCount: Number(n.sentCount || 0) + 1,
          cooldownMs,
        },
        ...(level >= 3 ? { escalation: { level: 3, at: now, target, reason: "MAX_LEVEL" } } : {}),
      };
      await updateTodoMeta(id, next, now);
      result.sent++;
      await audit(level >= 3 ? "TODO_NUDGE_ESCALATED" : "TODO_NUDGE_SENT", id, { level, target, clientMessageId, messageId: sent.messageId });
    } catch (e: any) {
      result.failed++;
      const err = e?.message || String(e);
      result.errors.push(id + ": " + err);
      await updateTodoMeta(id, {
        ...meta,
        nudge: { ...n, enabled: true, deadlineAt, target: n.target || target, lastError: err, nextAt: now + 5 * 60_000 },
      }, now).catch(() => null);
      await audit("TODO_NUDGE_FAILED", id, { level, target, clientMessageId, error: err });
    }
  }
  return result;
}

let scheduler: ScheduledTask | null = null;

/** Idempotent in-process scheduler; call from API/bootstrap, never at module load. */
export function initTodoNudgeScheduler(): void {
  if (scheduler) return;
  scheduler = cron.schedule("*/5 * * * *", () => {
    runTodoNudges().catch((e) => console.error("[todo-nudge] run failed", e));
  });
  scheduler.start();
}

export function stopTodoNudgeScheduler(): void {
  scheduler?.stop();
  scheduler = null;
}
