/**
 * lions-root.ts — 解析 LIONS 代码根（安装根下的 current，或仓库根）。
 *
 * 产品化 S0-1（2026-10-15）：运行期去硬编码后，路径默认值需要"仓库根 + 相对路径"。
 * 优先级：LIONS_REPO（安装器写入 = <home>/current）→ LIONS_HOME → 从 cwd/__dirname 向上
 *   找到含 pnpm-workspace.yaml 或 docs/architecture/adr 的目录 → 最后退回 cwd。
 *
 * 为什么向上找：测试/脚本常以 app 目录为 cwd 运行（如 cd packages/apps/mind），
 *   而旧的绝对兜底路径已按产品化要求移除。
 */
import fs from "node:fs";
import path from "node:path";

export function resolveLionsRoot(): string {
  const env = process.env.LIONS_REPO || process.env.LIONS_HOME;
  if (env && env.trim()) return env.trim();
  const markers = ["pnpm-workspace.yaml", path.join("docs", "architecture", "adr")];
  const tryWalk = (start: string): string | null => {
    let d = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      for (const m of markers) {
        try { if (fs.existsSync(path.join(d, m))) return d; } catch (_e) { /* ignore */ }
      }
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return null;
  };
  return tryWalk(process.cwd()) || tryWalk(__dirname) || process.cwd();
}
