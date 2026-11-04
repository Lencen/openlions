import { createRouter } from "./trpc";
import { statsRouter } from "./routers/stats";
import { learningRouter } from "./routers/learning";
import { memoryRouter } from "./routers/memory";
import { knowledgeRouter } from "./routers/knowledge";
import { reflectionRouter } from "./routers/reflection";
import { skillsRouter } from "./routers/skills";
import { practiceRouter } from "./routers/practice";
import { portfolioRouter } from "./routers/portfolio";
import { flywheelRouter } from "./routers/flywheel";
import { pipelineRouter } from "./routers/pipeline";
import { autoRotationRouter } from "./routers/auto-rotation";
import { knowledgeGraphRouter } from "./routers/knowledge-graph";
import { agentActivityRouter } from "./routers/agent-activity";
import { flywheelRiverRouter } from "./routers/flywheel-river";
import { reflectionConstellationRouter } from "./routers/reflection-constellation";
import { agentRouter } from "./routers/agent";
// P4 NEW (2026-06-17): Session Registry - 所有 agent 上报 session 的中枢服务
import { sessionRegistryRouter } from "./routers/session-registry";
// P0-A NEW (2026-06-26): DLQ - V1.1 §16.10/§21.4 + §18.7 SLO
import { dlqRouter } from "./routers/dlq";
import { reflectionIngestRouter } from "./routers/reflection-ingest";

export const appRouter = createRouter({
  stats: statsRouter,
  learning: learningRouter,
  memory: memoryRouter,
  knowledge: knowledgeRouter,
  reflection: reflectionRouter,
  skills: skillsRouter,
  // B5 修复 (2026-06-18 11:35): skill.list alias → skills.list
  //   命名统一: memory/knowledge/reflection/practice (单数) + skills (复数, schema 表名定)
  //   提供单数 alias 避免调用方写错 404
  skill: skillsRouter,
  practice: practiceRouter,
  portfolio: portfolioRouter,
  flywheel: flywheelRouter,
  flywheelRiver: flywheelRiverRouter,
  pipeline: pipelineRouter,
  autoRotation: autoRotationRouter,
  knowledgeGraph: knowledgeGraphRouter,
  agentActivity: agentActivityRouter,
  reflectionConstellation: reflectionConstellationRouter,
  // P3 阶段 4-6: Agent 服务注册 (2026-06-17)
  agent: agentRouter,
  // P4 NEW (2026-06-17): Session Registry 中枢
  sessionRegistry: sessionRegistryRouter,
  // P0-A NEW (2026-06-26): DLQ - V1.1 §16.10/§21.4 + §18.7 SLO
  dlq: dlqRouter,
  reflectionIngest: reflectionIngestRouter,
});

export type AppRouter = typeof appRouter;
