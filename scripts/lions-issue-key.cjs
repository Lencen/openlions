#!/usr/bin/env node
/**
 * lions-issue-key.cjs — 为某个 agent 签发/轮换某服务的 sk-mind key（产品化 S0-1）
 * =====================================================================================
 * 目的：把"每个 agent 一把、按服务授权"的操作固化下来，避免任何客户/agent 共用密钥。
 * 机制：调用平台 mind 的 POST /api/v1/agent/refresh-service-key（带一把当前有效的 key 作认证），
 *   平台按归属校验后返回新的 sk-mind key，旧 key 立即失效（见 packages/apps/mind/src/lib/key-governance.ts）。
 *
 * 用法：
 *   node scripts/lions-issue-key.cjs --agent=<id> --service=mcp_agent_chat \
 *        --key=<当前有效的 sk-mind/admin key> [--mind=http://127.0.0.1:3000] [--out=<file>] [--json]
 *   node scripts/lions-issue-key.cjs --selftest
 *
 * 安全：默认只打印**掩码**新 key；要落盘用 --out（写 0600）。不打印输入的 key。
 */
"use strict";
const fs = require("fs");
const http = require("http");
const https = require("https");

function parseArgv(argv) {
  const out = { _: [] };
  for (const a of argv) { const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a); if (m) out[m[1]] = m[2] === undefined ? true : m[2]; else out._.push(a); }
  return out;
}
function mask(k) { return !k ? "(none)" : k.slice(0, 9) + "…" + k.slice(-4) + " (len=" + k.length + ")"; }
function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const mod = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = mod.request({ host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname, method: "POST", headers: Object.assign({ "content-type": "application/json", "content-length": payload.length }, headers) }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => { d += c; }); res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject); req.write(payload); req.end();
  });
}
async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.selftest) {
    const assert = (n, c, d) => console.log((c ? "PASS" : "FAIL") + "  " + n + (d ? " :: " + d : ""));
    assert("mask 不泄露全文", mask("sk-demo-abcdef1234567890").indexOf("abcdef1234567890") < 0, mask("sk-demo-abcdef1234567890"));
    assert("parseArgv", parseArgv(["--agent=x", "--service=mcp_agent_chat"]).service === "mcp_agent_chat");
    console.log("SELFTEST OK (2 断言)");
    return;
  }
  const mind = String(args.mind || "http://127.0.0.1:3000").replace(/\/$/, "");
  const agent = args.agent; const service = args.service || "mcp_agent_chat";
  const key = args.key || process.env.MCP_API_KEY || "";
  if (!agent || !key) { console.error("缺少 --agent=<id> 或 --key=<当前有效 key>"); process.exit(3); }
  const r = await postJson(mind + "/api/v1/agent/refresh-service-key", { "X-API-Key": key }, { agentId: String(agent), service_name: String(service) });
  let j = null; try { j = JSON.parse(r.text); } catch (_e) {}
  if (r.status !== 200 || !j || !j.api_key) { console.error("签发失败: HTTP " + r.status + " " + String(r.text).slice(0, 200)); process.exit(1); }
  if (args.out) { fs.writeFileSync(String(args.out), j.api_key + "\n", { mode: 0o600 }); console.log("新 key 已写入 " + args.out + "（0600）"); }
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, agent, service, api_key: j.api_key }) + "\n");
  else console.log("已为 " + agent + " 轮换服务 " + service + " 的 key: " + mask(j.api_key) + "（旧 key 已失效）");
}
main().catch((e) => { console.error("issue-key failed: " + e.message); process.exit(1); });
