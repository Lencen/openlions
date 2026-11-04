/**
 * 2026-06-17 P4 NEW: Session Registry Router (SHARED-BRAIN V3)
 *
 * 设计目标: 所有 agent 把 session 元信息 + 关键消息上报到这个中枢服务
 *   - agent.uploadSession: agent 端调用, 每 15 分钟 push 一次
 *   - session.list: dashboard 查看所有 session
 *   - session.claim: pipeline worker 拉 PENDING (老到新)
 *   - session.update: pipeline 处理完后更新 status
 *   - session.stats: 状态分布统计
 *
 * 鉴权:
 *   - uploadSession / claim / update: protectedProcedure (需 apiKey)
 *   - list / stats: publicProcedure (dashboard 可读)
 *
 * 实现: 不用 Prisma client 的 SessionRegistry model (Node 版本限制),
 *   直接用 $queryRaw / $executeRaw 操作 SQLite
 */

import { z } from "zod";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

// ─── Helpers ───────────────────────────────────────────────────────────

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function genCuid(): string {
  // Prisma @default(cuid()) 格式 (大致, 实际用 crypto.randomUUID 更稳)
  return "c" + crypto.randomBytes(12).toString("hex") + Date.now().toString(36);
}

function fingerprintOf(agentId: string, source: string, sourceId: string): string {
  return sha256(`${agentId}|${source}|${sourceId}`);
}

function buildSessionUid(agentId: string, source: string, sourceId: string): string {
  // 格式: {agent_id}:{source_lower}:{source_id}
  //   例如 "agent-h:claude_conversation:abc-123"
  //   不再加 "agent-" 前缀, 因为 agent_id 本身已经包含 (kebab-case 规范)
  return `${agentId}:${source.toLowerCase()}:${sourceId}`;
}

// ─── Router ────────────────────────────────────────────────────────────

