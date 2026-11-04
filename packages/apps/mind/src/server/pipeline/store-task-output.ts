import { createHash } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "@/server/lib/repo-root";

/**
 * TaskExecution.output 的统一落库前处理, 2026-09-15 从
 * `packages/apps/mind/src/app/api/v1/flywheel/tasks/submit/route.ts:31-47` 抽出(行为不变)。
 *
 * 为什么抽出来: 该逻辑原本只存在于 agent 提交端点。根因调查
 * (docs/platform-logic/no-execution-record-rootcause-2026-09-15.md) 发现 V1.6 cron 执行器
 * 从不写 TaskExecution, 修复时要让两条写入路径共用同一份「截断可被发现、全文可被取回」的契约,
 * 而不是各写一份 60000 字面量 —— 两份实现迟早会漂移。
 *
 * 契约(与抽取前逐字一致):
 * - ≤ MAX_STORED: 原样返回;
 * - > MAX_STORED: 前 MAX_STORED 字入库 + 尾部写入 [TRUNCATED] 标记(原文长度 + 全文路径 + sha256);
 *   全文落盘到 <仓库根>/logs/task-output/<taskId>.txt; 落盘失败也必须留标记, 不得退回静默截断。
 */
export const MAX_STORED = 60000;

export function storeTaskOutput(taskId: string, output: string): string {
  if (output.length <= MAX_STORED) return output;
  const sha = createHash("sha256").update(output).digest("hex");
  let fullPath = "(落盘失败)";
  try {
    // 2026-10-23: 用仓库根而不是 cwd（服务 cwd 不是仓库根，会把产出写到 ~/logs 下）
    const dir = path.join(resolveRepoRoot(), "logs", "task-output");
    fs.mkdirSync(dir, { recursive: true });
    fullPath = path.join(dir, taskId + ".txt");
    fs.writeFileSync(fullPath, output, "utf8");
  } catch { /* 落盘失败也要写标记 */ }
  return output.slice(0, MAX_STORED) +
    "\n\n[TRUNCATED] 原文共 " + output.length + " 字, 此处仅存前 " + MAX_STORED + " 字; 全文见 " + fullPath + " ; sha256=" + sha;
}
