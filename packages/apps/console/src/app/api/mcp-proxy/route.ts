import { NextResponse } from "next/server";
import { spawn, ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

// 持久 MCP stdio server 进程
let proc: ChildProcess | null = null;
let reqId = 0;
const pending = new Map<number, (v: any) => void>();
let buffer = "";

function getKey(): string | undefined {
  const agentId = "agent-e";
  const keyFile = `${homedir()}/.config/${agentId}/lions_mind.env`;
  if (!existsSync(keyFile)) return undefined;
  const content = readFileSync(keyFile, "utf-8");
  const m = content.match(/^LIONS_MIND_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
  return m?.[1].trim();
}

function ensureProc(): ChildProcess {
  if (proc && !proc.killed) return proc;
  proc = spawn("node", [
    "" + (process.env.LIONS_HOME || process.cwd()) + "/packages/apps/mcp-server/dist/index.js",
  ], {
    env: {
      ...process.env,
      LIONS_MIND_AGENT_ID: "agent-e",
      LIONS_MIND_ENDPOINT: "http://localhost:3000/api/trpc",
      LIONS_MIND_API_KEY: getKey() || "",
    },
  });
  proc.stdout!.setEncoding("utf-8");
  proc.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const id = j.id;
        if (typeof id === "number" && pending.has(id)) {
          pending.get(id)!(j);
          pending.delete(id);
        }
      } catch {
        // ignore non-JSON
      }
    }
  });
  return proc;
}

function call(method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = ensureProc();
    const id = ++reqId;
    pending.set(id, resolve);
    p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }
    }, 15000);
  });
}

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const { method, params } = body;
  if (!method) {
    return NextResponse.json({ error: "missing method" }, { status: 400 });
  }
  try {
    const r = await call(method, params || {});
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    info: "MCP proxy (stdio, mind-mcp-server). POST {method, params}.",
    tools: [
      "mind_query",
      "mind_recall_session",
      "mind_save_memory",
      "mind_save_reflection",
      "mind_list_sessions",
      "mind_list_agents",
    ],
  });
}