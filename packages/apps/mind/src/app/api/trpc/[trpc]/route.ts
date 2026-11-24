import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/root";
import { createTRPCContext } from "@/server/trpc";

if (!(globalThis as Record<string, unknown>)._autoRotationInit) {
  (globalThis as Record<string, unknown>)._autoRotationInit = true;
  import("@/server/auto-rotation").then((m) =>
    m.initAutoRotation().catch(console.error)
  );
}

if (!(globalThis as Record<string, unknown>)._todoNudgeInit) {
  (globalThis as Record<string, unknown>)._todoNudgeInit = true;
  import("@/server/pipeline/todo-nudge").then((m) => m.initTodoNudgeScheduler()).catch(console.error);
}

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: createTRPCContext,
  });

export { handler as GET, handler as POST };
