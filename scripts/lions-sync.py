#!/usr/bin/env python3
"""
LIONS 统一同步客户端 v1

数据源自动检测 + 配置驱动:
  1. ~/.config/lions-sync/config.yaml  (主配置)
  2. ~/.config/lions-sync/agents/<agent_id>.yaml  (单 agent 配置)

支持数据源:
  - hermes_db: SQLite state.db
  - hermes_json: ~/.hermes/sessions/*.json
  - claude_jsonl: ~/.claude/projects/**/*.jsonl

用法:
  lions-sync.py                 # 同步所有激活 agent
  lions-sync.py --agent leo    # 只同步指定 agent
  lions-sync.py --dry-run      # 不上传, 只打印
  lions-sync.py --incremental  # 增量同步 (since-last-sync)
  lions-sync.py --init         # 生成默认配置文件

依赖:
  pip install pyyaml requests
"""
# 2026-10-06: 让本模块可被**任意 python >= 3.7** 导入。它在本仓有两类消费者:
#   ① 自身 CLI(老客户端 cron, 用 hermes venv 的 3.10+);
#   ② 统一客户端 scripts/macs-responder/lions_session_sync.py 通过 importlib **复用其解析器**
#      (会部署到远端机器, 那里的系统 python3 可能是 3.7 —— 实测 104 就是 3.7.3)。
#   本文件在注解里用了 PEP 604(str | None)与 PEP 585(list[...]); 这些在 3.7 上**求值**即炸,
#   而 PEP 563(from __future__ import annotations, 3.7 起可用)让注解变成字符串、不求值 ——
#   一处修好两端通用。
from __future__ import annotations

import os, sys, json, time, argparse, sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("缺少 requests: pip install requests")
    sys.exit(1)

try:
    import yaml
except ImportError:
    print("缺少 pyyaml: pip install pyyaml")
    sys.exit(1)


# ──────────── 路径解析（开源可移植；不写死开发者机器路径）────────────
_LIONS_HOME = os.environ.get("LIONS_HOME") or os.path.expanduser("~/lions")
def _mind_db_path():
    return os.environ.get("LIONS_MIND_DB") or os.path.join(_LIONS_HOME, "packages/apps/mind/prisma/dev.db")
def _session_db_path():
    return os.environ.get("LIONS_SESSION_DB") or os.path.join(_LIONS_HOME, "packages/apps/session/prisma/dev.db")

# ──────────── 默认配置 ────────────

DEFAULT_CONFIG = {
    "session_service": {
        "url": "http://localhost:3002",
        # 2026-09-24 修: 原为 `os.environ.get(...) or sys.exit(...)` —— 在 cron 这类无 env 的
        #   执行环境里会**直接退出**, 而 config(~/.config/lions-sync/{config,agents/*}.yaml)本就有
        #   api_key 字段。改成「env 优先, 缺失时回退 config」, 保持"不再内置默认 key"这条安全加固
        #   (默认值仍为空, 绝不内置 dev key), 同时不因缺 env 而整条通道失败。
        #   下方 load_config 会用 yaml 里的 api_key 覆盖本默认值。
        "api_key": os.environ.get("LIONS_UPLOAD_API_KEYS", ""),
    },
    "default_source": "hermes_db",
    "agents": [],  # 自动检测
}


# ──────────── 数据源适配器 ────────────

# 系统注入消息前缀 (hermes/openclaw 把这些存成 role=user, 实际是系统注入, 2026-08-31 修正)
SYSTEM_INJECT_PREFIXES = (
    "[IMPORTANT]: You are running as a scheduled cron job",
    "[IMPORTANT: You are running as a scheduled cron job",
    "[IMPORTANT]: Background process",
    "[IMPORTANT: Background process",
    "[IMPORTANT: The user has invoked the",
    "[CONTEXT COMPACTION",
    "[System note:",
    "System: [",  # openclaw exec 完成等运行时注入
    "[System: Your previous",
    "[Your active task list",
    "[Note: model was just switched",
    "[The user sent an image",
    "[cron:",
    "[MCP INBOX]",
    "[SYSTEM",
    "[system",
    "Review the conversation above and update the skill library",
    "Review the conversation above and consider saving to memory",
    "Review the conversation above and update two things",
    "You've reached the maximum number of tool-calling iterations",
    "Your previous turn was interrupted",
    "[IMPORTANT: MCP servers have been reloaded",
    # 2026-09-03 openclaw 自动化注入 (morning 反馈: heartbeat/hook 被判成 user)
    "[OpenClaw heartbeat poll]",
    "Task: Hook | Job ID:",
    "Continue the OpenClaw runtime event",
    "[IMPORTANT]",
)


def is_system_injection(content: str | None) -> bool:
    """判断消息是否为 hermes 系统注入 (cron 任务/上下文压缩/系统提示等)"""
    if not content:
        return False
    c = content.lstrip()
    return any(c.startswith(p) for p in SYSTEM_INJECT_PREFIXES)


