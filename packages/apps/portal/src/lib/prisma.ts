/**
 * ⛔ 哨兵文件 (2026-10-15 架构收口) —— 本文件**故意**在被导入时抛错。
 *
 * 这里曾经是 portal 的 Prisma 句柄: 以**读写**方式打开 mind 生产库
 * (`new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}?connection_limit=1` } } })`)。
 * 它使 `scripts/mind-db-recover.cjs` 的"除 mind 外 0 持有者"硬闸常态 exit 4, 库损坏连续数周无人能修 ——
 * 详见 scripts/DB-ACCESS-RULE.md §1/§3.1。
 *
 * 现在 portal 的两个方向都已经收口:
 *   · **读** → `src/lib/mind-read.ts`(better-sqlite3 `{ readonly: true, fileMustExist: true }`, 驱动级只读)
 *   · **写** → `src/lib/mind-client.ts`(转发 mind HTTP 接口; ingest / heartbeat / 知识读计数)
 * 于是 portal 不再需要——也不允许再有——任何读写句柄。本文件因此不再导出 `prisma`。
 *
 * 为什么写成"导入即抛错"而不是删掉: 删掉只会在旧的 `import { prisma } from "@/lib/prisma"` 处
 * 留下一个模块找不到的错误; 而这个哨兵把失败点保留在**原路径**上, 并且用一条明确的错误信息
 * 告诉下一个想恢复它的人"该往哪儿走" —— 阻止未来有人再拿它读写打开生产库、再造一个持有者。
 *
 * 撤离条件(如果要恢复文件能力): 必须先在 scripts/DB-ACCESS-RULE.md §1 里改规则, 而不是改这里。
 */

export {}; // 让本文件保持为"模块": 旧写法 `import { prisma } from "@/lib/prisma"` 会得到 tsc 编译错误

throw new Error(
  "[portal-mind-db-sentinel] portal 不得再以读写方式打开 mind 生产库(scripts/DB-ACCESS-RULE.md §1)。" +
    "读: 用 @/lib/mind-read (better-sqlite3 readonly, 驱动级只读);" +
    "写: 用 @/lib/mind-client 转发 mind HTTP 接口。",
);
