import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/trpc";

if (!(globalThis as Record<string, unknown>)._taskSchedulerInit) {
  (globalThis as Record<string, unknown>)._taskSchedulerInit = true;
  import("@/server/agents/scheduler").then((m) => {
    try { m.startTaskScheduler(); } catch (e) { console.error(e); }
    try { m.startProblemScheduler(); } catch (e) { console.error(e); }
  });
}

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: createTRPCContext,
  });

export { handler as GET, handler as POST };
