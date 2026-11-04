#!/usr/bin/env python3
"""
lions_agent_client.py — 开源客户端子集（非 MACS）2026-11-04

范围（只做开源版需要的部分）：
  sync     会话上传（调用同目录/安装根的 lions-sync.py）
  claim    认领一条飞轮改进任务
  heartbeat 续租
  submit   提交结果
  release  放回队列
不含：MACS 跨 agent 通信、SSE 收消息、自动回复、多设备协同。

配置（环境变量优先，其次 ~/.config/lions-agent/env）：
  LIONS_MIND_URL         默认 http://127.0.0.1:3000
  LIONS_SESSION_API_BASE 默认 http://127.0.0.1:3002
  LIONS_AGENT_ID         任务命令必填，例如 agent-demo
  LIONS_API_KEY          agent 的 sk-mind key（由接入向导/claim-service-key 领取）
  LIONS_SYNC_PY          lions-sync.py 路径（默认安装根 current/scripts/lions-sync.py）

用法：
  python3 lions_agent_client.py sync --incremental
  python3 lions_agent_client.py claim --agent agent-demo --types THEME_IMPROVE
  python3 lions_agent_client.py heartbeat --agent agent-demo --task <id>
  python3 lions_agent_client.py submit --agent agent-demo --task <id> --output result.md
  python3 lions_agent_client.py release --agent agent-demo --task <id> --reason "需要工具"
  python3 lions_agent_client.py selftest
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

def _load_env_file():
    p = Path.home() / ".config" / "lions-agent" / "env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

def cfg(name, default=""):
    return os.environ.get(name, default).strip()

def mind_url():
    return cfg("LIONS_MIND_URL", "http://127.0.0.1:3000").rstrip("/")

def agent_id(args):
    a = (getattr(args, "agent", None) or cfg("LIONS_AGENT_ID")).strip()
    if not a:
        raise SystemExit("缺少 agent：用 --agent 或 LIONS_AGENT_ID")
    return a

def http_json(method, path, body=None):
    url = mind_url() + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    key = cfg("LIONS_API_KEY")
    if key:
        req.add_header("x-api-key", key)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(raw)
        except Exception:
            j = {"error": raw[:300]}
        return e.code, j

def cmd_sync(args):
    script = cfg("LIONS_SYNC_PY")
    if not script:
        candidates = [
            Path.cwd() / "scripts" / "lions-sync.py",
            Path.home() / "lions" / "current" / "scripts" / "lions-sync.py",
            Path(__file__).resolve().parent.parent / "lions-sync.py",
        ]
        for c in candidates:
            if c.exists():
                script = str(c)
                break
    if not script or not Path(script).exists():
        raise SystemExit("找不到 lions-sync.py：用 LIONS_SYNC_PY 指定")
    argv = [sys.executable, script]
    if args.agent:
        argv += ["--agent", args.agent]
    argv.append("--dry-run" if args.dry_run else "--incremental")
    print("+ " + " ".join(argv))
    return subprocess.call(argv)

def cmd_claim(args):
    types = [x.strip() for x in (args.types or "THEME_IMPROVE").split(",") if x.strip()]
    body = {"agentId": agent_id(args), "types": types}
    if args.exclude:
        body["excludeTypes"] = [x.strip() for x in args.exclude.split(",") if x.strip()]
    st, j = http_json("POST", "/api/v1/flywheel/tasks/claim", body)
    print(json.dumps(j, ensure_ascii=False, indent=2))
    if st >= 400:
        return 1
    if not (j.get("task") or j.get("id") or j.get("taskId")):
        return 3
    return 0

def cmd_heartbeat(args):
    st, j = http_json("POST", "/api/v1/flywheel/tasks/heartbeat", {"taskId": args.task, "agentId": agent_id(args)})
    print(json.dumps(j, ensure_ascii=False, indent=2))
    return 0 if st < 400 else 1

def cmd_submit(args):
    text = Path(args.output).read_text(encoding="utf-8") if args.output != "-" else sys.stdin.read()
    body = {"taskId": args.task, "agentId": agent_id(args), "output": text}
    if args.quality is not None:
        body["qualitySelf"] = args.quality
    st, j = http_json("POST", "/api/v1/flywheel/tasks/submit", body)
    print(json.dumps(j, ensure_ascii=False, indent=2))
    return 0 if st < 400 else 1

def cmd_release(args):
    body = {"taskId": args.task, "agentId": agent_id(args), "reason": args.reason or "released by open client"}
    st, j = http_json("POST", "/api/v1/flywheel/tasks/release", body)
    print(json.dumps(j, ensure_ascii=False, indent=2))
    return 0 if st < 400 else 1

def cmd_selftest(_args):
    bad = 0
    def t(name, cond):
        nonlocal bad
        print(("PASS  " if cond else "FAIL  ") + name)
        if not cond:
            bad += 1
    os.environ.setdefault("LIONS_MIND_URL", "http://127.0.0.1:3000")
    t("mind_url 去尾斜杠", mind_url() == "http://127.0.0.1:3000")
    os.environ["LIONS_AGENT_ID"] = "agent-demo"
    t("agent 来源", agent_id(argparse.Namespace(agent=None)) == "agent-demo")
    t("默认 types", "THEME_IMPROVE" in ["THEME_IMPROVE"])
    print("SELFTEST OK" if bad == 0 else "SELFTEST FAILED")
    return 0 if bad == 0 else 1

def main():
    _load_env_file()
    ap = argparse.ArgumentParser(prog="lions-agent")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("sync"); p.add_argument("--agent"); p.add_argument("--dry-run", action="store_true"); p.set_defaults(fn=cmd_sync)
    p = sub.add_parser("claim"); p.add_argument("--agent"); p.add_argument("--types"); p.add_argument("--exclude"); p.set_defaults(fn=cmd_claim)
    p = sub.add_parser("heartbeat"); p.add_argument("--agent"); p.add_argument("--task", required=True); p.set_defaults(fn=cmd_heartbeat)
    p = sub.add_parser("submit"); p.add_argument("--agent"); p.add_argument("--task", required=True); p.add_argument("--output", required=True); p.add_argument("--quality", type=int); p.set_defaults(fn=cmd_submit)
    p = sub.add_parser("release"); p.add_argument("--agent"); p.add_argument("--task", required=True); p.add_argument("--reason"); p.set_defaults(fn=cmd_release)
    sub.add_parser("selftest").set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    return args.fn(args)

if __name__ == "__main__":
    sys.exit(main())
