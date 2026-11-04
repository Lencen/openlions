import { PrismaClient as SqliteClient } from "@prisma/client";
import { PrismaClient as PgClient } from "../../node_modules/.prisma/selfimproving-client-pg";

// 2026-10-21 Phase 2: 按驱动选择 client（默认 SQLite；SELFIMPROVING_DB_DRIVER=pg 走 PG）。
const IS_PG_DRIVER = (process.env.SELFIMPROVING_DB_DRIVER || "").toLowerCase() === "pg";
const PrismaClient = (IS_PG_DRIVER ? PgClient : SqliteClient) as typeof SqliteClient;
type PClient = InstanceType<typeof SqliteClient>;

const globalForPrisma = globalThis as unknown as {
  prisma: PClient | undefined;
};

export const prisma: PClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error"],
    // P3 修复: 增大 transaction timeout, 解决 scheduler CREATE_TASK 5s 超时
    transactionOptions: {
      maxWait: 10000,  // 等锁最多 10s (默认 2s)
      timeout: 30000,  // 事务最多 30s (默认 5s)
    },
    ...(IS_PG_DRIVER
      ? { datasourceUrl: process.env.SELFIMPROVING_DATABASE_URL } as any
      : {}),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
