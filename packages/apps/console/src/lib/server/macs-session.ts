import fs from "node:fs";
import path from "node:path";

/**
 * 2026-10-22 MACS Session Principal 的服务端通道（console BFF 专用）。
 *
 * 铁律：session token 只在服务端（~/.config/macs/frontend-line-2.token，600），**绝不下发浏览器**。
 * 三查询（conversations / sync / overview）都经这里转发；失败时返回明确的 ok:false + reason，
 * 不允许静默 0/空数组（契约 §3 要求）。
 */
const REPO = path.resolve(process.cwd(), "../..");
const TOKEN_FILE = process.env.MACS_SESSION_TOKEN_FILE || path.join(process.env.HOME || "~", ".config/macs/frontend-line-2.token");
export const MACS_SESSION_ID = process.env.MACS_SESSION_ID || "sess_bcf382dd99b5421d";
export const MACS_AGENT_ID = process.env.MACS_AGENT_ID || "agent-d";
const BASE = process.env.MACS_BASE_URL || "http://127.0.0.1:8765";

export function sessionToken(): string {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return process.env.MACS_SESSION_TOKEN || ""; }
}

export async function sessionFetch(pathname: string): Promise<{ status: number; body: any }> {
  const t = sessionToken();
  if (!t) return { status: 503, body: { ok: false, error: "会话线凭证未配置（" + TOKEN_FILE + "）" } };
  try {
    const r = await fetch(BASE + pathname, { headers: { "x-session-token": t, accept: "application/json" }, cache: "no-store" });
    let body: any = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  } catch (e: any) {
    return { status: 502, body: { ok: false, error: "通信服务不可达：" + String(e?.message || e) } };
  }
}
