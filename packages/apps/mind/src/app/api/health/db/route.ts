import { prisma, getDbConfigError } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/db — 应用侧数据库金丝雀 (2026-09-17)
 *
 * 背景(实测 2026-09-17 21:5x): mind 换库(恢复产物替换 dev.db)后进程仍握着**已删除的
 *   dev.db-wal/dev.db-shm**, 单行查询(todos/knowledge.list)照常 200, 但**聚合查询**
 *   (GROUP BY)一律 SQLITE_CORRUPT(11) "database disk image is malformed"。
 *   该错误在业务代码里被 catch 静默吞掉 -> 结构化产线"看起来正常"却永远空转
 *   (findUnstructuredThemes 的碎片统计失败 -> 永远只扫同一批 DAILY 主题)。
 *   磁盘侧 PRAGMA integrity_check 查的是文件(当时是好的), **查不到进程视图损坏**, 故补此探针。
 *
 * 语义: 200 = 应用侧读+聚合都健康; 503 = 有检查项失败(见 body.checks[].error)。
 */
export async function GET() {
  // 2026-10-27（商业化线）: 缺 DB 配置时给出**可读的 503 + 原因**，而不是让查询抛
  //   "connection refused" 那种看不出病因的错。prisma 已改为构造期不抛（见 lib/prisma.ts），
  //   原因记在 DB_CONFIG_ERROR 里；这里优先返回它。绝不静默回退 SQLite。
  const cfgErr = getDbConfigError();
  if (cfgErr) {
    return Response.json(
      { ok: false, error: "DB_CONFIG_MISSING", detail: cfgErr, checks: [], hint: "配置 MIND_DATABASE_URL 或提供 pg-password 文件后重启" },
      { status: 503 }
    );
  }
  const t0 = Date.now();
  const checks: Array<Record<string, unknown>> = [];
  let ok = true;

  const step = async (name: string, fn: () => Promise<unknown>) => {
    const s = Date.now();
    try {
      checks.push({ name, ok: true, ms: Date.now() - s, value: await fn() });
    } catch (e: any) {
      ok = false;
      checks.push({
        name, ok: false, ms: Date.now() - s,
        error: String(e?.message || e).replace(/\s+/g, " ").slice(0, 240),
      });
    }
  };

  await step("raw", async () => Number(((await prisma.$queryRaw`SELECT 1 AS x`) as any[])[0]?.x ?? 0));
  // 聚合(损坏时最先炸的一类): 按主题分组取最大桶
  await step("aggregate:memory-group-by-theme", async () => {
    const rows = await prisma.$queryRaw<Array<{ c: bigint | number }>>`
      SELECT COUNT(*) AS c FROM "Memory" GROUP BY theme ORDER BY c DESC LIMIT 1`;
    return Number(rows[0]?.c ?? 0);
  });
  await step("aggregate:structured-themes", async () => {
    const rows = await prisma.memory.groupBy({
      by: ["theme"], where: { sourceType: "FLYWHEEL_STRUCTURED" }, _count: { id: true },
    });
    return rows.length;
  });
  for (const t of ["Todo", "Task", "Memory", "Knowledge", "FlywheelReflection", "FlywheelJob"]) {
    await step(`count:${t}`, async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint | number }>>(`SELECT COUNT(*) AS c FROM "${t}"`);
      return Number(rows[0]?.c ?? 0);
    });
  }

  // 2026-10-27（平台数据线）: maxAgents 测试钩子若被误开，CRITICAL 光写日志"没人看等于没防"。
  //   这里把它变成**健康端点可见**的状态位：误开时 ok=false（503），并明确原因。
  const ackOn = process.env.LIONS_MAX_AGENTS_TEST_ACK === "1";
  const inProd = process.env.NODE_ENV === "production";
  const overrideActive = ackOn && !inProd;
  const allowInProd = process.env.LIONS_MAX_AGENTS_TEST_ALLOW_PROD === "1";
  if (ackOn && inProd && !allowInProd) {
    ok = false;
    checks.push({
      name: "max-agents-test-hook", ok: false,
      error: "生产环境检测到 LIONS_MAX_AGENTS_TEST_ACK=1 —— 测试钩子已被忽略，请立即移除该变量",
    });
  } else if (overrideActive || (ackOn && allowInProd)) {
    checks.push({
      name: "max-agents-test-hook", ok: true,
      value: "测试覆盖生效中(limit=" + String(process.env.LIONS_MAX_AGENTS_TEST_OVERRIDE || "") + ")，仅限测试环境",
    });
  }
  // 2026-10-29: **让"部署了什么版本"可直接查询**。
  //   起因：两条线都根据 `ActiveEnterTimestamp` 判断我有没有重建，而他们读到的是旧值，
  //   于是连续催办"主实例未重建"。与其让人去查 systemd，不如让服务自报：
  //   BUILD_ID + 进程启动时间，任何人一条 curl 就能确认"跑的是哪次构建"。
  let buildId = "";
  try { buildId = require("node:fs").readFileSync(require("node:path").join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim(); } catch { /* 构建目录不可读时不阻塞健康检查 */ }
  const startedAt = (() => {
    try {
      const stat = require("node:fs").readFileSync("/proc/" + process.pid + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]);
      const uptime = Number(require("node:fs").readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      const btime = Number(require("node:fs").readFileSync("/proc/stat", "utf8").split("\n").find((l: string) => l.startsWith("btime")).split(" ")[1]);
      return new Date((btime + ticks / 100) * 1000).toISOString();
    } catch { return null; }
  })();

  return Response.json({ ok, ms: Date.now() - t0, checks, buildId, startedAt, overrides: { maxAgentsTestHook: ackOn, active: overrideActive } }, { status: ok ? 200 : 503 });
}
