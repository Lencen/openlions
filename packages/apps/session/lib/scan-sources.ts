/**
 * scan-sources.ts — 服务端可配置的多数据源扫描器
 *
 * 每个 source 描述: agentId, 数据源类型, 路径, agent 标签
 * 通过环境变量 LIONS_SYNC_SOURCES 注入, 格式 JSON:
 *   [
 *     {"agentId":"agent-h","source":"HERMES_SESSION","path":"/data~@uos/00 ai agent/hermes work/state.db","agentName":"UT (本机)","sourceType":"hermes"},
 *     {"agentId":"agent-g","source":"CLAUDE_CONVERSATION","path":"~@uos/.claude/projects","agentName":"UT (claude code)","sourceType":"claude"}
 *   ]
 * 默认值兜底: 单源 agent-h (兼容老配置).
 */
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface ScanSource {
  agentId: string;
  source: string;          // = session.source (HERMES_SESSION / CLAUDE_CONVERSATION)
  sourceType: string;      // P2-5: 扩为 string (原: "hermes" | "claude"), 允许 "openclaw" / "codex" / "sqlite" / ...
  path: string;            // hermes: db 路径; claude: projects 根目录
  agentName?: string;
  // P2-5 (2026-07-15) 新加 2 字段, 让 fallback 路 B (transcript_file) 跟路 C (sqlite_db) 通用化
  // 全部 optional, 老配置不传就 fallback 默认
  transcriptFilePattern?: string;  // e.g. "session_{sourceId}.json" (hermes) / "{sourceId}.jsonl" (claude)
  sqliteQuery?: string;             // SQL query template, e.g. "SELECT ... FROM messages WHERE session_id=?"
}

export const DEFAULT_SOURCES: ScanSource[] = [
  {
    agentId: "agent-h",
    source: "HERMES_SESSION",
    sourceType: "hermes",
    path: "/data~@uos/00 ai agent/hermes work/state.db",
    agentName: "UT (hermes/本机)",
  },
  {
    agentId: "agent-h",
    source: "HERMES_SESSION",
    sourceType: "hermes_sessions",
    path: "/data~@uos/00 ai agent/hermes work/sessions",
    agentName: "UT (hermes sessions/)",
  },
  {
    agentId: "agent-g",
    source: "CLAUDE_CONVERSATION",
    sourceType: "claude",
    path: "~@uos/.claude/projects",
    agentName: "UT (claude code)",
  },
];

export function loadScanSources(): ScanSource[] {
  const env = process.env.LIONS_SYNC_SOURCES;
  if (!env) return DEFAULT_SOURCES;
  try {
    const parsed = JSON.parse(env);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as ScanSource[];
  } catch (e) {
    console.error("[scan-sources] LIONS_SYNC_SOURCES 解析失败, 用默认:", e);
  }
  return DEFAULT_SOURCES;
}

/**
 * 跑一个 Python 子进程, 解析 hermes db / claude jsonl, 输出 {sessions:[...], messagesBySession:{...}}
 * 返回结构跟 sync.ts 期望一致 (sessions 数组含 messageCount/last_msg_ts 等元数据)
 */
export interface ParsedSession {
  externalId: string;        // 原 hermes session id 或 claude session uuid
  agentId: string;
  source: string;
  sourceType: string;        // P2-7: 跟 ScanSource 同步扩 string (原: "hermes" | "claude"), 允许 openclaw/codex/sqlite 等
  title: string | null;
  startedAt: number;          // epoch seconds
  endedAt: number | null;
  lastMsgTs: number | null;
  messageCount: number;
  model: string | null;
  raw?: Record<string, unknown>;
}

export interface ParsedMessage {
  externalId: string;
  sessionExternalId: string;
  role: string;
  content: string | null;
  timestamp: number;         // epoch seconds
  toolCallId?: string | null;
  toolName?: string | null;
  toolCalls?: string | null;
  tokenCount?: number | null;
  reasoning?: string | null;
}

