import { createRouter } from "../trpc";
import { taskRouter } from "../routers/task";
import { reviewRouter } from "../routers/review";
import { problemRouter } from "../routers/problem";
import { dashboardRouter } from "../routers/dashboard";
import { schedulerEventRouter } from "../routers/scheduler-event";
import { auditRouter } from "../routers/audit";
import { mindSyncRouter } from "../routers/mind-sync";
import { healthRouter } from "../routers/health";
import { reflectionRouter } from "../routers/reflection";

export const appRouter = createRouter({
  task: taskRouter,
  review: reviewRouter,
  problem: problemRouter,
  dashboard: dashboardRouter,
  schedulerEvent: schedulerEventRouter,
  audit: auditRouter,
  "mind-sync": mindSyncRouter,
  health: healthRouter,
  reflection: reflectionRouter,
});

export type AppRouter = typeof appRouter;