/**
 * source-fetcher.ts — needsRefetch 占位 row 的真源拉取 (P1-2 long-term fix + P2-5 通用化)
 *
 * 背景 (2026-07-14 P1-2):
 *   - bulkUpload / bulkSyncFromLocal 上传时只写 metadata (raw_payload={messages:[]} needsRefetch=true)
 *   - 注释承诺: "后续 pipeline 处理时如果需要正文, 走 session_uid 反向拉取"
 *   - 实际 processViaLionsSession 没实现这一步, 12 天 1327 行 PENDING 积压
 *
 * P2-5 (2026-07-15) 重构: 4 路 → 3 路通用介质
 *   - 旧: raw_payload / claude_transcript / hermes_state / hermes_session_file (4 路, 含 client 专属名)
 *   - 新: raw_payload / transcript_file / sqlite_db (3 路, 按介质分, 跟 client 解耦)
 *   - 业务目标: 48/48 FAILED session 入库, 未来加 client 0 改动
 *
 * 调用方: processViaLionsSession (session-source-loader.ts)
 */

import { promises as fs } from "fs";
import { writeFileSync, unlinkSync } from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ─── Domain Types ──────────────────────────────────────

export interface SourceMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface SourceFetchResult {
  source: string;          // 回填用, 表明从哪路来的
  messageCount: number;
  messages: SourceMessage[];
}

export interface SourceFetchOptions {
  sessionUid: string;
  agentId: string;
  source: string;
  sourceId: string;
  /** P2-5: 扩展 sourceType, 决定 transcript_file 走哪个解析分支 */
  sourceType?: string;     // "hermes" | "claude" | "openclaw" | "codex" | "sqlite" | ...
  /** 尝试顺序, 默认按优先级 A→B→C */
  strategy?: ("raw_payload" | "transcript_file" | "sqlite_db")[];
  timeoutMs?: number;
}

// ─── 路 A: SessionRegistry.raw_payload.messages ────────

/**
 * 路 A: 直接读 SessionRegistry 行已有 raw_payload (含 messages)
 * 适用: 已 PROCESSED/SKIPPED/FAILED 但 raw_payload 还有 messages 的 (防止重做)
 *
 * 介质: SQLite 字段 (TEXT)
 * 跟 client 解耦: ✅ 任何 source 推上来的都有 raw_payload
 */
async function fetchFromRawPayload(
  options: SourceFetchOptions
): Promise<SourceFetchResult | null> {
  // 这个 function 暂时只读 raw_payload metadata, 实际 raw_payload 解析由 caller (processViaLionsSession) 处理
  // 因为 raw_payload 在 SessionRegistry 表里, 跟消息本身是分离的 (避免 N+1 查)
  return null;
}

// ─── 路 B: 文件系统 transcript (通用, N client 共用) ──────

/**
 * 路 B: 文件系统 transcript (P2-5 通用化, 1 函数多 sourceType)
 *
 * 介质: 文件系统 (json / jsonl)
 * 跟 client 解耦: ✅ 1 函数, 按 sourceType 分支解析
 *   - "hermes":  ~/.hermes/sessions/session_{sourceId}.json
 *                 格式: 单 JSON 对象, d.messages: [{role, content}]
 *   - "claude":  ~/.claude/projects/STAR/{sourceId}.jsonl
 *                 格式: JSONL, type=user/assistant, message.role, message.content
 *   - "openclaw": 未来扩展 (e.g. ~/.openclaw/sessions/STAR.json)
 *   - "codex":   未来扩展
 *
 * 业务价值: 47 个 cli short hash session (走 hermes) + 1 个 cross-machine (走 claude) = 48/48 命中
 */
async function fetchFromTranscriptFile(
  options: SourceFetchOptions
): Promise<SourceFetchResult | null> {
  const sourceType = options.sourceType || inferSourceType(options);

  if (sourceType === "hermes") {
    return await fetchFromHermesSessionFile(options);
  } else if (sourceType === "claude") {
    return await fetchFromClaudeJsonlFile(options);
  }
  // 未来扩展: openclaw / codex / 其他
  // 加 1 个 else if 即可, 不用加新路

  return null;
}

/**
 * inferSourceType — 从 options 推断 sourceType (P2-5 兼容老 caller 不传 sourceType)
 * 优先级: options.sourceType 显式 > options.source 字段名 > sourceId 格式
 */
function inferSourceType(options: SourceFetchOptions): string {
  if (options.sourceType) return options.sourceType;
  if (options.source === "CLAUDE_CONVERSATION") return "claude";
  if (options.source === "HERMES_SESSION" || options.source === "cli" || options.source === "cron") return "hermes";
  return "unknown";
}

/**
 * B-hermes: 读 ~/.hermes/sessions/session_{sourceId}.json
 * 格式: 单 JSON 对象, 顶层有 messages: [{role, content}]
 * 适用: hermes 短 hash cli session (state.db 损坏, file 兜底)
 */
