/**
 * todo-consumer.ts — 待办消费者判据(服务端路由侧) 2026-09-15
 *
 * 与 scripts/lib/todo-consumer.cjs **同源同判据**: 常量读同一份 todo-consumer.config.json;
 * 交叉一致性由 scripts/test-todo-consumer-guard.cjs 在真实库上对拍(TS 路由行为 vs CJS 库判定)。
 *
 * 为什么需要: 「待办指派给一个活着但没有 todo_worker 的身份」= 静默死掉 —— 归属约束让别的 agent
 *   领不走(ownerId 非空), 而它自己又不认领待办(执行体只认 Task)。2026-09-15 实测 agent-d
 *   名下 49 条未结待办、最久 20.1 小时, 根因就是这个。所以**指派前必须校验消费者**。
 */
import cfg from "./todo-consumer.config.json";
import { prisma } from "@/lib/prisma";
import { todoRepo } from "@/server/lib/todo-repo";
import { runtimeRepo } from "@/server/lib/runtime-repo";

export const TODO_CONSUMER_VERSION: string = String(cfg.version);
export const CONSUMER_TABLE: string = String(cfg.consumerTable);
export const HEARTBEAT_FRESH_MS: number = Number(cfg.heartbeatFreshMinutes) * 60000;
export const ACTIVITY_EVIDENCE_MS: number = Number(cfg.activityEvidenceMinutes) * 60000;
export const OWNED_OPEN_TIMEOUT_MS: number = Number(cfg.ownedOpenTimeoutMinutes) * 60000;
export const CONSUMERLESS_GRACE_MS: number = Number(cfg.consumerlessGraceMinutes) * 60000;

export const CONSUMER_DDL =
  "CREATE TABLE IF NOT EXISTS " + CONSUMER_TABLE + " (" +
  "agent_id TEXT PRIMARY KEY, host TEXT, pid INTEGER, worker TEXT, " +
  "first_seen_at INTEGER NOT NULL, last_heartbeat_at INTEGER NOT NULL, heartbeat_count INTEGER NOT NULL DEFAULT 1)";

export type ConsumerState = {
  agentId: string; status: string; registered: boolean; active: boolean;
  channel: string | null;
  heartbeatAt: number | null; heartbeatFresh: boolean;
  activityAt: number | null; activityFresh: boolean;
  consumer: boolean; reason: string;
  host: string | null; pid: number | null; worker: string | null;
};

export type AssignGate = { reject: boolean; code: string; reason: string; state: ConsumerState | null };

export function ensureConsumerTable(db: any): string {
  try { db.exec(CONSUMER_DDL); } catch { /* readonly 连接: 沿用已存在的表 */ }
  return CONSUMER_TABLE;
}

export async function recordHeartbeat(_db: any, { agentId, host, pid, worker, now }: any = {}): Promise<any> {
  const id = String(agentId || "").trim();
  if (!id) throw new Error("need agentId");
  const ts = Number(now || Date.now());
  // 2026-10-23 P5: 心跳写走 runtime-repo（sqlite/dual/pg）
  await runtimeRepo.run(
    "INSERT INTO " + CONSUMER_TABLE + " (agent_id,host,pid,worker,first_seen_at,last_heartbeat_at,heartbeat_count) " +
    "VALUES (?,?,?,?,?,?,1) " +
    "ON CONFLICT(agent_id) DO UPDATE SET host=excluded.host, pid=excluded.pid, worker=excluded.worker, " +
    "last_heartbeat_at=excluded.last_heartbeat_at, heartbeat_count=" + CONSUMER_TABLE + ".heartbeat_count+1",
    id, host == null ? null : String(host), pid == null ? null : Number(pid), worker == null ? null : String(worker), ts, ts
  );
  return { agentId: id, at: ts };
}

/**
 * 近 activityEvidenceMinutes 内的真实消费活动。只认消费者自己做出的动作(认领 TODO_CLAIMED / 结单 doneBy),
 * **不认**「Todo.status='DOING' 且归属它」—— 见 CJS 同名函数的说明: 那是可伪造的(独立复核 RK2 绕过就
 * 用一条手工 DOING 待办伪造出"有消费者")。
 */