export const sessionRegistryRouter = createRouter({
  /**
   * agent.uploadSession - Agent 端调用, 上报一个 session 元信息
   *
   * 入参:
   *   - agent_id: 哪个 agent
   *   - source: CLAUDE_CONVERSATION | HERMES_SESSION | OPENAI_THREAD | CUSTOM
   *   - source_id: 原始 source 的 session id
   *   - title?: 可选
   *   - started_at?: ISO 字符串
   *   - ended_at?: ISO 字符串
   *   - last_message_at?: ISO 字符串
   *   - message_count?: int
   *   - raw_payload?: { messages: [...], metadata: {...} } (限 1MB)
   *
   * 行为:
   *   - 计算 fingerprint = sha256(agent_id|source|source_id)
   *   - 若已存在 (fingerprint 冲突): 更新 title/last_message_at/message_count/raw_payload
   *   - 若不存在: INSERT 新行, status=PENDING
   *
   * 返回: { session_uid, fingerprint, action: "created" | "updated" }
   */
  uploadSession: protectedProcedure
    .input(
      // P3-9 修复: tRPC v11 client 把 input 包装成 {json:{...}}, z.preprocess 先拆
      //   - 兼容裸对象 (v10 client / curl 直接传) 和 v11 wrapper
      //   - 跟之前 memory / skills router 的处理一致
      z.preprocess(
        (val: any) => {
          if (val && typeof val === "object" && "json" in val && typeof val.json === "object") {
            return val.json;
          }
          return val;
        },
        z.object({
          agent_id: z.string().min(1),
          source: z.enum(["CLAUDE_CONVERSATION", "HERMES_SESSION", "OPENAI_THREAD", "CUSTOM"]),
          source_id: z.string().min(1),
          title: z.string().optional(),
          started_at: z.string().datetime().optional(),
          ended_at: z.string().datetime().optional(),
          last_message_at: z.string().datetime().optional(),
          message_count: z.number().int().nonnegative().optional(),
          raw_payload: z.record(z.string(), z.any()).optional(),
        })
      )
    )
    .mutation(async ({ input }) => {
      // 1. 校验 payload 大小
      let rawPayloadStr: string | null = null;
      let payloadSize = 0;
      if (input.raw_payload) {
        rawPayloadStr = JSON.stringify(input.raw_payload);
        payloadSize = Buffer.byteLength(rawPayloadStr, "utf8");
        if (payloadSize > MAX_PAYLOAD_SIZE) {
          throw new Error(`payload size ${payloadSize} exceeds 1MB limit`);
        }
      }

      // 2. 计算 fingerprint + session_uid
      const fingerprint = fingerprintOf(input.agent_id, input.source, input.source_id);
      const sessionUid = buildSessionUid(input.agent_id, input.source, input.source_id);

      // 3. 检查已存在
      const existing = await prisma.$queryRawUnsafe<Array<{
        id: string;
        status: string;
      }>>(
        `SELECT id, status FROM SessionRegistry WHERE fingerprint = ?`,
        fingerprint
      );

      const now = new Date().toISOString();
      if (existing.length > 0) {
        // 已存在: 更新元信息, 但不重置 status (PIPELINE 可能在 PROCESSING)
        const row = existing[0];
        await prisma.$executeRawUnsafe(
          `UPDATE SessionRegistry
           SET title = ?, last_message_at = ?, message_count = ?,
               raw_payload = ?, payload_size = ?, updated_at = ?
           WHERE fingerprint = ?`,
          input.title ?? null,
          input.last_message_at ?? null,
          input.message_count ?? 0,
          rawPayloadStr,
          payloadSize,
          now,
          fingerprint
        );
        return {
          session_uid: sessionUid,
          fingerprint,
          action: "updated" as const,
          previous_status: row.status,
        };
      }

      // 4. 新建
      const id = genCuid();
      await prisma.$executeRawUnsafe(
        `INSERT INTO SessionRegistry
         (id, session_uid, agent_id, source, source_id, title,
          started_at, ended_at, last_message_at, message_count,
          status, fingerprint, raw_payload, payload_size,
          uploaded_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
        id,
        sessionUid,
        input.agent_id,
        input.source,
        input.source_id,
        input.title ?? null,
        input.started_at ?? null,
        input.ended_at ?? null,
        input.last_message_at ?? null,
        input.message_count ?? 0,
        fingerprint,
        rawPayloadStr,
        payloadSize,
        now,
        now
      );
      return {
        session_uid: sessionUid,
        fingerprint,
        action: "created" as const,
        id,
      };
    }),

  /**
   * session.list - Dashboard 查看所有 session (可按 agent / source / status 过滤)
   */
  list: publicProcedure
    .input(
      z.preprocess(
        (val: any) => {
          if (val && typeof val === "object" && "json" in val && typeof val.json === "object") {
            return val.json;
          }
          return val;
        },
        z.object({
          agent_id: z.string().optional(),
          source: z.string().optional(),
          status: z.string().optional(),
          search: z.string().optional(),
          limit: z.number().int().min(1).max(500).default(100),
          offset: z.number().int().min(0).default(0),
          // B18 修复 (2026-06-18 15:25): 前端可调排序
          sortBy: z.enum(["uploaded_at", "updated_at", "last_message_at", "started_at", "message_count"]).default("updated_at"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
          // B21: 活动 session 过滤 (true=只看 last_message_at 30 分钟内)
          activeOnly: z.boolean().optional(),
        }).optional()
      )
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 100;
      const offset = input?.offset ?? 0;

      // WHERE 拼接 (sqlite safe, 都用 ? 占位)
      const where: string[] = [];
      const params: (string | number)[] = [];

      if (input?.agent_id) {
        where.push("agent_id = ?");
        params.push(input.agent_id);
      }
      if (input?.source) {
        where.push("source = ?");
        params.push(input.source);
      }
      if (input?.status) {
        where.push("status = ?");
        params.push(input.status);
      }
      // Phase 7 v2: search 走 title LIKE
      if (input?.search) {
        where.push("title LIKE ?");
        params.push(`%${input.search}%`);
      }
      // B21: 活动中 session 过滤 (last_message_at 30 分钟内)
      if (input?.activeOnly) {
        where.push("datetime(last_message_at) > datetime('now', '-30 minutes')");
      }

      // P1-D 2026-08-31 修复: 原 $queryRawUnsafe 在 Prisma 5.22 + SQLite 下
      //   带参数查询返 'Raw query failed. Code: N/A' + COUNT 返 BigInt 序列化失败,
      //   /agents/sessions 列表 500. 改用 Prisma model (Node 22 已无版本限制)。
      const sortBy = (input?.sortBy || "updated_at") as any;
      const sortOrder = (input?.sortOrder || "desc") as any;
      const whereModel: any = {};
      if (input?.agent_id) whereModel.agent_id = input.agent_id;
      if (input?.source) whereModel.source = input.source;
      if (input?.status) whereModel.status = input.status;
      if (input?.search) whereModel.title = { contains: input.search };
      if (input?.activeOnly) whereModel.last_message_at = { gt: new Date(Date.now() - 30 * 60 * 1000) };
      // P1-D: 只查列表所需字段, 排除 raw_payload (1MB JSON blob)
      //   - 避免 Prisma SQLite 对 BLOB/大字符串转换的 'invalid characters' 失败
      //   - 大幅降低 list 查询 IO (raw_payload 由 claim/process 路径按需读)
      const rows = await prisma.sessionRegistry.findMany({
        select: {
          id: true,
          session_uid: true,
          agent_id: true,
          source: true,
          source_id: true,
          title: true,
          started_at: true,
          ended_at: true,
          last_message_at: true,
          message_count: true,
          status: true,
          processed_at: true,
          processing_error: true,
          fingerprint: true,
          payload_size: true,
          uploaded_at: true,
          updated_at: true,
        },
        where: whereModel,
        orderBy: { [sortBy]: sortOrder },
        take: limit,
        skip: offset,
      });
      const total = await prisma.sessionRegistry.count({ where: whereModel });

      return {
        items: rows.map((r) => ({
          ...r,
          message_count: Number(r.message_count),
          payload_size: Number(r.payload_size),
        })),
        total,
        limit,
        offset,
      };
    }),

  /**
   * session.claim - Pipeline worker 拉一批 PENDING session (原子, FIFO 顺序)
   *
   * 行为:
   *   - 找出 status=PENDING 的 N 条, 按 uploaded_at ASC (老到新)
   *   - 立即把它们的 status 改成 PROCESSING (避免并发重复拉)
   *   - 返回这批 session (含 raw_payload)
   *
   * 注意: SQLite 单文件, 默认串行化, UPDATE...WHERE status='PENDING' 是原子的
   *        多进程 worker 也能安全 (单文件锁)
   */
  claim: protectedProcedure
    .input(
      z.preprocess(
        (val: any) => {
          if (val && typeof val === "object" && "json" in val && typeof val.json === "object") {
            return val.json;
          }
          return val;
        },
        z.object({
          limit: z.number().int().min(1).max(50).default(5),
        }).optional()
      )
    )
    .mutation(async ({ input }) => {
      const limit = input?.limit ?? 5;

      // 先 SELECT 候选
      const candidates = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM SessionRegistry
         WHERE status = 'PENDING'
         ORDER BY uploaded_at ASC
         LIMIT ?`,
        limit
      );

      if (candidates.length === 0) {
        return { claimed: [], count: 0 };
      }

      const ids = candidates.map((c) => c.id);
      const placeholders = ids.map(() => "?").join(",");

      // 原子 UPDATE 把 PENDING → PROCESSING
      await prisma.$executeRawUnsafe(
        `UPDATE SessionRegistry
         SET status = 'PROCESSING', updated_at = ?
         WHERE id IN (${placeholders}) AND status = 'PENDING'`,
        new Date().toISOString(),
        ...ids
      );

      // 再 SELECT 拿完整 payload
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string;
        session_uid: string;
        agent_id: string;
        source: string;
        source_id: string;
        title: string | null;
        started_at: string | null;
        ended_at: string | null;
        last_message_at: string | null;
        message_count: number;
        raw_payload: string | null;
        payload_size: number;
        status: string;
        uploaded_at: string;
      }>>(
        `SELECT id, session_uid, agent_id, source, source_id, title,
                started_at, ended_at, last_message_at, message_count,
                raw_payload, payload_size, status, uploaded_at
         FROM SessionRegistry
         WHERE id IN (${placeholders})`,
        ...ids
      );

      // 解析 raw_payload JSON
      const claimed = rows.map((r) => ({
        ...r,
        message_count: Number(r.message_count),
        payload_size: Number(r.payload_size),
        raw_payload_parsed: r.raw_payload ? JSON.parse(r.raw_payload) : null,
      }));

      return { claimed, count: claimed.length };
    }),

  /**
   * session.update - Pipeline worker 处理完后, 更新 session 状态
   *
   * 入参:
   *   - session_uid: 要更新的 session
   *   - status: PROCESSED | FAILED | SKIPPED
   *   - error?: 失败原因
   */
  update: protectedProcedure
    .input(
      z.preprocess(
        (val: any) => {
          if (val && typeof val === "object" && "json" in val && typeof val.json === "object") {
            return val.json;
          }
          return val;
        },
        z.object({
          session_uid: z.string(),
          status: z.enum(["PROCESSED", "FAILED", "SKIPPED"]),
          error: z.string().optional(),
        })
      )
    )
    .mutation(async ({ input }) => {
      const now = new Date().toISOString();
      const result = await prisma.$executeRawUnsafe(
        `UPDATE SessionRegistry
         SET status = ?, processed_at = ?, processing_error = ?, updated_at = ?
         WHERE session_uid = ?`,
        input.status,
        input.status === "PROCESSED" || input.status === "FAILED" ? now : null,
        input.error ?? null,
        now,
        input.session_uid
      );
      return { updated: result };
    }),

  /**
   * session.stats - 状态分布 + 各 agent / source 维度
   */
  stats: publicProcedure.query(async () => {
    // 总览
    const totalRow = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
      `SELECT COUNT(*) as cnt FROM SessionRegistry`
    );
    const total = Number(totalRow[0]?.cnt ?? 0);

    // 按 status
    const statusRows = await prisma.$queryRawUnsafe<Array<{ status: string; cnt: number }>>(
      `SELECT status, COUNT(*) as cnt FROM SessionRegistry GROUP BY status`
    );
    const byStatus: Record<string, number> = {};
    statusRows.forEach((r) => {
      byStatus[r.status] = Number(r.cnt);
    });

    // 按 source
    const sourceRows = await prisma.$queryRawUnsafe<Array<{ source: string; cnt: number }>>(
      `SELECT source, COUNT(*) as cnt FROM SessionRegistry GROUP BY source`
    );
    const bySource: Record<string, number> = {};
    sourceRows.forEach((r) => {
      bySource[r.source] = Number(r.cnt);
    });

    // 按 agent
    const agentRows = await prisma.$queryRawUnsafe<Array<{ agent_id: string; cnt: number }>>(
      `SELECT agent_id, COUNT(*) as cnt FROM SessionRegistry GROUP BY agent_id ORDER BY cnt DESC`
    );

    // 24h 内 pending 数 (待处理)
    const pendingRow = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
      `SELECT COUNT(*) as cnt FROM SessionRegistry
       WHERE status = 'PENDING' AND uploaded_at >= datetime('now', '-24 hours')`
    );
    const pending24h = Number(pendingRow[0]?.cnt ?? 0);

    // 总 payload 体积 (KB)
    const sizeRow = await prisma.$queryRawUnsafe<Array<{ total_size: number | null }>>(
      `SELECT SUM(payload_size) as total_size FROM SessionRegistry`
    );
    const totalSizeKb = Math.round(Number(sizeRow[0]?.total_size ?? 0) / 1024);

    return {
      total,
      byStatus,
      bySource,
      byAgent: agentRows.map((r) => ({ agent_id: r.agent_id, count: Number(r.cnt) })),
      pending24h,
      totalSizeKb,
    };
  }),

  /**
   * session.get - 查单个 session 详情 (含 raw_payload, 给 pipeline 调试用)
   */
  get: publicProcedure
    .input(
      z.preprocess(
        (val: any) => {
          if (val && typeof val === "object" && "json" in val && typeof val.json === "object") {
            return val.json;
          }
          return val;
        },
        z.object({ session_uid: z.string() })
      )
    )
    .query(async ({ input }) => {
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string;
        session_uid: string;
        agent_id: string;
        source: string;
        source_id: string;
        title: string | null;
        started_at: string | null;
        ended_at: string | null;
        last_message_at: string | null;
        message_count: number;
        status: string;
        processed_at: string | null;
        processing_error: string | null;
        fingerprint: string;
        raw_payload: string | null;
        payload_size: number;
        uploaded_at: string;
        updated_at: string;
      }>>(
        `SELECT * FROM SessionRegistry WHERE session_uid = ?`,
        input.session_uid
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        ...r,
        message_count: Number(r.message_count),
        payload_size: Number(r.payload_size),
        raw_payload_parsed: r.raw_payload ? JSON.parse(r.raw_payload) : null,
      };
    }),

  // P4 NEW (2026-06-17) - 从 SessionRegistry 拉 PENDING 走 pipeline 处理
  //   等价于 pipeline.handleRegistryClaim, 放这里是因为 session-registry.ts 的 SWC 解析没问题
  //   入参 (可选) - limit 1-50, dryRun bool
  //   出参 - claimed, processed, failed, skipped, results 数组
  processPipeline: publicProcedure
    .input(
      z.preprocess(
        (val: any) => {
          if (val && typeof val === "object" && "json" in val && typeof val.json === "object") {
            return val.json;
          }
          return val;
        },
        z.object({
          limit: z.number().int().min(1).max(50).default(5),
          dryRun: z.boolean().default(false),
          agentId: z.string().optional(),
          source: z.string().optional(),
        }).optional()
      )
    )
    .mutation(async ({ input, ctx }) => {
      const { processViaLionsSession } = await import(
        "@/server/pipeline/session-source-loader"
      );
      const apiKeyForLog = ctx.headers.get("x-api-key") || "unknown";
      console.log(
        `[sessionRegistry.processPipeline] trigger by ${apiKeyForLog.substring(0, 12)}..., limit=${input?.limit ?? 5}, agentId=${input?.agentId ?? "all"}`
      );
      return await processViaLionsSession({
        limit: input?.limit ?? 5,
        dryRun: input?.dryRun ?? false,
        agentId: input?.agentId,
        source: input?.source,
      });
    }),

  // P4 NEW (2026-06-17) - 调试用, 只看 PENDING 列表, 不标记 PROCESSING
  peekPending: publicProcedure
    .input(
      z.preprocess(
        (val: any) => {
          if (val && typeof val === "object" && "json" in val && typeof val.json === "object") {
            return val.json;
          }
          return val;
        },
        z.object({
          limit: z.number().int().min(1).max(50).default(10),
        }).optional()
      )
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 10;
      const rows = await prisma.$queryRawUnsafe<Array<{
        session_uid: string;
        agent_id: string;
        source: string;
        source_id: string;
        title: string | null;
        message_count: number;
        status: string;
        uploaded_at: string;
      }>>(
        `SELECT session_uid, agent_id, source, source_id, title,
                message_count, status, uploaded_at
         FROM SessionRegistry
         WHERE status = 'PENDING'
         ORDER BY uploaded_at ASC
         LIMIT ?`,
        limit
      );
      return { peek: rows, count: rows.length };
    }),

  // ==========================================================================
  // P5 NEW (2026-06-17): byAgent — agent 维度聚合 (返回 AgentRegistry × SessionRegistry 聚合)
  // 用于首页卡片视图: 列出全部已接入 agent + 每个 agent 的 session 统计
  // ==========================================================================
  byAgent: publicProcedure.query(async () => {
    // 1. 拉全部已接入 agent (AgentRegistry, 按 channel 排序)
    const agents = await prisma.$queryRawUnsafe<Array<{
      agent_id: string;
      display_name: string;
      channel: string;
      host: string;
      avatar: string | null;
      status: string;
      last_seen_at: string | null;
      created_at: string;
    }>>(
      `SELECT agent_id, display_name, channel, host, avatar, status, last_seen_at, created_at
       FROM AgentRegistry ORDER BY status DESC, channel ASC, display_name ASC`
    );

    // 2. 每个 agent 的 session 聚合
    const sessionAgg = await prisma.$queryRawUnsafe<Array<{
      agent_id: string;
      total: bigint | number;
      pending: bigint | number;
      processing: bigint | number;
      processed: bigint | number;
      failed: bigint | number;
      skipped: bigint | number;
      active: bigint | number;  // B21: 活动中 session (last_message_at 30min 内)
      total_size: bigint | number;
      pending_size: bigint | number;
      last_activity: string | null;
    }>>(
      `SELECT
         agent_id,
         COUNT(*) AS total,
         SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status='PROCESSING' THEN 1 ELSE 0 END) AS processing,
         SUM(CASE WHEN status='PROCESSED' THEN 1 ELSE 0 END) AS processed,
         SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='SKIPPED' THEN 1 ELSE 0 END) AS skipped,
         -- B21: 活动中 session = last_message_at 在 30 分钟内
         SUM(CASE WHEN datetime(last_message_at) > datetime('now', '-30 minutes') THEN 1 ELSE 0 END) AS active,
         SUM(payload_size) AS total_size,
         SUM(CASE WHEN status='PENDING' THEN payload_size ELSE 0 END) AS pending_size,
         MAX(last_message_at) AS last_activity
       FROM SessionRegistry
       GROUP BY agent_id`
    );
    const aggMap = new Map(sessionAgg.map(s => [s.agent_id, s]));

    // 3. 合并
    const cards = agents.map(a => {
      const agg = aggMap.get(a.agent_id);
      return {
        agent_id: a.agent_id,
        display_name: a.display_name,
        channel: a.channel,
        host: a.host,
        avatar: a.avatar,
        agent_status: a.status,
        last_seen_at: a.last_seen_at,
        created_at: a.created_at,
        // session 统计 (没 session 的 agent 也显示)
        total_sessions: Number(agg?.total ?? 0),
        pending: Number(agg?.pending ?? 0),
        processing: Number(agg?.processing ?? 0),
        processed: Number(agg?.processed ?? 0),
        failed: Number(agg?.failed ?? 0),
        skipped: Number(agg?.skipped ?? 0),
        // B21: 活动 session 数 (last_message_at 30min 内)
        active_sessions: Number(agg?.active ?? 0),
        total_size_kb: Math.round((Number(agg?.total_size ?? 0) / 1024) * 10) / 10,
        pending_size_kb: Math.round((Number(agg?.pending_size ?? 0) / 1024) * 10) / 10,
        last_activity: agg?.last_activity ?? null,
      };
    });
    return { agents: cards, count: cards.length };
  }),

  // ==========================================================================
  // P5 NEW: retry — 把 FAILED 改回 PENDING, 让 pipeline 重新处理
  // ==========================================================================
  retry: protectedProcedure
    .input(z.preprocess(
      (val) => val && typeof val === "object" && "json" in val ? (val as any).json : val,
      z.object({
        session_uid: z.string().optional(),
        agent_id: z.string().optional(),
      })
    ))
    .mutation(async ({ input }) => {
      const { session_uid, agent_id } = input;
      if (!session_uid && !agent_id) {
        throw new Error("Provide session_uid or agent_id");
      }
      let updated = 0;
      if (session_uid) {
        const r = await prisma.$executeRawUnsafe(
          `UPDATE SessionRegistry
           SET status='PENDING', processing_error=NULL, processed_at=NULL, updated_at=?
           WHERE session_uid=? AND status='FAILED'`,
          new Date().toISOString(), session_uid
        );
        updated = Number(r);
      } else if (agent_id) {
        const r = await prisma.$executeRawUnsafe(
          `UPDATE SessionRegistry
           SET status='PENDING', processing_error=NULL, processed_at=NULL, updated_at=?
           WHERE agent_id=? AND status='FAILED'`,
          new Date().toISOString(), agent_id
        );
        updated = Number(r);
      }
      return { ok: true, updated };
    }),

  // ==========================================================================
  // P5 NEW: trends — 30 天数据趋势 (按天统计 upload / processed / failed)
  // ==========================================================================
  trends: publicProcedure
    .input(z.preprocess(
      (val) => val && typeof val === "object" && "json" in val ? (val as any).json : val,
      z.object({ days: z.number().min(1).max(90).default(30) }).optional()
    ))
    .query(async ({ input }) => {
      const days = input?.days ?? 30;
      const rows = await prisma.$queryRawUnsafe<Array<{
        day: string;
        uploaded: bigint | number;
        processed: bigint | number;
        failed: bigint | number;
      }>>(
        `SELECT
           DATE(uploaded_at) AS day,
           COUNT(*) AS uploaded,
           SUM(CASE WHEN status='PROCESSED' THEN 1 ELSE 0 END) AS processed,
           SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed
         FROM SessionRegistry
         WHERE uploaded_at >= datetime('now', '-' || ? || ' days')
         GROUP BY DATE(uploaded_at)
         ORDER BY day ASC`,
        days
      );
      return {
        days,
        trends: rows.map(r => ({
          day: r.day,
          uploaded: Number(r.uploaded),
          processed: Number(r.processed),
          failed: Number(r.failed),
        })),
      };
    }),

  // ==========================================================================
  // 2026-06-18 NEW: bulkUpload — 远端 agent (agent-x/13) 通过 uploader client 推 session
  // 用途: bulkSyncFromLocal 只能扫本机磁盘, 远端机器的 session 走这个端点 push
  // 入参: { agent_id, sessions: [{source, source_id, title?, started_at?, ended_at?,
  //         last_message_at?, message_count?, raw_messages?: [...] }], dry_run?: boolean }
  // 限制: 单次最多 500 条
  // 行为: fingerprint 去重, 已存在则 update, 不存在则 INSERT (status=PENDING)
  // 返: { ok, total, inserted, updated, errors: [...] }
  //
  // 2026-07-14 P1-2 long-term fix:
  //   CLAUDE_CONVERSATION + 短 source_id (非 UUID) 必须传 raw_messages (>=2 条)
  //   否则拒收, 避免 needsRefetch 占位 row 永久积压 (process worker 无 fallback 还原)
  //   HERMES_SESSION / cron / cli / feishu 暂不限 (hermes state.db 真源可走 fallback)
  //
  // 2026-07-14 P2-4 强化 (跟 P1-2 一致):
  //   任何 source + 无 raw_messages → 拒收 (P2-4 错误)
  //   原因: uploader 已升级真读 messages (claude), HERMES 标 unavailable 后走 caller-provided
  //   如果还有 caller 推空 messages, 说明 uploader 还没升级, 应该立即拒绝并暴露错误
  //   跟 P1-2 设计哲学一致: 入口端不要轻量 row, 要真有内容
  // ==========================================================================
  bulkUpload: protectedProcedure
    .input(z.preprocess(
      (val) => val && typeof val === "object" && "json" in val ? (val as any).json : val,
      z.object({
        agent_id: z.string(),
        sessions: z.array(z.object({
          source: z.enum(["CLAUDE_CONVERSATION", "HERMES_SESSION", "OPENAI_THREAD", "CUSTOM"]),
          source_id: z.string(),
          title: z.string().nullable().optional(),
          started_at: z.string().nullable().optional(),  // ISO
          ended_at: z.string().nullable().optional(),
          last_message_at: z.string().nullable().optional(),
          message_count: z.number().int().min(0).default(0),
          // 2026-07-14 NEW: CLAUDE_CONVERSATION + 短 hash 必须传 messages
          // 若 caller 真的没原文 (hermes state.db 也查不到), 应转 SKIPPED 不上传
          raw_messages: z.array(z.object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.string(),
            timestamp: z.string().optional(),
          })).optional(),
        })).min(1).max(500),
        dry_run: z.boolean().default(false),
      })
    ))
    .mutation(async ({ input }) => {
      const { agent_id, sessions, dry_run } = input;
      const errors: Array<{ source_id: string; error: string }> = [];
      let inserted = 0;
      let updated = 0;
      let rejected = 0;

      // 2026-07-14 P1-2 入口校验
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (dry_run) {
        // 只算 fingerprint 看冲突, 不写
        let wouldInsert = 0, wouldUpdate = 0;
        for (const s of sessions) {
          const fp = sha256(`${agent_id}|${s.source}|${s.source_id}`);
          const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM SessionRegistry WHERE fingerprint=?`, fp
          );
          if (existing.length > 0) wouldUpdate++; else wouldInsert++;
        }
        return { ok: true, total: sessions.length, inserted: 0, updated: 0,
                 dry_run: true, would_insert: wouldInsert, would_update: wouldUpdate,
                 rejected: 0, errors: [] };
      }

      for (const s of sessions) {
        try {
          // 入口校验: CLAUDE_CONVERSATION + 短 source_id 必须 raw_messages
          if (s.source === "CLAUDE_CONVERSATION"
              && !UUID_RE.test(s.source_id)
              && (!s.raw_messages || s.raw_messages.length < 2)) {
            errors.push({
              source_id: s.source_id,
              error: "P1-2 fix: CLAUDE_CONVERSATION requires UUID source_id OR raw_messages (>=2). Short-hash placeholder without messages is rejected to prevent 12d deadlock.",
            });
            rejected++;
            continue;
          }

          // P2-4 强化: 任何 source + 无 raw_messages 都拒收 (跟 P1-2 一致的设计哲学)
          // 之前 HERMES_SESSION 无 raw_messages 走 needsRefetch 占位, fallback 找 hermes state.db
          // 失败率 ~30% (state.db 损坏/lazy header), 形成永久 FAILED 占位 row
          // uploader 升级后: claude 真读 messages 推; hermes 标 unavailable 走 caller-provided
          // 推空 messages = uploader 没升级, 立即暴露错误而不是默默进入 PENDING
          if (!s.raw_messages || s.raw_messages.length < 1) {
            errors.push({
              source_id: s.source_id,
              error: "P2-4 fix: all sources require raw_messages (>=1). Empty-messages placeholder is rejected to prevent permanent FAILED rows. Uploader needs to be upgraded to read messages from local source.",
            });
            rejected++;
            continue;
          }

          const fingerprint = sha256(`${agent_id}|${s.source}|${s.source_id}`);
          const session_uid = buildSessionUid(agent_id, s.source, s.source_id);
          const startIso = s.started_at ?? new Date().toISOString();
          const endIso = s.ended_at ?? null;
          const lastIso = s.last_message_at ?? startIso;

          // 2026-07-14: 优先用 caller 传的 raw_messages, 退路到 needsRefetch 占位
          let raw_payload: string;
          if (s.raw_messages && s.raw_messages.length > 0) {
            raw_payload = JSON.stringify({
              messages: s.raw_messages,
              metadata: { uploadedBy: agent_id, source: "caller-provided" },
            });
          } else {
            raw_payload = JSON.stringify({
              messages: [],
              metadata: { uploadedBy: agent_id, needsRefetch: true, remoteUpload: true },
            });
          }
          const size = Buffer.byteLength(raw_payload, "utf8");
          // 1) 按 fingerprint 查 (主键)
          const existingByFp = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM SessionRegistry WHERE fingerprint=?`, fingerprint
          );
          // 2) 按 session_uid 查 (防御: 历史上同 source_id 可能被另一 fingerprint 推过)
          const existingByUid = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM SessionRegistry WHERE session_uid=?`, session_uid
          );
          const now = new Date().toISOString();
          if (existingByFp.length > 0) {
            // P2-4 fix: 之前 P1-2 long-term fix 只更新 5 个 metadata 字段, 不更新 raw_payload
            // 后果: 老 row 之前是 needsRefetch 占位, 这次 caller 提供了真 messages, 也不会写入
            // 修复: 同步更新 raw_payload + payload_size, 让 caller 提供的真 messages 真正入库
            // 注意: 已有 PENDING/PROCESSING 在 process queue 中, status 不动
            await prisma.$executeRawUnsafe(
              `UPDATE SessionRegistry SET title=?, message_count=?, last_message_at=?, ended_at=?,
                  raw_payload=?, payload_size=?, updated_at=?
               WHERE fingerprint=?`,
              s.title ?? null, s.message_count, lastIso, endIso,
              raw_payload, size, now, fingerprint
            );
            updated++;
          } else if (existingByUid.length > 0) {
            // session_uid 已被另一行占 (历史 fingerprint 跟新的不同)
            // 改 UPDATE 那一行: 用新 fingerprint / agent_id / source 覆盖
            // 注意: 假设新的 metadata 更准, 跟 #34 P0-A 决策一致
            const rowId = existingByUid[0].id;
            await prisma.$executeRawUnsafe(
              `UPDATE SessionRegistry
               SET fingerprint=?, agent_id=?, source=?, source_id=?, title=?,
                   started_at=?, ended_at=?, last_message_at=?, message_count=?,
                   status='PENDING', raw_payload=?, payload_size=?, updated_at=?
               WHERE id=?`,
              fingerprint, agent_id, s.source, s.source_id, s.title ?? null,
              startIso, endIso, lastIso, s.message_count,
              raw_payload, size, now, rowId
            );
            updated++;
          } else {
            await prisma.$executeRawUnsafe(
              `INSERT INTO SessionRegistry (
                id, session_uid, agent_id, source, source_id, title,
                started_at, ended_at, last_message_at, message_count, status,
                fingerprint, raw_payload, payload_size, uploaded_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              genCuid(),
              session_uid, agent_id, s.source, s.source_id, s.title ?? null,
              startIso, endIso, lastIso,
              s.message_count, "PENDING",
              fingerprint, raw_payload, size, now, now
            );
            inserted++;
          }
        } catch (e: any) {
          errors.push({ source_id: s.source_id, error: String(e?.message ?? e).slice(0, 200) });
        }
      }

      return { ok: true, total: sessions.length, inserted, updated, rejected, errors };
    }),

  // ==========================================================================
  // P5 NEW: bulkSyncFromLocal — 一键把本地 claude/hermes 历史 session 全量 push
  // 用于 agent 接入前的存量数据同步
  // ==========================================================================
  bulkSyncFromLocal: protectedProcedure
    .input(z.preprocess(
      (val) => val && typeof val === "object" && "json" in val ? (val as any).json : val,
      z.object({
        agent_id: z.string(),
        source: z.enum(["CLAUDE_CONVERSATION", "HERMES_SESSION"]),
        // 2026-06-18: hermes 1442 条要 2000 上限
        limit: z.number().min(1).max(2000).default(100),
      })
    ))
    .mutation(async ({ input }) => {
      const { agent_id, source, limit } = input;

      // ─── HERMES_SESSION 分支 ──────────────────────────────────────────
      if (source === "HERMES_SESSION") {
        const { scanHermesSessions } = await import("../pipeline/hermes-session-scanner");
        const scanned = await scanHermesSessions();
        // 用 allSessions (不只是 newSessions), 因为我们要的是"全量同步存量"
        const sessions = scanned.allSessions.slice(0, limit);
        let inserted = 0;
        let updated = 0;
        for (const s of sessions) {
          const fingerprint = crypto.createHash("sha256")
            .update(`${agent_id}|${source}|${s.id}`).digest("hex");
          const session_uid = `${agent_id}:${source.toLowerCase()}:${s.id}`;
          const startIso = (s.startedAt as any) instanceof Date ? (s.startedAt as Date).toISOString() : new Date(s.startedAt as any).toISOString();
          const endIso = s.endedAt ? ((s.endedAt as any) instanceof Date ? (s.endedAt as Date).toISOString() : new Date(s.endedAt as any).toISOString()) : null;
          const lastIso = s.lastMessageAt ? ((s.lastMessageAt as any) instanceof Date ? (s.lastMessageAt as Date).toISOString() : new Date(s.lastMessageAt as any).toISOString()) : startIso;
          // raw_payload 不放 messages 内容 (hermes session 可能很大), 标记 needsRefetch
          const raw_payload = JSON.stringify({
            messages: [],
            metadata: { hermesSource: s.source, needsRefetch: true },
          });
          const size = Buffer.byteLength(raw_payload, "utf8");
          const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM SessionRegistry WHERE fingerprint=?`, fingerprint
          );
          const now = new Date().toISOString();
          if (existing.length > 0) {
            await prisma.$executeRawUnsafe(
              `UPDATE SessionRegistry SET title=?, message_count=?, last_message_at=?, ended_at=?, updated_at=?
               WHERE fingerprint=?`,
              s.title ?? null, s.messageCount, lastIso, endIso, now, fingerprint
            );
            updated++;
          } else {
            await prisma.$executeRawUnsafe(
              `INSERT INTO SessionRegistry (
                id, session_uid, agent_id, source, source_id, title,
                started_at, ended_at, last_message_at, message_count, status,
                fingerprint, raw_payload, payload_size, uploaded_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              `cuid_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,
              session_uid, agent_id, source, s.id, s.title ?? null,
              startIso, endIso, lastIso,
              s.messageCount, "PENDING",
              fingerprint, raw_payload, size, now, now
            );
            inserted++;
          }
        }
        return { ok: true, scanned: sessions.length, inserted, updated, errors: scanned.errors.slice(0, 10) };
      }

      // ─── CLAUDE_CONVERSATION 分支 (原有逻辑) ──────────────────────────
      const { scanAllConversations, scanSessionService } = await import("../pipeline/conversation-scanner");
      const claudeScanned = scanAllConversations();
      const sessionServiceConvs = await scanSessionService();
      const allConvs = [...sessionServiceConvs, ...claudeScanned.newConversations];
      const seen = new Set<string>();
      const deduped = allConvs.filter((c) => {
        if (seen.has(c.sessionId)) return false;
        seen.add(c.sessionId);
        return true;
      });
      const convs = deduped.slice(0, limit);
      let inserted = 0;
      let updated = 0;
      for (const c of convs) {
        const fingerprint = crypto.createHash("sha256")
          .update(`${agent_id}|${source}|${c.sessionId}`).digest("hex");
        const session_uid = `${agent_id}:${source.toLowerCase()}:${c.sessionId}`;
        // 安全转日期 (scanner 可能返 Date 或 string)
        const startIso = c.startTime
          ? ((c.startTime as any) instanceof Date ? (c.startTime as unknown as Date).toISOString() : new Date(c.startTime as any).toISOString())
          : null;
        // raw_payload 不放具体 messages (太大), 标记 needsRefetch
        const raw_payload = JSON.stringify({
          messages: [],
          metadata: { projectName: c.projectName, filePath: (c as any).filePath, needsRefetch: true },
        });
        const size = Buffer.byteLength(raw_payload, "utf8");
        // upsert
        const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM SessionRegistry WHERE fingerprint=?`, fingerprint
        );
        const now = new Date().toISOString();
        if (existing.length > 0) {
          await prisma.$executeRawUnsafe(
            `UPDATE SessionRegistry SET title=?, message_count=?, last_message_at=?, updated_at=?
             WHERE fingerprint=?`,
            c.title ?? null, c.messageCount, startIso, now, fingerprint
          );
          updated++;
        } else {
          await prisma.$executeRawUnsafe(
            `INSERT INTO SessionRegistry (
              id, session_uid, agent_id, source, source_id, title,
              started_at, last_message_at, message_count, status,
              fingerprint, raw_payload, payload_size, uploaded_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            `cuid_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,
            session_uid, agent_id, source, c.sessionId, c.title ?? null,
            startIso, startIso,
            c.messageCount, "PENDING",
            fingerprint, raw_payload, size, now, now
          );
          inserted++;
        }
      }
      return { ok: true, scanned: convs.length, inserted, updated };
    }),

  /**
   * V1 §18.7 Session 同步延迟 SLO
   * 公式: last_message_at → uploaded_at (session 最新活动到落库的 pipeline 延迟)
   * 窗口: 仅 24h 内 uploaded (历史回灌自动排除)
   * 阈值 (基于 p99,与 docs §837 告警线 'sync lag > 60min' 对齐):
   *   <60s ok / <300s(5min) warning / <3600s(60min) warning / >=3600s critical
   *   target: p99 < 60s
   * 异常过滤: lag<0 (时钟漂移) / lag>86400s (脏数据) / last_message_at<2020 (epoch bug)
   */
  syncLagStats: publicProcedure.query(async () => {
    // 注: SQLite 存的是 ISO 字符串 (e.g. "2026-06-26T08:33:57.814Z"),Prisma $queryRaw
    // 传 JS Date 会被序列化成 Date object,与 TEXT 字段字符串比较失效 → 必须传 ISO 字符串
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const epochCutoff = "2020-01-01T00:00:00.000Z";

    // 拿 24h 内 uploaded 的有效样本 (用 raw SQL 计算 lag,过滤异常)
    type Row = { lag_s: number };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT CAST((julianday(uploaded_at) - julianday(last_message_at)) * 86400 AS REAL) AS lag_s
      FROM SessionRegistry
      WHERE last_message_at IS NOT NULL
        AND uploaded_at >= ${since24h}
        AND last_message_at >= ${epochCutoff}
        AND (julianday(uploaded_at) - julianday(last_message_at)) * 86400 BETWEEN 0 AND 86400
      ORDER BY lag_s ASC
    `;

    // 24h 总样本 (含异常,用于计算 outlier 率)
    const totalRows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*) AS n FROM SessionRegistry
      WHERE last_message_at IS NOT NULL AND uploaded_at >= ${since24h}
    `;
    const total_24h = Number(totalRows[0]?.n ?? 0);
    const valid_n = rows.length;
    const outlier_24h = total_24h - valid_n;

    // 计算分位数 (rows 已按 lag_s 升序)
    const pct = (p: number) => {
      if (valid_n === 0) return 0;
      const idx = Math.min(valid_n - 1, Math.floor((valid_n - 1) * p));
      return Math.round(rows[idx]!.lag_s);
    };
    const p50 = pct(0.5);
    const p99 = pct(0.99);
    const max_lag = valid_n > 0 ? Math.round(rows[valid_n - 1]!.lag_s) : 0;

    // SLO: 按 p99 评级 (与 docs §837 告警线 60min 对齐)
    const level: "ok" | "warning" | "critical" =
      valid_n === 0
        ? "ok"
        : p99 < 60
          ? "ok"
          : p99 < 3600
            ? "warning"
            : "critical";

    return {
      window: "24h",
      total_24h,
      valid_n,
      outlier_24h,
      p50_lag_s: p50,
      p99_lag_s: p99,
      max_lag_s: max_lag,
      slo: {
        level,
        threshold_target_s: 60,
        threshold_warning_s: 300,
        threshold_critical_s: 3600,
        target: "p99_lag_s < 60s",
      },
      formula: "uploaded_at - last_message_at",
      timestamp: new Date().toISOString(),
    };
  }),
});