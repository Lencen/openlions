// Agent 活跃度 Router — P0-23a
// 2026-06-06 SHARED-BRAIN-V2
// 来源: LIONS-MIND 端 Agent 活跃度 dashboard 后端
// 端点: agentActivity.summary() 返 3 个字段:
//   - recallByAgent: 24h FlywheelEvent 按 sourceType 分组
//   - rememberByAgent: 24h Memory 新增按 agentSource 分组
//   - hotBySource: 当前 HOT 记忆的 agentSource 分布

import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";

const AGENT_SOURCES = [
  "HERMES_AGENT",
  "CLAUDE_AGENT",
  "PIPELINE_HERMES",
  "PIPELINE_CLAUDE",
  "TASK_RESOLVED_HERMES",
  "TASK_RESOLVED_CLAUDE",
  "MIGRATION_HISTORICAL",
  "MIGRATION_DUPLICATE",
  "AUTO_ROTATION",
  "OTHER",
] as const;

type AgentSource = (typeof AGENT_SOURCES)[number];

// 把 sourceType 归类到 agentSource
function mapSourceTypeToAgentSource(sourceType: string | null | undefined): AgentSource {
  if (!sourceType) return "OTHER";
  const s = sourceType.toUpperCase();
  if (s === "HERMES_AGENT" || s === "PIPELINE_HERMES" || s === "TASK_RESOLVED_HERMES" ||
      s === "HERMES_SESSION") return "PIPELINE_HERMES"; // 旧名归并
  if (s === "CLAUDE_AGENT" || s === "PIPELINE_CLAUDE" || s === "TASK_RESOLVED_CLAUDE" ||
      s === "CLAUDE_CONVERSATION") return "PIPELINE_CLAUDE";
  if (s === "AUTO_ROTATION") return "AUTO_ROTATION";
  if (s === "MIGRATION_HISTORICAL" || s === "MIGRATION_DUPLICATE") return s as AgentSource;
  return "OTHER";
}

function emptyMap(): Record<AgentSource, number> {
  return {
    HERMES_AGENT: 0,
    CLAUDE_AGENT: 0,
    PIPELINE_HERMES: 0,
    PIPELINE_CLAUDE: 0,
    TASK_RESOLVED_HERMES: 0,
    TASK_RESOLVED_CLAUDE: 0,
    MIGRATION_HISTORICAL: 0,
    MIGRATION_DUPLICATE: 0,
    AUTO_ROTATION: 0,
    OTHER: 0,
  };
}

export const agentActivityRouter = createRouter({
  summary: publicProcedure
    .input(z.object({ hours: z.number().min(1).max(720).default(24) }).optional())
    .query(async ({ input }) => {
      const hours = input?.hours ?? 24;
      const since = new Date(Date.now() - hours * 3600 * 1000);
      const sinceMs = since.getTime();

      // 1) recallByAgent: 24h FlywheelEvent 按 sourceType 分组 (REFLECT/MEMORIZE 阶段)
      const flywheelCounts = await prisma.flywheelEvent.groupBy({
        by: ["sourceType"],
        where: {
          createdAt: { gte: since },
        },
        _count: { id: true },
      });

      const recallByAgent = emptyMap();
      for (const row of flywheelCounts) {
        const key = mapSourceTypeToAgentSource(row.sourceType);
        recallByAgent[key] = (recallByAgent[key] ?? 0) + row._count.id;
      }

      // 2) rememberByAgent: 24h Memory 新增按 agentSource 分组
      // 注: createdAt 是 DateTime, Prisma >= 比较是 ISO 字符串,
      //     对 unix 毫秒字符串要小心. 用 raw query 更稳.
      const memoryCountsRaw = await prisma.$queryRaw<Array<{ agentSource: string; count: number }>>`
        SELECT 
          COALESCE(agentSource, 'OTHER') as agentSource,
          COUNT(*) as count
        FROM Memory
        WHERE createdAt >= ${new Date(sinceMs)}
        GROUP BY agentSource
        ORDER BY count DESC
      `;

      const rememberByAgent = emptyMap();
      for (const row of memoryCountsRaw) {
        const key = (row.agentSource as AgentSource) in recallByAgent
          ? (row.agentSource as AgentSource)
          : "OTHER";
        rememberByAgent[key] = (rememberByAgent[key] ?? 0) + Number(row.count);
      }

      // 3) hotBySource: 当前 HOT 记忆 agentSource 分布
      const hotTotal = await prisma.memory.count({ where: { tier: "HOT" } });
      const hotBySourceRaw = await prisma.memory.groupBy({
        by: ["agentSource"],
        where: { tier: "HOT" },
        _count: { id: true },
      });

      const hotBySource: Record<string, { count: number; percent: number }> = {};
      for (const row of hotBySourceRaw) {
        const key = row.agentSource ?? "OTHER";
        const count = row._count.id;
        hotBySource[key] = {
          count,
          percent: hotTotal > 0 ? Math.round((count / hotTotal) * 1000) / 10 : 0,
        };
      }
      // 加 "OTHER" 兜底
      hotBySource["OTHER"] = {
        count: hotTotal - Object.values(hotBySource).reduce((a, b) => a + b.count, 0),
        percent: hotTotal > 0
          ? Math.round(((hotTotal - Object.values(hotBySource).reduce((a, b) => a + b.count, 0)) / hotTotal) * 1000) / 10
          : 0,
      };

      return {
        windowHours: hours,
        recallByAgent,
        rememberByAgent,
        hotBySource,
        hotTotal,
        recallTotal: Object.values(recallByAgent).reduce((a, b) => a + b, 0),
        rememberTotal: Object.values(rememberByAgent).reduce((a, b) => a + b, 0),
      };
    }),

  // 健康度检查: 验证数据可读
  health: publicProcedure.query(async () => {
    const [flywheelTotal, memoryTotal, hotTotal] = await Promise.all([
      prisma.flywheelEvent.count(),
      prisma.memory.count(),
      prisma.memory.count({ where: { tier: "HOT" } }),
    ]);
    return { flywheelTotal, memoryTotal, hotTotal, ok: true };
  }),
});
