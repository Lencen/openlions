import { initTRPC } from "@trpc/server";
import { prisma } from "@/lib/prisma";

export const createTRPCContext = async () => {
  return { prisma };
};

type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create();

export const createRouter = t.router;
export const publicProcedure = t.procedure;
