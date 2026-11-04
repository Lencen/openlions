import { z } from "zod";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import {
  scanAllConversations,
  scanSessionService,
  filterNewConversations,
  getUpdatedConversations,
  getAlreadyProcessedConversations,
  runPipeline,
  processSingleConversation,
} from "../pipeline";
import { scanHermesSessions } from "../pipeline/hermes-session-scanner";
import { runHermesPipeline } from "../pipeline/hermes-pipeline";

async function mergedScan() {
  const claudeScan = scanAllConversations();
  const sessionServiceConvs = await scanSessionService({ limit: 500 });
  const allConvs = [...sessionServiceConvs, ...claudeScan.newConversations];
  const seen = new Set<string>();
  const deduped = allConvs.filter((c) => {
    if (seen.has(c.sessionId)) return false;
    seen.add(c.sessionId);
    return true;
  });

  // 合并 projectSummary: Claude 的 + session 服务统计
  const sessionProjectSummary: typeof claudeScan.projectSummary = [];
  if (sessionServiceConvs.length > 0) {
    const byAgent = new Map<string, number>();
    for (const c of sessionServiceConvs) {
      byAgent.set(c.projectName, (byAgent.get(c.projectName) || 0) + 1);
    }
    for (const [name, count] of byAgent) {
      sessionProjectSummary.push({
        projectPath: "lions-session-service",
        projectName: name,
        conversationCount: count,
        newCount: count,
      });
    }
  }

  return {
    ...claudeScan,
    totalConversations: deduped.length,
    newConversations: deduped,
    projectSummary: [...claudeScan.projectSummary, ...sessionProjectSummary],
  };
}