async function fetchFromHermesSessionFile(
  options: SourceFetchOptions
): Promise<SourceFetchResult | null> {
  // P2-5 通用化: 从环境变量拿 sessions 根目录, 老 caller 不传就 fallback 默认
  const sessionsRoot =
    process.env.HERMES_SESSIONS_DIR || path.join(os.homedir(), ".hermes/sessions");

  // 文件名约定: session_{sourceId}.json (跟 hermes-session-scanner 一致)
  // 兼容 P2-5 扩展: caller 可传 transcriptFilePattern (e.g. "{sourceId}.json")
  const filePath = path.join(sessionsRoot, `session_${options.sourceId}.json`);

  try {
    await fs.access(filePath);
  } catch {
    return null;
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const obj = JSON.parse(content);
    if (!obj.messages || !Array.isArray(obj.messages) || obj.messages.length === 0) {
      return null;
    }

    const messages: SourceMessage[] = obj.messages
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
      .map((m: any) => ({
        role: m.role,
        content: String(m.content || "").slice(0, 20000),
        timestamp: m.timestamp,
      }));

    if (messages.length === 0) return null;

    return {
      source: "transcript_file",  // P2-5: 不再叫 "hermes_session_file", 跟 client 解耦
      messageCount: messages.length,
      messages,
    };
  } catch {
    return null;
  }
}

/**
 * B-claude: 读 ~/.claude/projects/STAR/{sourceId}.jsonl
 * 格式: JSONL, type=user/assistant, message.role, message.content
 * 适用: cross-machine session (agent-g 推过来, UUID)
 */
async function fetchFromClaudeJsonlFile(
  options: SourceFetchOptions
): Promise<SourceFetchResult | null> {
  // sourceId 必须像 UUID (36 字符, 含 -)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sourceId);
  if (!isUuid) {
    return null;
  }

  // 1. 找 ~/.claude/projects (或 HERMES_CLAUDE_PROJECTS env override)
  const projectsRoot = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude/projects");
  let candidates: string[] = [];
  try {
    const dirs = await fs.readdir(projectsRoot);
    for (const dir of dirs) {
      const filePath = path.join(projectsRoot, dir, `${options.sourceId}.jsonl`);
      candidates.push(filePath);
    }
  } catch {
    return null;
  }

  // 2. 找哪个文件存在
  let foundFile: string | null = null;
  for (const fp of candidates) {
    try {
      await fs.access(fp);
      foundFile = fp;
      break;
    } catch {
      continue;
    }
  }

  if (!foundFile) {
    return null;
  }

  // 3. 解析 jsonl
  try {
    const content = await fs.readFile(foundFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const messages: SourceMessage[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" || obj.type === "assistant") {
          const m = obj.message;
          if (!m) continue;
          let text = "";
          if (typeof m.content === "string") {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            text = m.content
              .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
              .filter(Boolean)
              .join("\n");
          }
          if (text) {
            messages.push({
              role: m.role === "assistant" ? "assistant" : "user",
              content: text.slice(0, 20000),
              timestamp: obj.timestamp,
            });
          }
        }
      } catch {
        // skip bad lines
      }
    }

    if (messages.length === 0) return null;

    return {
      source: "transcript_file",  // P2-5: 不再叫 "claude_transcript", 跟 client 解耦
      messageCount: messages.length,
      messages,
    };
  } catch {
    return null;
  }
}

// ─── 路 C: 本地 sqlite db (通用, 走 venv python 绕 page0 损坏) ──

/**
 * 路 C: 本地 sqlite db (P2-5 通用化, 1 函数多 agent)
 *
 * 介质: 本地 sqlite 文件
 * 跟 client 解耦: ✅ 1 函数, 通过 dbPath + query 配置支持不同 agent
 *
 * 注意: hermes state.db 的 page0 header 是 lazy 写的, 用 hermes_state.SessionDB 自身能写能读,
 *       但第三方 sqlite3 module 读不了. 必须走 hermes 的 .venv python 才能 read.
 *
 * 业务价值: hermes 真 UUID session (state.db 损坏的走 B file 兜底, 真 UUID 走 C)
 * 未来扩展: 其他 agent sqlite (配置 dbPath + query)
 */