export interface ParseResult {
  sessions: ParsedSession[];
  messages: ParsedMessage[];
}

const SCRIPT = `
import sys, json, os, time, glob, sqlite3
from datetime import datetime, timezone

payload = json.loads(sys.stdin.read())
agent_id = payload["agentId"]
source   = payload["source"]
stype    = payload["sourceType"]
path     = payload["path"]
cutoff   = payload.get("cutoff", 0)  # epoch seconds; 0 = 全量

def iso_to_epoch(s):
    if not s: return None
    try:
        return datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
    except Exception:
        return None

def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for blk in content:
            if not isinstance(blk, dict): continue
            t = blk.get("type")
            if t == "text":
                parts.append(blk.get("text",""))
            elif t == "thinking":
                parts.append("[thinking]\\n" + blk.get("thinking",""))
            elif t == "tool_use":
                parts.append(f"[tool_use: {blk.get('name','?')}]\\n" + json.dumps(blk.get("input",{}), ensure_ascii=False)[:2000])
            elif t == "tool_result":
                c = blk.get("content","")
                if isinstance(c, list):
                    c = "\\n".join(b.get("text","") for b in c if isinstance(b, dict))
                parts.append(f"[tool_result]\\n{str(c)[:2000]}")
        return "\\n\\n".join(parts)
    return str(content)

def parse_hermes(db_path):
    if not os.path.exists(db_path):
        return {"sessions": [], "messages": []}
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("PRAGMA cell_size_check=OFF")
    cur = c.cursor()
    if cutoff > 0:
        cur.execute("""SELECT id, source, title, started_at, ended_at,
                              message_count, tool_call_count, model,
                              estimated_cost_usd, actual_cost_usd,
                              (SELECT MAX(timestamp) FROM messages WHERE session_id = s.id) as last_msg_ts
                         FROM sessions s
                        WHERE started_at >= ?
                        ORDER BY started_at DESC LIMIT 2000""", (cutoff,))
    else:
        cur.execute("""SELECT id, source, title, started_at, ended_at,
                              message_count, tool_call_count, model,
                              estimated_cost_usd, actual_cost_usd,
                              (SELECT MAX(timestamp) FROM messages WHERE session_id = s.id) as last_msg_ts
                         FROM sessions s
                        ORDER BY started_at DESC LIMIT 2000""")
    cols = [d[0] for d in cur.description]
    sessions = []
    session_ids = []
    for row in cur.fetchall():
        d = dict(zip(cols, row))
        if not d.get("last_msg_ts") or d.get("message_count", 0) == 0:
            continue
        sessions.append({
            "externalId": d["id"], "agentId": agent_id, "source": source,
            "sourceType": stype,  # P2-7 fix: 用 payload.sourceType, 不再硬编码 "hermes" (允许 openclaw/codex/sqlite 等)
            "title": d.get("title"), "startedAt": d["started_at"],
            "endedAt": d.get("ended_at"), "lastMsgTs": d["last_msg_ts"],
            "messageCount": d["message_count"],
            "model": d.get("model"),
            "raw": {"source": d.get("source"), "toolCallCount": d.get("tool_call_count"),
                    "estimatedCostUsd": d.get("estimated_cost_usd"),
                    "actualCostUsd": d.get("actual_cost_usd")},
        })
        session_ids.append(d["id"])
    messages = []
    for sid in session_ids:
        cur2 = c.cursor()
        cur2.execute("""SELECT id, session_id, role, content, timestamp,
                               tool_call_id, tool_name, tool_calls, token_count, reasoning
                          FROM messages WHERE session_id = ? ORDER BY timestamp ASC""", (sid,))
        for r in cur2.fetchall():
            messages.append({
                "externalId": str(r[0]), "sessionExternalId": r[1],
                "role": r[2], "content": r[3], "timestamp": r[4],
                "toolCallId": r[5], "toolName": r[6], "toolCalls": r[7],
                "tokenCount": r[8], "reasoning": r[9],
            })
    c.close()
    return {"sessions": sessions, "messages": messages}

def parse_claude(root):
    if not os.path.isdir(root):
        return {"sessions": [], "messages": []}
    sessions = []
    messages = []
    for jl in glob.glob(os.path.join(root, "*", "*.jsonl")):
        try:
            mt = os.path.getmtime(jl)
            if cutoff > 0 and mt < cutoff:
                continue
            events = []
            with open(jl, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try: events.append(json.loads(line))
                    except: pass
            if not events: continue
            sid = None; title = ""; cwd = ""; git_branch = ""; version = ""
            first_ts = None; last_ts = None; model = ""
            session_msgs = []
            idx = 0
            for ev in events:
                t = ev.get("type")
                if "sessionId" in ev: sid = ev["sessionId"]
                if "cwd" in ev: cwd = ev["cwd"]
                if "gitBranch" in ev: git_branch = ev["gitBranch"]
                if "version" in ev: version = ev["version"]
                if t == "ai-title":
                    title = ev.get("aiTitle", title)
                elif t in ("user","assistant"):
                    ts_iso = ev.get("timestamp")
                    ts = iso_to_epoch(ts_iso)
                    if ts:
                        if first_ts is None or ts < first_ts: first_ts = ts
                        if last_ts is None or ts > last_ts: last_ts = ts
                    msg = ev.get("message", {})
                    content = extract_text(msg.get("content",""))
                    if not content.strip(): continue
                    if t == "assistant" and msg.get("model"): model = msg["model"]
                    session_msgs.append({
                        "externalId": ev.get("uuid") or f"msg_{idx}",
                        "sessionExternalId": sid,
                        "role": msg.get("role", t),
                        "content": content,
                        "timestamp": ts,
                        "tokenCount": ((msg.get("usage") or {}).get("input_tokens",0) or 0) + ((msg.get("usage") or {}).get("output_tokens",0) or 0) or None,
                    })
                    idx += 1
            if not sid or not session_msgs: continue
            sessions.append({
                "externalId": sid, "agentId": agent_id, "source": source,
                "sourceType": stype,  # P2-7 fix: 用 payload.sourceType, 不再硬编码 "claude" (允许 openclaw/codex/sqlite 等)
                "title": title or session_msgs[0]["content"][:60],
                "startedAt": first_ts, "endedAt": last_ts, "lastMsgTs": last_ts,
                "messageCount": len(session_msgs), "model": model,
                "raw": {"cwd": cwd, "gitBranch": git_branch, "version": version, "jsonl_path": jl},
            })
            messages.extend(session_msgs)
        except Exception as e:
            print(f"[warn] {jl}: {e}", file=sys.stderr)
            continue
    return {"sessions": sessions, "messages": messages}

def parse_hermes_sessions(sessions_dir):
    if not os.path.isdir(sessions_dir):
        return {"sessions": [], "messages": []}
    sessions = []
    messages = []
    # P2: 只扫 session_2* (跳过 session_cron_* 和 request_dump_*)
    for f in sorted(glob.glob(os.path.join(sessions_dir, "session_2*.json"))):
        try:
            # cutoff: 用文件 mtime 过滤 (epoch seconds)
            if cutoff > 0:
                mt = os.path.getmtime(f)
                if mt < cutoff:
                    continue
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                data = json.load(fh)
            sid = data.get("session_id")
            if not sid: continue
            msgs = data.get("messages", [])
            if not msgs: continue
            started = data.get("session_start")
            ended = data.get("last_updated")
            started_ts = iso_to_epoch(started) or 0
            ended_ts = iso_to_epoch(ended) or started_ts
            # 标题: 第一条 user 消息前 60 字
            title = ""
            for m in msgs:
                if m.get("role") == "user":
                    c = m.get("content", "")
                    if isinstance(c, str):
                        title = c[:60]
                    break
            sessions.append({
                "externalId": sid, "agentId": agent_id, "source": source,
                "sourceType": stype,
                "title": title or sid,
                "startedAt": started_ts, "endedAt": ended_ts, "lastMsgTs": ended_ts,
                "messageCount": len(msgs),
                "model": data.get("model"),
                "raw": {"platform": data.get("platform"), "file": os.path.basename(f)},
            })
            # 消息没有 timestamp, 用 session_start + index 递增 (1 msg/sec)
            base_ts = started_ts
            for idx, m in enumerate(msgs):
                content = m.get("content", "")
                if isinstance(content, list):
                    content = "\\n".join(
                        b.get("text", "") if isinstance(b, dict) else str(b)
                        for b in content
                    )
                if not content or not content.strip():
                    continue
                # 截断超长消息 (避免 buffer 溢出, 5000 chars ~ 1500 tokens)
                if len(content) > 5000:
                    content = content[:5000] + "\\n[...truncated]"
                messages.append({
                    "externalId": f"{sid}_{idx}",
                    "sessionExternalId": sid,
                    "role": m.get("role", "unknown"),
                    "content": content,
                    "timestamp": base_ts + idx,
                    "reasoning": m.get("reasoning"),
                })
        except Exception as e:
            print(f"[warn] {f}: {e}", file=sys.stderr)
            continue
    return {"sessions": sessions, "messages": messages}

if stype == "hermes":
    out = parse_hermes(path)
elif stype == "hermes_sessions":
    out = parse_hermes_sessions(path)
elif stype == "claude":
    out = parse_claude(path)
else:
    out = {"sessions": [], "messages": []}

out_json = json.dumps(out, ensure_ascii=False, default=str)
output_file = payload.get("output_file")
if output_file:
    with open(output_file, "w", encoding="utf-8") as of:
        of.write(out_json)
    sys.stderr.write(f"[scan] wrote {len(out_json)} bytes to {output_file}\\n")
else:
    sys.stdout.write(out_json)
`;

