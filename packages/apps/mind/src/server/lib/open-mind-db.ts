/**
 * open-mind-db.ts — SQLite 退役墓碑（2026-10-26，P3）
 *
 * 历史上这是 mind 活库(dev.db) 直连的唯一入口。2026-10-26 起 3 个 dev.db 已移到
 *   backups/legacy-sqlite/，原地只留 0 字节占位；任何 new Database() 都必然失败。
 * 本模块保留导出名（避免全仓 import 立刻炸成语法错误），但**任何调用都立即抛错**，
 *   让"还想开 SQLite"的路径 fail-loud。
 *
 * 需要读写运行期表（Todo/Discussion/AcceptanceVerdict/TodoConsumer/FindingClosure）时，
 *   用 @/server/lib/todo-repo 或 @/server/lib/runtime-repo（都是 PG）。
 */
export type MindDbRole = "owner" | "direct-rw" | "readonly";

export interface OpenMindDbOpts {
  role: MindDbRole;
  dbPath: string;
  busyTimeoutMs?: number;
  fileMustExist?: boolean;
  caller?: string;
}

export function openMindDb(_opts: OpenMindDbOpts): never {
  const err: any = new Error(
    "[sqlite-retired] SQLite 已退役（2026-10-26）：openMindDb 不再打开 dev.db。" +
    "PG 是唯一数据源；运行期表请走 todo-repo / runtime-repo。"
  );
  err.code = "SQLITE_RETIRED";
  throw err;
}
