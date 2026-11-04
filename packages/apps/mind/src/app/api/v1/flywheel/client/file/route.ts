import { readFileSync } from "fs";
import { join } from "path";

/**
 * GET /api/v1/flywheel/client/file?name=macs_responder.py — 客户端组件文件下发 (2026-09-16)
 * 白名单: 仅允许下发客户端包内组件, 防路径穿越。
 */
const CLIENT_DIR = "" + (process.env.LIONS_HOME || process.cwd()) + "/scripts/macs-responder";
const BASE_WHITELIST = ["macs_responder.py", "todo_worker.py", "lib/platform_context.py", "CLIENT_VERSION", "SOP-MCP-CHAT-SERVER.md"];

/**
 * 2026-11-02 P0: 与 version 路由同一份白名单来源 —— manifest 必需件也要能下发,
 * 否则 version 告知客户端"去拉 client-manifest.json", file 路由却 403。
 * 只接受清单里的相对 src, 拒绝绝对路径/..; 解析失败时回落到基础白名单。
 */
function allowedNames(): string[] {
  const names = new Set<string>([...BASE_WHITELIST, "client-manifest.json"]);
  try {
    const m = JSON.parse(readFileSync(join(CLIENT_DIR, "client-manifest.json"), "utf8"));
    for (const f of Array.isArray(m.files) ? m.files : []) {
      const src = String(f?.src || "");
      if (f?.required && src && !src.startsWith("/") && !src.split("/").includes("..")) names.add(src);
    }
  } catch { /* 清单缺失/坏 JSON 时仍允许基础件 */ }
  return [...names];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") || "";
  if (!allowedNames().includes(name)) {
    return Response.json({ ok: false, error: "name not allowed" }, { status: 403 });
  }
  try {
    const content = readFileSync(join(CLIENT_DIR, name), "utf8");
    return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Client-File": name } });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e).slice(0, 120) }, { status: 404 });
  }
}