class HermesDB:
    """hermes SQLite state.db"""
    def __init__(self, db_path):
        self.db_path = db_path
        self.source_type = "HERMES_SESSION"

    def list_sessions(self, since_ts=0):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        # 2026-08-31: 识别 subagent session (parent 存活期 spawn 的子会话, 首条 user 是任务指令非用户消息)
        # 2026-09-04: 除 started_at 窗口外, 只要会话内有消息时间戳在窗口内(长会话持续追加)也纳入
        rows = conn.execute(
            """SELECT s.*,
                      CASE WHEN s.parent_session_id IS NOT NULL
                           AND p.ended_at IS NOT NULL
                           AND s.started_at <= p.ended_at
                      THEN 1 ELSE 0 END AS _is_subagent
               FROM sessions s
               LEFT JOIN sessions p ON p.id = s.parent_session_id
               WHERE s.started_at > ?
                  OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.timestamp > ?)
               ORDER BY s.started_at ASC""",
            (since_ts, since_ts)
        ).fetchall()
        conn.close()
        return rows

    def get_messages(self, session_id):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
            (session_id,)
        ).fetchall()
        conn.close()
        return rows

    def to_payload(self, agent_id, sess_row, msgs):
        def ts(unixts):
            if not unixts:
                return None
            try:
                return datetime.fromtimestamp(float(unixts), tz=timezone.utc).isoformat().replace("+00:00", "Z")
            except:
                return None
        sid = sess_row["id"]
        is_subagent = bool(sess_row["_is_subagent"]) if "_is_subagent" in sess_row.keys() else False
        return {
            "agentId": agent_id,
            "source": self.source_type,
            "sourceId": sid,
            "title": sid,
            "startedAt": ts(sess_row["started_at"]),
            "lastMessageAt": ts(sess_row["ended_at"] or sess_row["started_at"]),
            "endedAt": ts(sess_row["ended_at"]),
            "model": sess_row["model"],
            "platform": sess_row["source"] or "cli",
            "messages": [{
                "id": str(m["id"]),
                # 2026-08-31: subagent session 的 user 消息是主 agent 任务指令, 非用户 → system
                "role": ("system" if is_subagent else
                         "system" if is_system_injection(m["content"]) else m["role"]),
                "content": m["content"] or "",
                "timestamp": ts(m["timestamp"]),
                "toolCallId": m["tool_call_id"],
                "toolName": m["tool_name"],
                "tokenCount": m["token_count"],
                "reasoning": m["reasoning_content"] or m["reasoning"],
            } for m in msgs],
        }