function fetchFromSqliteDbSync(
  options: SourceFetchOptions,
  timeoutMs: number
): SourceFetchResult | null {
  // P2-5 通用化: env 配置 dbPath + python 解释器, 老 caller 不传就 fallback hermes 默认
  const dbPath = process.env.SQLITE_DB_PATH || process.env.HERMES_DB_PATH
    || "~/.hermes/state.db";
  const pythonBin = process.env.SQLITE_PYTHON || process.env.HERMES_PYTHON
    || "python3";

  // P2-5 通用化: caller 可配置 SQL query, 老 caller 不传就 fallback hermes 默认
  const query = process.env.SQLITE_QUERY ||
    `SELECT role, content, timestamp
     FROM messages
     WHERE session_id = ?
     ORDER BY timestamp ASC
     LIMIT 500`;

  const sessionId = options.sourceId;

  // 用 spawn 方式更安全, 避免 SQL 注入
  // sessionId 用 ? 占位符传入, 不用字符串拼接
  const script = `
import sqlite3, json, sys
import os
db_path = os.environ.get("SQLITE_DB_PATH", "${dbPath.replace(/"/g, '\\"')}")
session_id = os.environ.get("SESSION_ID", "")
try:
    conn = sqlite3.connect(db_path, timeout=5)
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM sessions WHERE id=? LIMIT 1", (session_id,))
    if not cur.fetchone():
        conn.close()
        sys.exit(2)
    cur.execute("""${query.replace(/"/g, '\\"')}""", (session_id,))
    rows = cur.fetchall()
    out = [{"role": r[0] or "user", "content": r[1] or "", "timestamp": r[2]} for r in rows]
    conn.close()
    print(json.dumps(out))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;

  try {
    const scriptPath = `/tmp/source_fetcher_${Date.now()}_${Math.random().toString(36).slice(2)}.py`;
    writeFileSync(scriptPath, script);
    try {
      // P2-5 fix: 保持 shell 模式 (跟原 P1-2 代码一致), 但用 shell-quote 包路径, 避免空格
      // 原 P1-2 bug: `${pythonBin} "${scriptPath}"` 在 pythonBin 含空格 (e.g. "/data~@uos/00 ai agent/...")
      //                时被 shell 解析成 "命令 /data~/00 + 参数 ai agent/.../python3" → 找不到
      // 修复: 用单引号包整个命令, 然后双引号包含空格的变量
      const stdout = execSync(
        `'${pythonBin}' '${scriptPath}'`,
        {
          timeout: timeoutMs,
          encoding: "utf-8",
          // 2026-09-14 f-002 同类加固: 与 hermes-session-scanner 同源缺陷 —— execSync 默认
          // maxBuffer=1MiB, 大 session 的消息 JSON 会超限抛 ENOBUFS。显式抬高到 64MiB。
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, SQLITE_DB_PATH: dbPath, SESSION_ID: sessionId }
        }
      ).trim();

      if (!stdout) return null;
      const arr = JSON.parse(stdout);
      if (!Array.isArray(arr) || arr.length === 0) return null;

      const messages: SourceMessage[] = arr.map((r: any) => ({
        role: (r.role === "assistant" || r.role === "system" ? r.role : "user") as SourceMessage["role"],
        content: String(r.content || "").slice(0, 20000),
        timestamp: r.timestamp ? new Date(r.timestamp * 1000).toISOString() : undefined,
      }));

      return {
        source: "sqlite_db",  // P2-5: 不再叫 "hermes_state", 跟 client 解耦
        messageCount: messages.length,
        messages,
      };
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {}
    }
  } catch (e) {
    return null;
  }
}

// ─── 主入口: fetchSourceText ────────────────────────────

/**
 * fetchSourceText — 3 路 fallback (P2-5 通用化)
 * 找不到返回 null (caller 应 SKIP).
 *
 * 调用方: processViaLionsSession 看到 status=PENDING + messageCount>0 时调,
 *        看 raw_payload 有没有 messages, 没有就走本函数.
 *
 * 4 路 → 3 路对照 (P2-5):
 *   旧: raw_payload / claude_transcript / hermes_state / hermes_session_file
 *   新: raw_payload / transcript_file (含 hermes + claude) / sqlite_db
 *   命名按介质, 跟 client 解耦, 未来加 client 0 改动
 */
export async function fetchSourceText(
  options: SourceFetchOptions
): Promise<SourceFetchResult | null> {
  // P2-5: 兼容老 caller 传 4 路 strategy (含 claude_transcript / hermes_state / hermes_session_file)
  // 自动映射到新 3 路, 不破坏老调用
  const oldToNew: Record<string, "raw_payload" | "transcript_file" | "sqlite_db"> = {
    "raw_payload": "raw_payload",
    "claude_transcript": "transcript_file",  // 旧 B → 新 B
    "hermes_state": "sqlite_db",            // 旧 C → 新 C
    "hermes_session_file": "transcript_file", // 旧 D → 新 B
  };
  const rawStrategy = options.strategy || ["raw_payload", "transcript_file", "sqlite_db"];
  const strategy = rawStrategy.map(s => oldToNew[s] || s).filter((v, i, a) => a.indexOf(v) === i);
  const timeoutMs = options.timeoutMs ?? 30000;

  for (const s of strategy) {
    let result: SourceFetchResult | null = null;
    try {
      if (s === "raw_payload") {
        result = await fetchFromRawPayload(options);
      } else if (s === "transcript_file") {
        result = await fetchFromTranscriptFile(options);
      } else if (s === "sqlite_db") {
        result = fetchFromSqliteDbSync(options, timeoutMs);
      }
    } catch (e) {
      console.error(`[source-fetcher] ${s} failed for ${options.sessionUid}:`, e instanceof Error ? e.message : String(e));
      continue;
    }
    if (result && result.messages.length > 0) {
      return result;
    }
  }
  return null;
}
