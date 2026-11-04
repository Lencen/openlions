/**
 * model-config.ts — 模型配置的纯逻辑（读/掩码/合并），供 console API 与自测复用。
 * 契约见 docs/productization/MODEL-CONFIG.md；键名与代码读取点保持一致。
 */
import fs from "fs";
import path from "path";

export const MODEL_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "MINIMAX_API_KEY",
  "REFLECT_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

export type ModelConfigMap = Record<string, string>;

export function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "…" + value.slice(-4);
}

export function parseEnvText(text: string): ModelConfigMap {
  const out: ModelConfigMap = {};
  for (const raw of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function mergeEnvText(text: string, updates: ModelConfigMap): string {
  const seen = new Set<string>();
  const merged = text.split("\n").map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      return m[1] + "=" + updates[m[1]];
    }
    return line;
  });
  for (const key of Object.keys(updates)) if (!seen.has(key)) merged.push(key + "=" + updates[key]);
  return merged.join("\n").replace(/\n*$/, "\n");
}

/** 从当前工作目录向上探测仓库/安装根（不依赖 LIONS_HOME，dev 与安装两种布局都对）。 */
export function findRepoRoot(start?: string): string {
  let dir = start || process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "packages", "apps", "mind", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = process.env.LIONS_HOME || "";
  const installed = home ? path.join(home, "current") : "";
  if (installed && fs.existsSync(path.join(installed, "packages", "apps", "mind"))) return installed;
  return process.cwd();
}

export function modelEnvFiles(start?: string): ModelConfigMap {
  const root = findRepoRoot(start);
  return {
    mind: path.join(root, "packages", "apps", "mind", ".env"),
    selfimproving: path.join(root, "packages", "apps", "selfimproving", ".env"),
  };
}