/**
 * 跑一个 source 的扫描, 返回 ParseResult.
 * cutoff > 0 时只处理比 cutoff 新的 session (epoch seconds).
 */
export function scanSource(source: ScanSource, cutoff = 0): ParseResult {
  const payload = {
    agentId: source.agentId,
    source: source.source,
    sourceType: source.sourceType,
    path: source.path,
    cutoff,
  };
  // 检查 path 存在, 不存在直接 skip
  try {
    statSync(source.path);
  } catch {
    console.warn(`[scan-sources] path 不存在, skip: ${source.agentId} → ${source.path}`);
    return { sessions: [], messages: [] };
  }

  const scriptPath = join(tmpdir(), `lions_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);
  const outputPath = join(tmpdir(), `lions_scan_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(scriptPath, SCRIPT);
  try {
    const payloadWithOutput = { ...payload, output_file: outputPath };
    execSync(`python3 "${scriptPath}"`, {
      input: JSON.stringify(payloadWithOutput),
      timeout: 300_000,    // 5min
      maxBuffer: 10 * 1024 * 1024, // 10MB (stderr only, output goes to file)
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result = readFileSync(outputPath, "utf-8");
    return JSON.parse(result || '{"sessions":[],"messages":[]}') as ParseResult;
  } catch (e: any) {
    console.error(`[scan-sources] ${source.agentId} scan 失败:`, e.message?.slice(0, 300));
    return { sessions: [], messages: [] };
  } finally {
    try { unlinkSync(scriptPath); } catch {
      // 临时脚本已被删/删除失败: finally 里的清理是 best-effort, 故意吞掉 —— 否则会盖住真正的 scan 错误
    }
    try { unlinkSync(outputPath); } catch {
      // 同上: 临时输出文件清理失败不影响已经算好的返回值
    }
  }
}
