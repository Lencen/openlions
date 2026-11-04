/**
 * sqlite-tempdir.ts — SQLite 临时文件目录兜底 (2026-10-11 round 73-B)
 *
 * 为什么存在 (根因, 实测非推断):
 *   SQLite 在 temp_store=0(文件型)下, 事务内的"大"INSERT 需要为 statement journal 建临时文件。
 *   Linux 上 libsqlite3 的候选目录顺序是 SQLITE_TMPDIR -> TMPDIR -> /var/tmp -> /usr/tmp -> /tmp;
 *   平台运行时 TMPDIR 未设, 于是选中 /var/tmp。agent harness 的文件沙箱(workspace-write)允许 /tmp
 *   但拒绝 /var/tmp(EACCES) -> SQLITE_CANTOPEN(14) -> 表现为:
 *     - Prisma:  "Invalid `this.prisma.memory.create()` invocation ... unable to open database file"
 *     - better-sqlite3: "SqliteError: unable to open database file"
 *   系统 5h 定时器不在沙箱内(/var/tmp 可写) -> 绿; agent 在沙箱内跑 -> 红。同一份代码两种读数,
 *   于是两个 spec 表现为"环境性随机必红", 反复被升级成待办。
 *
 * 修法 (根因, 单一出口):
 *   在**任何 SQLite 连接建立之前**, 把 SQLITE_TMPDIR/TMPDIR 指到一个**确实可写**的目录
 *   (实际 mkdtemp 探测 —— 不是靠 access() 猜), 与 os.tmpdir() 对齐。
 *   幂等: 只在 env 未设时赋值; 已设且可写则原样尊重(不覆盖人类/部署方的显式配置)。
 *
 * 覆盖范围 (为什么放这里 + 各入口 import):
 *   - packages/apps/mind/src/lib/prisma.ts            (全 mind 应用唯一 PrismaClient)
 *   - packages/apps/mind/scripts/session-extract.ts   (better-sqlite3 直连 mind/session 库)
 *   未来任何新建的 SQLite 入口只需在最顶部 `import ".../sqlite-tempdir"` 即自动受益。
 */
import fs from "fs";
import os from "os";
import path from "path";

/** 选一个确实可写的临时目录(实际 mkdtemp 探测后返回候选本身)。 */
export function pickWritableTempDir(): string {
  const seen = new Set<string>();
  const cands = [
    process.env.SQLITE_TMPDIR,
    process.env.TMPDIR,
    os.tmpdir(),
    "/tmp",
    path.join(process.cwd(), "prisma", ".tmp"),
  ];
  for (const c of cands) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    try {
      const d = fs.mkdtempSync(path.join(c, "lions-sqlite-"));
      fs.rmdirSync(d); // 空目录, 只用于"确实能建文件"的实证
      return c;
    } catch { /* 该候选不可写, 试下一个 */ }
  }
  return os.tmpdir(); // 全不可写时退回 Node 口径(至少与 SQLite 之外的行为一致)
}

/** 幂等：把 SQLITE_TMPDIR/TMPDIR 指到确实可写的目录。返回最终使用的目录。 */
export function ensureWritableSqliteTempDir(): string {
  if (!process.env.SQLITE_TMPDIR) process.env.SQLITE_TMPDIR = pickWritableTempDir();
  if (!process.env.TMPDIR) process.env.TMPDIR = process.env.SQLITE_TMPDIR;
  return String(process.env.SQLITE_TMPDIR);
}

// 模块被 import 即执行(ES import 提升到模块体之前), 保证早于任何 new Database()/new PrismaClient()。
ensureWritableSqliteTempDir();