export async function lastConsumerActivity(db: any, agentId: string): Promise<number | null> {
  const id = String(agentId);
  // 2026-10-23 修迁移遗留: 切 PG 后 FlywheelEvent 在 PG，SQLite 里是冻结快照(实测最新停在 10-21)，
  //   继续读 SQLite 会把"最近认领过"误判成"无活动"。PG 模式下走 prisma。
  const isPg = (process.env.MIND_DB_DRIVER || "").toLowerCase() === "pg";
  let claimAt: number | null = null;
  try {
    if (isPg) {
      const rows: any[] = await prisma.$queryRawUnsafe(
        'SELECT (extract(epoch from MAX("createdAt"))*1000)::bigint AS m FROM "FlywheelEvent" WHERE stage=\'TODO_CLAIMED\' AND strpos("sourceTitle", \'by=\' || $1 || \' \') = 1', id);
      claimAt = rows?.[0]?.m == null ? null : Number(rows[0].m);
    } else {
      const claim: any = db.prepare(
        "SELECT MAX(createdAt) m FROM FlywheelEvent WHERE stage='TODO_CLAIMED' AND instr(sourceTitle, 'by=' || ? || ' ') = 1"
      ).get(id);
      claimAt = claim?.m == null ? null : Number(claim.m);
    }
  } catch { claimAt = null; }
  let doneAt: number | null = null;
  try {
    const done: any = await todoRepo.get(
      "SELECT MAX(COALESCE(doneAt, updatedAt)) m FROM Todo WHERE ownerType='agent' AND (doneBy=? OR doneBy=?)", id, "agent:" + id);
    doneAt = done?.m == null ? null : Number(done.m);
  } catch { doneAt = null; }
  const max = Math.max(0, claimAt || 0, doneAt || 0);
  return max > 0 ? max : null;
}

export async function consumerStates(db: any, now?: number): Promise<ConsumerState[]> {
  const ts = Number(now || Date.now());
  ensureConsumerTable(db);
  const isPg = (process.env.MIND_DB_DRIVER || "").toLowerCase() === "pg";
  const agents: any[] = isPg
    ? ((await prisma.$queryRawUnsafe('SELECT agent_id, status, channel FROM "AgentRegistry" ORDER BY agent_id')) as any[])
    : db.prepare("SELECT agent_id, status, channel FROM AgentRegistry ORDER BY agent_id").all();
  let hbRows: any[] = [];
  try { hbRows = await runtimeRepo.all("SELECT * FROM " + CONSUMER_TABLE); } catch { hbRows = []; }
  const hb = new Map<string, any>(hbRows.map((r: any) => [String(r.agent_id), r]));
  const out: ConsumerState[] = [];
  for (const a of agents) {
    const id = String(a.agent_id);
    const h = hb.get(id);
    const heartbeatAt = h ? Number(h.last_heartbeat_at) : null;
    const heartbeatFresh = heartbeatAt != null && ts - heartbeatAt <= HEARTBEAT_FRESH_MS;
    const activityAt = await lastConsumerActivity(db, id);
    const activityFresh = activityAt != null && ts - activityAt <= ACTIVITY_EVIDENCE_MS;
    const consumer = heartbeatFresh || activityFresh;
    let reason: string;
    if (heartbeatFresh) reason = "心跳新鲜(" + Math.round((ts - (heartbeatAt as number)) / 1000) + "s前)";
    else if (activityFresh) reason = "近 " + cfg.activityEvidenceMinutes + "min 有消费活动";
    else if (heartbeatAt != null) reason = "心跳已过期(" + Math.round((ts - heartbeatAt) / 60000) + "min前)";
    else reason = "从未上报心跳, 也无消费活动";
    out.push({
      agentId: id, status: String(a.status), registered: true, active: String(a.status) === "ACTIVE",
      channel: a.channel == null ? null : String(a.channel),
      heartbeatAt, heartbeatFresh, activityAt, activityFresh, consumer, reason,
      host: h ? (h.host == null ? null : String(h.host)) : null, pid: h ? h.pid : null, worker: h ? (h.worker == null ? null : String(h.worker)) : null,
    });
  }
  return out;
}

export async function hasTodoConsumer(db: any, agentId: string, now?: number): Promise<boolean> {
  const st = (await consumerStates(db, now)).find((s) => s.agentId === String(agentId));
  if (!st || !st.active) return false;
  return !!st.consumer;
}

/** 指派前闸门: 决定"把 OPEN 待办指派给 agent"是否该被拒绝并留空走公开队列。 */
export async function shouldRejectAssignment(db: any, agentId: string, now?: number): Promise<AssignGate> {
  const id = String(agentId || "").trim();
  if (!id) return { reject: true, code: "EMPTY_OWNER", reason: "ownerId 为空", state: null };
  const st = (await consumerStates(db, now)).find((s) => s.agentId === id) || null;
  if (!st) return { reject: true, code: "UNKNOWN_AGENT", reason: "agent '" + id + "' 未在 AgentRegistry 登记", state: null };
  if (!st.active) return { reject: true, code: "NOT_ACTIVE", reason: "agent '" + id + "' 状态 " + st.status + " 非 ACTIVE", state: st };
  if (!st.consumer) return { reject: true, code: "NO_CONSUMER", reason: "agent '" + id + "' 无待办消费者(" + st.reason + ")", state: st };
  return { reject: false, code: "OK", reason: st.reason, state: st };
}