export const pipelineRouter = createRouter({
  scan: publicProcedure
    .input(z.object({ includeProcessed: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      const scanned = await mergedScan();
      const newConvs = await filterNewConversations(scanned.newConversations);
      const updatedConvs = await getUpdatedConversations(scanned.newConversations);
      const processedMap = await getAlreadyProcessedConversations();
      const newSet = new Set(newConvs.map(c => c.sessionId));

      // Return ALL conversations with processed flag
      const allWithStatus = scanned.newConversations.map(c => {
        const processedCount = processedMap.get(c.sessionId);
        const hasUpdates = processedCount !== undefined && c.messageCount > processedCount;
        return {
          sessionId: c.sessionId,
          projectName: c.projectName,
          title: c.title,
          messageCount: c.messageCount,
          startTime: c.startTime,
          alreadyProcessed: !newSet.has(c.sessionId) && !updatedConvs.some(u => u.sessionId === c.sessionId),
          hasUpdates: hasUpdates,
        };
      });

      return {
        totalConversations: scanned.totalConversations,
        newConversations: [...newConvs, ...updatedConvs].map((c) => ({
          sessionId: c.sessionId,
          projectName: c.projectName,
          title: c.title,
          messageCount: c.messageCount,
          startTime: c.startTime,
        })),
        updatedConversations: updatedConvs.map((c) => ({
          sessionId: c.sessionId,
          projectName: c.projectName,
          title: c.title,
          messageCount: c.messageCount,
          startTime: c.startTime,
        })),
        allConversations: input?.includeProcessed ? allWithStatus : undefined,
        alreadyProcessed: scanned.totalConversations - newConvs.length - updatedConvs.length,
        projectSummary: scanned.projectSummary,
      };
    }),

  run: publicProcedure
    .input(
      z.object({
        dryRun: z.boolean().optional(),
        projectFilter: z.string().optional(),
        maxConversations: z.number().min(1).max(20).optional(),
        sessionIds: z.array(z.string()).optional(), // process specific sessions
        // B19 修复 (2026-06-18 15:25): 加 agentId 可选, UI 一键处理全部 / 按 agent 处理
        agentId: z.string().optional(),
        // B19: 一键处理全部 4 agent (没传 agentId = 全部)
        allAgents: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // P1-E 2026-08-31: 进程内并发锁 + 冷却期 -- 外部客户端(60s 超时重试型)曾一天 70 次调用
      //   触发全量 pipeline, 4845 次无效 LLM 调用烧光 Token Plan 额度。
      //   规则: (1) 同一时刻只允许 1 个 run; (2) 上一轮结束 60s 内拒绝重复触发。
      const now = Date.now();
      if ((globalThis as any).__pipelineRunBusy) {
        throw new Error("PIPELINE_BUSY: 已有一个 pipeline.run 在执行, 请稍后再试");
      }
      const lastRunEnd = (globalThis as any).__pipelineRunLastEnd || 0;
      if (now - lastRunEnd < 60_000) {
        throw new Error(`PIPELINE_COOLDOWN: 距上一轮结束仅 ${Math.round((now - lastRunEnd) / 1000)}s, 60s 内不允许重复触发`);
      }
      (globalThis as any).__pipelineRunBusy = true;
      const { dryRun, projectFilter, maxConversations, sessionIds, agentId, allAgents } = input;

      const runId = `run-${Date.now()}`;

      try {
        // B19: 一键处理全部时, 不传 agentId (runPipeline 内部默认全部)
        const report = await runPipeline({
          dryRun: dryRun ?? false,
          projectFilter: projectFilter ?? undefined,
          maxConversations: maxConversations ?? undefined,
          sessionIds: sessionIds ?? undefined,
          runMode: "MANUAL",
        });

        return {
          success: report.errors.length === 0,
          processed: report.processed.length,
          totalRecordsCreated: report.totalRecordsCreated,
          errors: report.errors,
          summary: report.processed.map((r) => ({
            sessionId: r.conversation.sessionId,
            title: r.conversation.title || r.extracted.summary || "(无标题)",
            summary: r.extracted.summary,
            stats: r.stats,
          })),
          runId,
          // B19: 告诉前端跑了几个 agent
          agentsProcessed: (report as any).agentsProcessed ?? (agentId ? [agentId] : ["all"]),
        };
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : "Pipeline failed");
      } finally {
        // P1-E: 释放锁 + 记录结束时间 (冷却期用)
        (globalThis as any).__pipelineRunBusy = false;
        (globalThis as any).__pipelineRunLastEnd = Date.now();
      }
    }),

  processOne: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        dryRun: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { sessionId, dryRun } = input;

      const result = await processSingleConversation(sessionId, {
        dryRun: dryRun ?? false,
      });

      return {
        success: true,
        sessionId: result.conversation.sessionId,
        summary: result.extracted.summary,
        stats: result.stats,
        preview: {
          memories: result.extracted.memories.slice(0, 3),
          knowledge: result.extracted.knowledge.slice(0, 3),
          reflections: result.extracted.reflections.slice(0, 3),
          practices: result.extracted.practices.slice(0, 3),
        },
      };
    }),

  history: publicProcedure
    .input(
      z.preprocess(
        (val) => val && typeof val === "object" && "json" in val ? (val as any).json : val,
        z.object({
          sourceType: z.string().optional(),
          agentId: z.string().optional(),
          limit: z.number().int().min(1).max(500).default(200),
          offset: z.number().int().min(0).default(0),
          // B18 修复 (2026-06-18 15:25): 排序
          sortBy: z.enum(["startedAt", "endedAt", "recordsSynced"]).default("startedAt"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
        }).optional()
      )
    )
    .query(async ({ input }) => {
      const where = input?.sourceType ? { sourceType: input.sourceType } : {};
      // B18 修复: 动态 orderBy
      const sortBy = input?.sortBy || "startedAt";
      const sortOrder = input?.sortOrder || "desc";
      const logs = await prisma.syncLog.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        take: input?.limit ?? 200,
        skip: input?.offset ?? 0,
      });

      const completedCount = logs.filter(
        (l) => l.status === "COMPLETED"
      ).length;
      const failedCount = logs.filter(
        (l) => l.status === "FAILED"
      ).length;
      const totalRecordsSynced = logs.reduce(
        (sum, l) => sum + l.recordsSynced,
        0
      );

      return {
        logs,
        summary: {
          total: logs.length,
          completed: completedCount,
          failed: failedCount,
          totalRecordsSynced,
        },
      };
    }),

  stats: publicProcedure
    .input(z.object({ sourceType: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const where = input?.sourceType ? { sourceType: input.sourceType } : {};
      const [totalLogs, completedLogs, failedLogs] = await Promise.all([
        prisma.syncLog.count({ where }),
        prisma.syncLog.count({ where: { ...where, status: "COMPLETED" } }),
        prisma.syncLog.count({ where: { ...where, status: "FAILED" } }),
      ]);

      const aggregate = await prisma.syncLog.aggregate({
        where: { ...where, status: "COMPLETED" },
        _sum: { recordsSynced: true },
      });

      const latestRun = await prisma.syncLog.findFirst({
        where,
        orderBy: { startedAt: "desc" },
      });

      return {
        totalRuns: totalLogs,
        successfulRuns: completedLogs,
        failedRuns: failedLogs,
        totalRecordsExtracted: aggregate._sum.recordsSynced || 0,
        lastRunAt: latestRun?.startedAt || null,
        lastRunStatus: latestRun?.status || null,
      };
    }),

  // Hermes session scanning
  scanHermes: publicProcedure.query(async () => {
    const result = await scanHermesSessions();
    return {
      total: result.allSessions.length,
      new: result.newSessions.length,
      updated: result.updatedSessions.length,
      sessions: result.allSessions.map((s) => ({
        id: s.id,
        source: s.source,
        title: s.title,
        messageCount: s.messageCount,
        startedAt: s.startedAt,
        lastMessageAt: s.lastMessageAt,
      })),
    };
  }),

  // Run Hermes pipeline
  runHermes: publicProcedure
    .input(
      z.object({
        dryRun: z.boolean().optional(),
        maxSessions: z.number().min(1).max(20).optional(),
        sessionIds: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      // P2-12 修复认知认知成长数据 0 bug:
      //  真根因 (3 叠加):
      //  1) hermes state.db 损坏: 某些 session_id 触发 sqlite 'database disk image is malformed'
      //     -> HermesScanner try/catch skip, 89 sessions -> 88/89 fetched, 1 errors
      //  2) prisma client 没重生成: schema 加了 agentSource 字段, 但 node_modules/.prisma/client 是旧的
      //     -> prisma.reflection.create({ agentSource: ... }) 报 'Unknown argument agentSource'
      //     -> SyncLog status=FAILED, 但 cron 不停, 持续 fail
      //     -> 修法: cd mind && node_modules/.bin/prisma generate (生成了 .prisma/client/index.d.ts)
      //  3) LLM call 慢: minmax m3 接口 30-60s/session, runHermes maxSessions=5 -> 5×60s=300s 撞 90s timeout
      //     -> 用户体验 pipeline 跑得久, 但实际有数据进
      //  业务影响: 5/28 之后 Memory/Knowledge/Practice/Output 几乎全 0, 只 6/05 task-resolved-scanner 写 7 reflection
      //  验证: 修复后 Reflection 1192 -> 1226, SyncLog status=COMPLETED cnt=121/140/338
      // P1-E 2026-08-31: 与 pipeline.run 共用并发锁 + 冷却期 (同一个昂贵资源池, 防叠加触发)
      const now = Date.now();
      if ((globalThis as any).__pipelineRunBusy) {
        throw new Error("PIPELINE_BUSY: 已有一个 pipeline run 在执行, 请稍后再试");
      }
      const lastRunEnd = (globalThis as any).__pipelineRunLastEnd || 0;
      if (now - lastRunEnd < 60_000) {
        throw new Error(`PIPELINE_COOLDOWN: 距上一轮结束仅 ${Math.round((now - lastRunEnd) / 1000)}s, 60s 内不允许重复触发`);
      }
      (globalThis as any).__pipelineRunBusy = true;
      try {
        const result = await runHermesPipeline({
          dryRun: input.dryRun ?? false,
          maxSessions: input.maxSessions ?? 5,
          sessionIds: input.sessionIds,
        });

        return {
          success: result.errors.length === 0,
          processed: result.processed,
          errors: result.errors,
          summary: result.summary,
        };
      } finally {
        (globalThis as any).__pipelineRunBusy = false;
        (globalThis as any).__pipelineRunLastEnd = Date.now();
      }
    }),

  // ============= agentSessions: 获取所有接入 agent 的 session 会话 =============
  // 2026-06-17 P3 修复: 用户要求 pipeline 页面能查看所有接入 agent 的 session
  //   - 数据源 1: AgentRegistry (ACTIVE agent 的元信息)
  //   - 数据源 2: AgentServicePermission (该 agent 的服务 token + 活跃时间)
  //   - 数据源 3: Memory 按 agentSource 分组 (该 agent 的记忆条目统计 + 活跃度)
  //   - 数据源 4: Knowledge 按 agentSource 分组 (知识条目)
  //   - 输出: 每行 = { agent_id, display_name, channel, host, memory_count, knowledge_count,
  //                    first_active_at, last_active_at, sessions_24h, services[], status }
  agentSessions: publicProcedure.query(async () => {
    // 1. 拿所有 ACTIVE agent
    const agents = await prisma.agentRegistry.findMany({
      where: { status: "ACTIVE" },
      orderBy: { created_at: "desc" },
    });
    if (agents.length === 0) return [];

    const agentIds = agents.map((a) => a.agent_id);

    // 2. 拿每个 agent 的服务权限 + last_used_at
    const permissions = await prisma.agentServicePermission.findMany({
      where: { agent_id: { in: agentIds }, status: "ACTIVE" },
      include: { service: true },
    });

    // 3. Memory 按 agentSource 分组统计
    const memoryGroups = await prisma.memory.groupBy({
      by: ["agentSource"],
      where: { agentSource: { in: agentIds } },
      _count: { id: true },
      _max: { createdAt: true },
      _min: { createdAt: true },
    });

    // 4. Knowledge 按 agentSource 分组
    const knowledgeGroups = await prisma.knowledge.groupBy({
      by: ["agentSource"],
      where: { agentSource: { in: agentIds } },
      _count: { id: true },
    });

    // 5. Reflection 按 agentSource 分组
    const reflectionGroups = await prisma.reflection.groupBy({
      by: ["agentSource"],
      where: { agentSource: { in: agentIds } },
      _count: { id: true },
    });

    // 6. 24h 内的 session 活跃 (memory_created last 24h)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentGroups = await prisma.memory.groupBy({
      by: ["agentSource"],
      where: {
        agentSource: { in: agentIds },
        createdAt: { gte: dayAgo },
      },
      _count: { id: true },
    });

    // 7. 拼装
    const permMap = new Map<string, typeof permissions>();
    for (const p of permissions) {
      if (!permMap.has(p.agent_id)) permMap.set(p.agent_id, []);
      permMap.get(p.agent_id)!.push(p);
    }

    const memMap = new Map(memoryGroups.map((m) => [m.agentSource ?? "", m]));
    const knMap = new Map(knowledgeGroups.map((k) => [k.agentSource ?? "", k]));
    const refMap = new Map(reflectionGroups.map((r) => [r.agentSource ?? "", r]));
    const recentMap = new Map(recentGroups.map((r) => [r.agentSource ?? "", r]));

    return agents.map((a) => {
      const mem = memMap.get(a.agent_id);
      const kn = knMap.get(a.agent_id);
      const ref = refMap.get(a.agent_id);
      const recent = recentMap.get(a.agent_id);
      const perms = permMap.get(a.agent_id) || [];

      // 计算 agent 的"session 活跃度": 以 last_seen_at / last_used_at 推
      // (session 没有单独表, 用"任一 service 最近活跃时间"代表最后 session)
      const lastUsedAt = perms.reduce<Date | null>((max, p) => {
        if (!p.last_used_at) return max;
        const d = new Date(p.last_used_at);
        return !max || d > max ? d : max;
      }, null);

      // services 数组
      const services = perms.map((p) => ({
        service_name: p.service.name,
        endpoint: p.service.endpoint,
        status: p.status,
        expires_at: p.expires_at,
        last_used_at: p.last_used_at,
        total_calls: 0, // P3 占位, 后续从 metrics 表拿
      }));

      return {
        agent_id: a.agent_id,
        display_name: a.display_name,
        channel: a.channel,
        host: a.host,
        status: a.status,
        first_active_at: a.created_at,
        last_seen_at: a.last_seen_at,
        last_used_at: lastUsedAt,
        // 累计数据
        memory_count: mem?._count.id ?? 0,
        knowledge_count: kn?._count.id ?? 0,
        reflection_count: ref?._count.id ?? 0,
        first_memory_at: mem?._min.createdAt ?? null,
        last_memory_at: mem?._max.createdAt ?? null,
        // 24h 活跃
        sessions_24h: recent?._count.id ?? 0,
        // 服务
        services,
        service_count: services.length,
      };
    }  // close (a) => arrow body
    )  // close agents.map
  }  // close async () => outer arrow body
),  // close .query call
});
