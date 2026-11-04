import fs from "fs";
import path from "path";
import { resolveRepoRoot } from "@/server/lib/repo-root";

/**
 * rejected-output.ts — 被拒提交的原文留存（2026-10-23）
 *
 * 为什么需要：证据闸门拒绝时，产出**不落库**（TaskExecution 只在成功时写），
 *   于是排查"误拒"只能靠猜。2026-10-23 的两次误拒（REPO=cwd、路径正则太窄）
 *   是靠本地复现才定位的；如果没有现场原文，这类问题会反复。
 *
 * 契约：只做旁路留存，不影响拒绝判定；写失败静默（不能因为留痕失败而放行）。
 */
export function storeRejectedOutput(input: { taskId: string; agentId: string; reason: string; output: string }): string | null {
  try {
    const dir = path.join(resolveRepoRoot(), "logs", "rejected-submissions");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = String(input.taskId).replace(/[^\w.-]/g, "_") + "-" + stamp + ".txt";
    const p = path.join(dir, name);
    const head = [
      "# taskId: " + input.taskId,
      "# agentId: " + input.agentId,
      "# reason: " + input.reason,
      "# at: " + new Date().toISOString(),
      "# length: " + input.output.length,
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(p, head + input.output, "utf8");
    return p;
  } catch {
    return null;
  }
}
