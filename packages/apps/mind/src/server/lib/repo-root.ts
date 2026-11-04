import fs from "fs";
import path from "path";

/**
 * repo-root.ts — 仓库根解析（单一来源，2026-10-23）
 *
 * 背景：lions-mind 服务以 WorkingDirectory 非仓库根启动（实际 systemd 报 "!~"），
 *   于是任何 process.cwd() 锚定的路径都会指错地方：
 *   - evidence-anchor 的"文件/commit 存在性"恒为 0 → 327/24h 误拒结单；
 *   - store-task-output 的产出落盘目录跑到 cwd/logs/task-output（甚至写不进去）。
 * 解析顺序：LIONS_REPO/LIONS_HOME（必须含 .git）→ 从 cwd 向上找 .git → 常见路径兜底。
 */
export function resolveRepoRoot(): string {
  const env = process.env.LIONS_REPO || process.env.LIONS_HOME || process.env.LIONS_REPO_ROOT;
  if (env && fs.existsSync(path.join(env, ".git"))) return env;
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const c of ["~/lions", path.resolve(process.cwd(), "lions")]) {
    if (fs.existsSync(path.join(c, ".git"))) return c;
  }
  return process.cwd();
}
