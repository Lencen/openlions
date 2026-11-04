import fs from "node:fs";
import path from "node:path";

/**
 * 2026-10-21 MACS 管理端写操作的服务端通道（console BFF 专用）。
 *
 * 铁律（来自交接文档）：
 *   · admin key 只放服务端，**绝不下发浏览器**；
 *   · retry 只对 pending/expired/failed 开放（delivered/read 会被 MACS 返回 409）；
 *   · assign 必须带 note，属于 admin 动作，要留审计。
 *
 * 这里的 key 从 packages/apps/mcp-agent-chat-server/.macs.env 读取（600），不写进任何前端产物。
 */
const REPO = process.cwd();
const ENV_FILE = process.env.MACS_ENV_FILE || path.join(REPO, "packages/apps/mcp-agent-chat-server/.macs.env");
const LOG_DIR = process.env.LIONS_HOME ? path.join(process.env.LIONS_HOME, "logs") : path.join(REPO, "logs");

export function macsAdminKey(): string {
  try {
    const raw = fs.readFileSync(ENV_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*HERMES_MCP_API_KEY\s*=\s*(.*)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return process.env.HERMES_MCP_API_KEY || "";
}

export const MACS_BASE = process.env.MACS_BASE_URL || "http://127.0.0.1:8765";

export async function macsAdminFetch(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const key = macsAdminKey();
  if (!key) return { status: 503, body: { error: "MACS admin key 未配置" } };
  const r = await fetch(MACS_BASE + pathname, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": key, ...(init?.headers || {}) },
    cache: "no-store",
  });
  let body: any = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

/** 写操作审计：谁（来源）、对哪条消息、做了什么、结果如何（追加 JSONL，便于事后回溯） */
export function auditMacsWrite(entry: Record<string, any>): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), source: "console/admin-bff", ...entry }) + "\n";
    fs.appendFileSync(path.join(LOG_DIR, "macs-admin-audit.jsonl"), line);
  } catch {}
}