class HermesJSON:
    """hermes ~/.hermes/sessions/*.json"""
    def __init__(self, sessions_dir):
        self.dir = sessions_dir
        self.source_type = "HERMES_SESSION"
        # 2026-09-04: 同机 hermes state.db 里有消息级时间戳(id 升序与 json 快照 1:1 同序)
        self._tsdb = os.path.join(os.path.dirname(sessions_dir), "state.db")
        self._tscache = {}

    def _iso_ts(self, v):
        """ISO(可带 tz/Z) 或数值 → epoch 秒; 失败返回 None"""
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v) / 1000.0 if v > 1e12 else float(v)
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
        except Exception:
            return None

    def list_sessions(self, since_ts=0):
        """hermes ~/.hermes/sessions/*.json — 2026-09-04 重写
        leo 端同会话有多份按日期命名的快照文件, 时间字段是 session_start/last_updated
        → 按内部 session_id 分组只留最新快照(last_updated 大者, 同值取消息多者);
        since 过滤用 last_updated(长会话今天更新也能进); 兼容旧 start_time/started_at"""
        if not os.path.isdir(self.dir):
            return []
        best = {}
        for f in os.listdir(self.dir):
            if not f.startswith("session_") or not f.endswith(".json"):
                continue
            full = os.path.join(self.dir, f)
            try:
                with open(full) as fh:
                    data = json.load(fh)
            except Exception:
                continue
            sid = str(data.get("session_id") or f.replace(".json", "")).strip()
            upd = self._iso_ts(data.get("last_updated") or data.get("updated_at") or data.get("start_time") or data.get("started_at"))
            if upd is None:
                try:
                    upd = os.path.getmtime(full)
                except Exception:
                    continue
            data["_file"] = full
            data["_sourceId"] = sid
            data["_updTs"] = upd
            data["_msgN"] = len(data.get("messages") or [])
            prev = best.get(sid)
            if prev is None or upd > prev["_updTs"] or (upd == prev["_updTs"] and data["_msgN"] > prev["_msgN"]):
                best[sid] = data
        results = [d for d in best.values() if d["_updTs"] and d["_updTs"] > since_ts]
        results.sort(key=lambda d: d["_updTs"], reverse=True)
        return results

    def get_messages(self, session_data):
        # 2026-09-24 修(agent-f 会话断粮 3 周根因链条之一): dict.get(k, default) 只在
        #   key **不存在**时返回 default; key 存在而值为 None 时返回 None -> 下游 for 迭代 None 抛
        #   TypeError。改用 `or` 兜底。
        return session_data.get("messages") or []

    def _session_ts_list(self, sid):
        """state.db messages(id 升序) 时间戳列表 — 与 json 快照消息同序"""
        try:
            if sid in self._tscache:
                return self._tscache[sid]
            if not os.path.exists(self._tsdb):
                return None
            import sqlite3 as _sq
            con = _sq.connect(self._tsdb)
            rows = con.execute("SELECT timestamp FROM messages WHERE session_id=? ORDER BY id ASC", (sid,)).fetchall()
            con.close()
            out = [r[0] for r in rows] or None
            self._tscache[sid] = out
            return out
        except Exception:
            return None

    def to_payload(self, agent_id, sess_data, msgs):
        source_id = sess_data["_sourceId"]
        t0 = self._iso_ts(sess_data.get("session_start") or sess_data.get("start_time"))
        t1 = self._iso_ts(sess_data.get("last_updated") or sess_data.get("updated_at"))
        if not t0:
            t0 = t1
        ts_list = self._session_ts_list(source_id) if msgs else None
        pmsgs = []
        for i, m in enumerate(msgs or []):
            ts_v = self._iso_ts(m.get("timestamp") or m.get("ts"))
            if ts_v is None:
                if ts_list and i < len(ts_list) and ts_list[i] is not None:
                    ts_v = self._iso_ts(ts_list[i])
            if ts_v is None:
                ts_v = t0 or (t1 or i)
            role = m.get("role", "user")
            content = m.get("content") or ""
            if isinstance(content, list):
                texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("text")]
                content = "\n".join(texts) if texts else str(content)
            # 2026-09-03: 系统注入(user 消息里的 cron/heartbeat 等) → system
            if role == "user" and is_system_injection(content):
                role = "system"
            pm = {
                "id": str(m.get("id") or (source_id + ":" + str(i))),
                "role": role,
                "content": content,
                "timestamp": datetime.fromtimestamp(float(ts_v), tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            for k in ("reasoning_content", "reasoning"):
                if m.get(k):
                    pm["reasoning"] = str(m[k])[:4000]
            pmsgs.append(pm)
        if not pmsgs:
            return None
        return {
            "agentId": agent_id,
            "source": self.source_type,
            "sourceId": source_id,
            "title": str(sess_data.get("session_id") or source_id),
            "startedAt": datetime.fromtimestamp(float(t0), tz=timezone.utc).isoformat().replace("+00:00", "Z") if t0 else None,
            "lastMessageAt": datetime.fromtimestamp(float(t1 or t0), tz=timezone.utc).isoformat().replace("+00:00", "Z") if (t1 or t0) else None,
            "messages": pmsgs,
        }


class ClaudeJSONL:
    """Claude ~/.claude/projects/**/*.jsonl"""
    def __init__(self, projects_dir):
        self.dir = projects_dir
        self.source_type = "CLAUDE_CONVERSATION"

    def list_sessions(self, since_ts=0):
        """返回所有 jsonl 文件, 按 mtime 排序"""
        if not os.path.isdir(self.dir):
            return []
        results = []
        for root, dirs, files in os.walk(self.dir):
            for f in files:
                if not f.endswith(".jsonl"):
                    continue
                full = os.path.join(root, f)
                mtime = os.path.getmtime(full)
                if mtime > since_ts:
                    results.append({
                        "_file": full,
                        "_sourceId": f.replace(".jsonl", ""),
                        "_mtime": mtime,
                    })
        return results

    def get_messages(self, session_data):
        msgs = []
        with open(session_data["_file"]) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    msgs.append(json.loads(line))
                except:
                    continue
        return msgs

    def to_payload(self, agent_id, sess_data, msgs):
        source_id = sess_data["_sourceId"]
        return {
            "agentId": agent_id,
            "source": self.source_type,
            "sourceId": source_id,
            "title": source_id,
            "startedAt": msgs[0].get("timestamp") if msgs else None,
            "lastMessageAt": msgs[-1].get("timestamp") if msgs else None,
            "messages": [{
                "id": f"{source_id}:{i}",
                "role": m.get("role", "user"),
                "content": m.get("content") or m.get("message", ""),
                "timestamp": m.get("timestamp"),
            } for i, m in enumerate(msgs)],
        }


class OpenClawJSONL:
    """OpenClaw ~/.openclaw/agents/*/sessions/*.jsonl
    Phase 2 2026-08-31: 小七(agent-operator)真实数据源
    jsonl 每行一个事件, 消息行: {"type":"message","message":{"role":..,"content":..}}
    """
    def __init__(self, agents_dir):
        self.dir = agents_dir
        self.source_type = "OPENCLAW_SESSION"

    def list_sessions(self, since_ts=0):
        """遍历 agents/*/sessions/*.jsonl + ~/.openclaw/cron/runs/*.jsonl,
        排除 .bak/.trajectory/.deleted/sessions.json
        2026-09-01: cron/runs 是 OpenClaw 定时任务运行记录 (持续追加长文件, 与 DSH 同模式),
        之前漏扫导致 cron 数据不进飞轮。sourceId 加 cron: 前缀区分, 避免与同名 session 冲突。
        cron/runs 是 agents 的兄弟目录: <agents_dir>/../cron/runs"""
        if not os.path.isdir(self.dir):
            return []
        results = []
        # 1) agents/*/sessions/*.jsonl 会话文件
        for root, dirs, files in os.walk(self.dir):
            if not root.endswith("sessions"):
                continue
            for f in files:
                if not f.endswith(".jsonl"):
                    continue
                if ".bak" in f or "trajectory" in f or ".deleted" in f:
                    continue
                full = os.path.join(root, f)
                mtime = os.path.getmtime(full)
                if mtime <= since_ts:
                    continue
                results.append({
                    "_file": full,
                    "_sourceId": f.replace(".jsonl", ""),
                    "_mtime": mtime,
                })
        # 2) ~/.openclaw/cron/runs/*.jsonl 定时任务运行记录 (2026-09-01 新增)
        cron_runs_dir = os.path.join(os.path.dirname(os.path.abspath(self.dir)), "cron", "runs")
        if os.path.isdir(cron_runs_dir):
            for f in os.listdir(cron_runs_dir):
                if not f.endswith(".jsonl") or ".bak" in f:
                    continue
                full = os.path.join(cron_runs_dir, f)
                mtime = os.path.getmtime(full)
                if mtime <= since_ts:
                    continue
                results.append({
                    "_file": full,
                    "_sourceId": f"cron:{f.replace('.jsonl', '')}",
                    "_mtime": mtime,
                })
        return results

    def get_messages(self, session_data):
        """sessions/*.jsonl: 取 type=message 行; cron:runs/*.jsonl: 每条运行记录转一条消息
        2026-09-01: cron run 文件格式 = {ts, jobId, action, status, summary/error, diagnostics},
        非对话消息。把每次 finished 运行转成一条 tool 消息, 让认知提取吸收任务执行经验。"""
        is_cron = str(session_data.get("_sourceId", "")).startswith("cron:")
        msgs = []
        with open(session_data["_file"]) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except:
                    continue
                if is_cron:
                    # cron run 记录 → 消息 (仅 finished 主记录, 避免 diagnostics 刷屏)
                    if obj.get("action") not in ("finished", None):
                        continue
                    ts = obj.get("ts")
                    status = obj.get("status", "")
                    parts = [f"[cron run {status}] job={obj.get('jobId','')[:12]}"]
                    if obj.get("summary"):
                        parts.append(str(obj["summary"])[:2000])
                    if obj.get("error"):
                        parts.append(f"ERROR: {str(obj['error'])[:500]}")
                    msgs.append({
                        "_cron": True,
                        "id": f"cron:{ts or len(msgs)}",
                        "role": "tool",
                        "content": "\n\n".join(parts),
                        "timestamp": ts,
                        "toolName": obj.get("action", "cron-run"),
                    })
                elif obj.get("type") == "message":
                    msgs.append(obj)
        return msgs

    def to_payload(self, agent_id, sess_data, msgs):
        source_id = sess_data["_sourceId"]
        started_at = None
        last_at = None
        payload_msgs = []
        for obj in msgs:
            if obj.get("_cron"):
                ts = obj.get("timestamp")
                if ts and not started_at:
                    started_at = ts
                if ts:
                    last_at = ts
                payload_msgs.append({
                    "id": obj.get("id") or f"{source_id}:{len(payload_msgs)}",
                    "role": obj.get("role", "tool"),
                    "content": obj.get("content", ""),
                    "timestamp": ts,
                    "toolName": obj.get("toolName"),
                })
                continue
            # 2026-09-24 修(**agent-f 会话同步 100% 失败 3 周的根因**):
            #   原为 obj.get("message", {}) —— hermes 的部分记录该 key 存在但值为 None,
            #   于是 m=None, 下一行 m.get("role") 抛 'NoneType' object has no attribute 'get',
            #   被上层逐条 try/except 记 [ERR] -> 每轮 75/75 全失败(ok=0 fail=75), 每 10 分钟一次,
            #   连续 3 周无人发现(错误只落在机器本地日志 ~/lions-sync-uos20.log)。
            #   实测证据: 104 上该日志 12147 行 ok=0, 末次成功在 09-03。
            m = obj.get("message") or {}
            role = m.get("role", "user")
            content = m.get("content", "")
            if isinstance(content, list):
                texts = [c.get("text", "") for c in content
                         if isinstance(c, dict) and c.get("text")]
                content = "\n".join(texts) if texts else ""
            ts = obj.get("timestamp")
            if ts and not started_at:
                started_at = ts
            if ts:
                last_at = ts
            # openclaw 运行时事件/系统注入 → system (2026-08-31 起, 2026-09-03 扩全前缀)
            if role == "user" and isinstance(content, str) and is_system_injection(content):
                role = "system"
            payload_msgs.append({
                "id": obj.get("id") or f"{source_id}:{len(payload_msgs)}",
                "role": role,
                "content": content or "",
                "timestamp": ts,
            })
        return {
            "agentId": agent_id,
            "source": self.source_type,
            "sourceId": source_id,
            "title": source_id,
            "startedAt": started_at,
            "lastMessageAt": last_at,
            "messages": payload_msgs,
        }


# ──────────── Agent 自动检测 ────────────

def detect_agents(local_host=None):
    """从 LIONS AgentRegistry 自动检测已注册 agent
    Phase 2 2026-08-31: 加 local_host 过滤, 只同步本机 agent (避免跨终端误同步)
    """
    # 简化: 从 mind DB 查 ACTIVE agents + 他们的 api_key
    mind_db = _mind_db_path()
    if not os.path.exists(mind_db):
        # Phase 2: 无 mind db 的终端 ([host] 等) 从 yaml 目录读 agent
        return detect_agents_from_yaml(local_host)

    import sqlite3
    conn = sqlite3.connect(mind_db)
    conn.row_factory = sqlite3.Row

    # 拿 ACTIVE agents (Phase 2: 按 host 过滤, 只同步本机)
    if local_host:
        agents = conn.execute(
            "SELECT * FROM AgentRegistry WHERE status='ACTIVE' AND host=? ORDER BY agent_id",
            (local_host,)
        ).fetchall()
    else:
        agents = conn.execute(
            "SELECT * FROM AgentRegistry WHERE status='ACTIVE' ORDER BY agent_id"
        ).fetchall()

    results = []
    for a in agents:
        agent_id = a["agent_id"]

        # 拿 session service 权限的 api_key (plaintext)
        perm = conn.execute(
            "SELECT api_key_plain FROM AgentServicePermission "
            "WHERE agent_id=? AND status='ACTIVE' "
            "AND service_name='lions_session' "
            "LIMIT 1",
            (agent_id,)
        ).fetchone()

        if not perm:
            continue

        results.append({
            "agent_id": agent_id,
            "display_name": a["display_name"],
            "api_key": perm["api_key_plain"],
            "data_source": detect_data_source(agent_id),
        })

    conn.close()
    return results


def detect_agents_from_yaml(local_host=None):
    """从 ~/.config/lions-sync/agents/*.yaml 读 agent 列表
    Phase 2 2026-08-31: 无 mind db 的终端 ([host]) 用这个路径
    yaml 里可含 api_key 字段 (否则 detect_agents 从 mind db 读)
    """
    agents_dir = os.path.expanduser("~/.config/lions-sync/agents")
    if not os.path.isdir(agents_dir):
        return []
    results = []
    for f in sorted(os.listdir(agents_dir)):
        if not f.endswith(".yaml"):
            continue
        cfg = load_agent_yaml(f[:-5])
        if not cfg:
            continue
        agent_id = cfg.get("agent_id")
        if not agent_id:
            continue
        # host 过滤 (可选)
        if local_host and cfg.get("host") and cfg["host"] != local_host:
            continue
        ds = detect_data_source(agent_id)
        results.append({
            "agent_id": agent_id,
            "display_name": cfg.get("display_name", agent_id),
            "api_key": cfg.get("api_key", ""),
            "data_source": ds,
        })
    return results


def load_agent_yaml(agent_id):
    """读取 per-agent 显式 yaml 配置 (Phase 1 2026-08-31)"""
    yaml_path = Path(os.path.expanduser(f"~/.config/lions-sync/agents/{agent_id}.yaml"))
    if not yaml_path.exists():
        return None
    try:
        with open(yaml_path) as f:
            return yaml.safe_load(f)
    except Exception as e:
        print(f"  [WARN] 读 {yaml_path} 失败: {e}", file=sys.stderr)
        return None


def detect_data_source(agent_id):
    """按优先级自动检测 agent 的数据源
    Phase 1 2026-08-31: yaml 优先, 避免所有 agent 永远 fallback 到 home 路径
    """
    # 1. per-agent 显式 yaml (最高优先级)
    yaml_cfg = load_agent_yaml(agent_id)
    if yaml_cfg and yaml_cfg.get("data_source"):
        ds = yaml_cfg["data_source"]
        if ds.get("path") and os.path.exists(ds["path"]):
            return {"type": ds["type"], "path": ds["path"]}

    # 2. fallback: auto-detect 候选路径
    home = os.path.expanduser("~")
    candidates = [
        ("hermes_db", f"{home}/.hermes/state.db"),
        ("hermes_db", os.path.expanduser(f"~/agents/{agent_id}/.hermes/state.db")),
        ("hermes_json", f"{home}/.hermes/sessions"),
        ("hermes_json", os.path.expanduser(f"~/agents/{agent_id}/00 ai agent/hermes work/sessions")),
        ("claude_jsonl", f"{home}/.claude/projects"),
        ("codex_jsonl", f"{home}/.codex/sessions"),
        ("openclaw_jsonl", f"{home}/.openclaw/agents"),
    ]

    for source_type, path in candidates:
        if os.path.exists(path):
            return {"type": source_type, "path": path}

    return None


def get_sync_config(agent_id):
    """读 per-agent yaml 的 sync 配置 (skip_existing / batch_size)"""
    yaml_cfg = load_agent_yaml(agent_id)
    if not yaml_cfg:
        return {"skip_existing": False, "batch_size": 50}
    return {
        "skip_existing": (yaml_cfg.get("sync") or {}).get("skip_existing", False),
        "batch_size": (yaml_cfg.get("sync") or {}).get("batch_size", 50),
    }


# Session 服务固定 key (list endpoint 只认这个, upload 接受 sk-mind-xxx)
SESSION_LIST_KEY = "lions-session-dev-key"
SESSION_DB_PATH = _session_db_path()


def session_exists(upload_url, agent_id, source_id, api_key=None, source_type="hermes_session"):
    """去重检查: Session 表里 (agentId, source, sourceId) 是否已存在
    Phase 1.4 2026-08-31 优化: 直接读 sqlite (跳过 HTTP)
    - sessionUid 格式 "${agentId}:${source}:${sourceId}"
    - 走本机 sqlite 比 HTTP 快 100x (HTTP 拉 3400 条 = 51s vs sqlite 0.34s)
    - 上传 url/api_key 参数保留兼容, 实际不用
    Phase 1.5 2026-09-01: 返回 (exists, src_msg_count, svc_msg_count)。
      源消息数 > 服务端消息数 = 会话被追加过 → 需要重传覆盖 (存在即跳过会丢增量)
    """
    target_uid = f"{agent_id}:{source_type}:{source_id}"
    try:
        if not os.path.exists(SESSION_DB_PATH):
            return (False, 0, 0)
        conn = sqlite3.connect(SESSION_DB_PATH, timeout=5)
        try:
            row = conn.execute(
                "SELECT messageCount FROM Session WHERE sessionUid=? LIMIT 1",
                (target_uid,),
            ).fetchone()
            if row is None:
                return (False, 0, 0)
            svc = int(row[0] or 0)
            # 源消息数由调用方传入 (src_msg_count), 这里只查服务端
            return (True, 0, svc)
        finally:
            conn.close()
    except Exception as e:
        print(f"    [dedup-check-fail] {source_id[:40]}: {str(e)[:60]}", file=sys.stderr)
    return (False, 0, 0)


# ──────────── 同步执行 ────────────

# 2026-09-04: 消息级增量水位 (state.json) — 长会话只推新增消息, 不再整段重传
STATE_FILE = os.path.expanduser("~/.config/lions-sync/state.json")
_state = None

def load_state():
    global _state
    if _state is not None:
        return _state
    try:
        with open(STATE_FILE) as f:
            _state = json.load(f)
    except Exception:
        _state = {}
    # 2026-09-15 修复(独立复核 session-sync 实锤): 文件内容若是 JSON 字面量 null(曾因异常写入),
    #   json.load 返回 None -> 下游 state.get("agents",{}) 抛 'NoneType' object has no attribute
    #   'get' -> 本机 leo/operator 同步每轮全灭(leo 11 天会话未进平台), 且 save_state 把 None 写回
    #   "null" 自锁。任何非 dict 一律归一为空 dict。
    if not isinstance(_state, dict):
        _state = {}
    return _state

def save_state():
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        # 2026-09-15 修复: 绝不把 None/非 dict 写回(防自锁)
        if not isinstance(_state, dict):
            return
        with open(STATE_FILE, "w") as f:
            json.dump(_state, f)
    except Exception as e:
        print(f"  [state-save-fail] {e}", file=sys.stderr)

class CodexJSONL:
    """Codex CLI ~/.codex/sessions/**/*.jsonl（容忍多代格式）

    rollout 每行一个事件，常见形态:
      {"timestamp":..., "type":"session_meta", "payload":{...}}
      {"timestamp":..., "type":"response_item", "payload":{"type":"message","role":"user",
        "content":[{"type":"input_text","text":"..."}]}}
      {"timestamp":..., "type":"event_msg", "payload":{"type":"agent_message","message":"..."}}
    另兼容简化形态 {"role":.., "content":..}；坏行跳过。
    """
    def __init__(self, sessions_dir):
        self.dir = sessions_dir
        self.source_type = "CODEX_CONVERSATION"

    def list_sessions(self, since_ts=0):
        if not os.path.isdir(self.dir):
            if os.path.isfile(self.dir) and self.dir.endswith(".jsonl"):
                m = os.path.getmtime(self.dir)
                return [{"_file": self.dir, "_sourceId": os.path.basename(self.dir)[:-6], "_mtime": m}] if m > since_ts else []
            return []
        out = []
        for root, _dirs, files in os.walk(self.dir):
            for f in files:
                if not f.endswith(".jsonl"):
                    continue
                full = os.path.join(root, f)
                m = os.path.getmtime(full)
                if m > since_ts:
                    out.append({"_file": full, "_sourceId": f[:-6], "_mtime": m})
        out.sort(key=lambda r: r["_mtime"])
        return out

    def get_messages(self, session_data):
        rows = []
        with open(session_data["_file"], errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
        return rows

    @staticmethod
    def _text_of(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, str):
                    parts.append(c)
                elif isinstance(c, dict):
                    parts.append(c.get("text") or c.get("content") or "")
            return "\n".join(p for p in parts if p)
        return ""

    def _extract(self, obj):
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        if obj.get("role") and ("content" in obj or "message" in obj):
            return obj.get("role"), self._text_of(obj.get("content") or obj.get("message"))
        ptype = payload.get("type")
        if ptype == "message":
            return payload.get("role"), self._text_of(payload.get("content"))
        if ptype in ("agent_message", "user_message", "assistant_message"):
            role = {"agent_message": "assistant", "user_message": "user", "assistant_message": "assistant"}.get(ptype)
            return role, self._text_of(payload.get("message") or payload.get("content"))
        if obj.get("type") == "message":
            return obj.get("role"), self._text_of(obj.get("content"))
        return None, None

    def to_payload(self, agent_id, sess_data, msgs):
        source_id = sess_data["_sourceId"]
        out = []
        started_at = last_at = None
        for obj in msgs:
            if not isinstance(obj, dict):
                continue
            role, text = self._extract(obj)
            if not text:
                continue
            if role not in ("user", "assistant", "system", "tool"):
                role = "assistant"
            ts = obj.get("timestamp") or (obj.get("payload") or {}).get("timestamp")
            if ts and started_at is None:
                started_at = ts
            if ts:
                last_at = ts
            if role == "user" and isinstance(text, str) and is_system_injection(text):
                role = "system"
            out.append({"id": f"{source_id}:{len(out)}", "role": role, "content": text, "timestamp": ts})
        if not out:
            return None
        return {"agentId": agent_id, "source": self.source_type, "sourceId": source_id, "title": source_id,
                "startedAt": started_at, "lastMessageAt": last_at, "messages": out}


def make_adapter(source_cfg):
    if source_cfg["type"] == "hermes_db":
        return HermesDB(source_cfg["path"])
    elif source_cfg["type"] == "hermes_json":
        return HermesJSON(source_cfg["path"])
    elif source_cfg["type"] == "claude_jsonl":
        return ClaudeJSONL(source_cfg["path"])
    elif source_cfg["type"] == "openclaw_jsonl":
        return OpenClawJSONL(source_cfg["path"])
    elif source_cfg["type"] == "codex_jsonl":
        return CodexJSONL(source_cfg["path"])
    else:
        raise ValueError(f"未知数据源: {source_cfg['type']}")


def sync_agent(agent, upload_url, dry_run=False, since_ts=0):
    """同步一个 agent 的所有数据
    Phase 1 2026-08-31: 加 skip_existing 去重 (per-agent yaml 控制)
    """
    agent_id = agent["agent_id"]
    api_key = agent["api_key"]
    sync_cfg = get_sync_config(agent_id)

    if not agent.get("data_source"):
        return {"agent": agent_id, "ok": 0, "fail": 0, "skip": True, "reason": "no data source"}

    adapter = make_adapter(agent["data_source"])
    sessions = adapter.list_sessions(since_ts)

    print(f"\n[{agent_id}] {agent['data_source']['type']} → {len(sessions)} sessions "
          f"(skip_existing={sync_cfg['skip_existing']})")

    if dry_run:
        return {"agent": agent_id, "ok": len(sessions), "fail": 0, "dry_run": True}

    # source_type 用于 sessionUid 去重 (Phase 2: 各 adapter source_type 不同, 需小写)
    source_type = adapter.source_type.lower()

    ok, fail, skipped = 0, 0, 0
    for sess in sessions:
        source_id = None
        try:
            # 统一提取 source_id (dict=jsonl adapter 用 _sourceId, Row=HermesDB 用 id)
            if isinstance(sess, dict):
                source_id = sess.get("_sourceId") or sess.get("id")
                sess_arg = sess
            else:
                source_id = sess["id"]
                sess_arg = sess["id"]

            msgs = adapter.get_messages(sess_arg)
            payload = adapter.to_payload(agent_id, sess, msgs)
            if payload is None:
                skipped += 1
                continue
            sid_key = payload.get("sourceId") or str(source_id)
            st_key = f"{agent_id}|{sid_key}"
            full_n = len(payload.get("messages") or [])

            # 2026-09-04 消息级增量: 有水位 → 只推新增 (id 稳定按追加序)
            state = load_state()
            prev_n = (state.get("agents") or {}).get(st_key)
            if prev_n is not None:
                if full_n <= prev_n:
                    skipped += 1
                    continue
                delta = payload["messages"][prev_n:]
                if delta:
                    payload = dict(payload)
                    payload["messages"] = delta
                    payload["incremental"] = True
                else:
                    skipped += 1
                    continue
            else:
                # 老路径兜底: 本地 DB 去重 (无水位时避免重传)
                if sync_cfg["skip_existing"]:
                    exists, _, svc_msgs = session_exists(upload_url, agent_id, source_id, api_key, source_type)
                    if exists and full_n <= svc_msgs:
                        skipped += 1
                        try:
                            state.setdefault("agents", {})[st_key] = full_n
                        except Exception:
                            pass
                        continue

            r = requests.post(
                f"{upload_url}/api/sessions/upload",
                json=payload,
                headers={"X-API-Key": api_key},
                timeout=120,
            )

            if r.status_code == 200 and r.json().get("success"):
                ok += 1
                try:
                    state.setdefault("agents", {})[st_key] = full_n
                except Exception:
                    pass
            else:
                fail += 1
                print(f"  [FAIL] {payload['sourceId'][:40]}: HTTP {r.status_code} {r.text[:100]}")
        except Exception as e:
            fail += 1
            sid_str = (source_id or "?")[:40]
            print(f"  [ERR]  {sid_str}: {str(e)[:80]}")

        if (ok + fail + skipped) % 10 == 0:
            print(f"  [{agent_id}] {ok+fail+skipped}/{len(sessions)} ok={ok} fail={fail} skip={skipped}")

    save_state()
    return {"agent": agent_id, "ok": ok, "fail": fail, "skipped": skipped}


def main():
    parser = argparse.ArgumentParser(description="LIONS 统一同步客户端")
    parser.add_argument("--agent", help="只同步指定 agent")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--since-days", type=int, default=0)
    parser.add_argument("--init", action="store_true", help="生成默认配置")
    parser.add_argument("--list", action="store_true", help="列出所有 agent")
    parser.add_argument("--selftest", action="store_true", help="适配器自测")
    args = parser.parse_args()

    if getattr(args, "selftest", False):
        import tempfile
        d = tempfile.mkdtemp(prefix="lions-codex-")
        fp = os.path.join(d, "rollout-2026-01-01T00-00-00-abc.jsonl")
        with open(fp, "w") as f:
            f.write(json.dumps({"timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": {"id": "abc"}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-01-01T00:00:01Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello codex"}]}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-01-01T00:00:02Z", "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hi"}]}}) + "\n")
            f.write(json.dumps({"type": "event_msg", "payload": {"type": "agent_message", "message": "done"}}) + "\n")
            f.write("not-json\n")
        ad = CodexJSONL(d)
        ss = ad.list_sessions()
        pl = ad.to_payload("agent-x", ss[0], ad.get_messages(ss[0])) if ss else None
        print("PASS  list_sessions" if len(ss) == 1 else "FAIL  list_sessions")
        print("PASS  payload msgs" if pl and len(pl["messages"]) == 3 else "FAIL  payload msgs")
        print("PASS  user/agent_message" if pl and pl["messages"][0]["role"] == "user" and "hello codex" in pl["messages"][0]["content"] and pl["messages"][2]["content"] == "done" else "FAIL  user/agent_message")
        print("PASS  missing dir" if CodexJSONL("/nonexistent").list_sessions() == [] else "FAIL  missing dir")
        ok = len(ss) == 1 and pl and len(pl["messages"]) == 3 and pl["messages"][0]["role"] == "user" and pl["messages"][2]["content"] == "done"
        print("SELFTEST OK (4 断言)" if ok else "SELFTEST FAILED")
        sys.exit(0 if ok else 1)


    if args.init:
        config_dir = Path(os.path.expanduser("~/.config/lions-sync"))
        config_dir.mkdir(parents=True, exist_ok=True)
        config_file = config_dir / "config.yaml"
        with open(config_file, "w") as f:
            yaml.dump(DEFAULT_CONFIG, f, default_flow_style=False)
        print(f"配置已生成: {config_file}")
        return

    # 加载配置
    config_file = Path(os.path.expanduser("~/.config/lions-sync/config.yaml"))
    if config_file.exists():
        with open(config_file) as f:
            config = yaml.safe_load(f)
    else:
        config = DEFAULT_CONFIG

    upload_url = config["session_service"]["url"]
    default_key = config["session_service"]["api_key"]
    local_host = config.get("local_host") or None

    # 检测 agent (Phase 2: 只同步本机 host 的 agent)
    agents = detect_agents(local_host)
    if not agents:
        print("未检测到已注册 agent。先注册一个: agent.register")
        return

    if args.list:
        print("已注册 agent:")
        for a in agents:
            print(f"  {a['agent_id']:30} {a['display_name']:30} src={(a.get('data_source') or {}).get('type')}")
        return

    if args.agent:
        agents = [a for a in agents if a["agent_id"] == args.agent]
        if not agents:
            print(f"agent '{args.agent}' 未注册")
            return

    # 时间过滤
    since_ts = 0
    if args.since_days > 0:
        since_ts = (datetime.now() - timedelta(days=args.since_days)).timestamp()

    print(f"LIONS 同步客户端 v1")
    print(f"目标: {upload_url}")
    print(f"模式: {'dry-run' if args.dry_run else 'upload'}")
    print(f"agent: {len(agents)} 个")
    if since_ts:
        print(f"since: 最近 {args.since_days} 天")

    start = time.time()
    results = []
    for a in agents:
        r = sync_agent(a, upload_url, args.dry_run, since_ts)
        results.append(r)

    print(f"\n=== 完成 ===")
    print(f"耗时: {time.time() - start:.1f}s")
    total_ok = sum(r.get("ok", 0) for r in results)
    total_fail = sum(r.get("fail", 0) for r in results)
    print(f"总: ok={total_ok} fail={total_fail}")
    for r in results:
        if r.get("skip"):
            print(f"  {r['agent']}: SKIP ({r['reason']})")
        else:
            print(f"  {r['agent']}: ok={r['ok']} fail={r['fail']}")


if __name__ == "__main__":
    main()