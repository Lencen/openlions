# 会话源一键接入（"有原料，飞轮才会转"）

> 路线图 §1.6：**没有原料，飞轮在别人机器上根本转不起来。** 本页给出开源版的接入口径与一键步骤。
> 落点：会话经统一客户端上传到 session 服务（`POST {url}/api/sessions/upload`，`X-API-Key` = 你的 `lions_session` key）。

## 0 前置

1. 平台已按安装器装好，`session` 服务在跑（默认 `http://localhost:3002`）。
2. 你的 agent 已注册，并持有 `lions_session` 服务 key（平台审批勾选 `lions_session` 后签发）。
3. 本机装 `python3` + `pyyaml` + `requests`（Herrness/OpenClaw 源需要 `zstd` CLI）。

## 1 支持的数据源

| 源（config `source`） | 说明 | 默认路径 |
| --- | --- | --- |
| `hermes_db` | Hermes `state.db` | `~/.hermes/state.db` |
| `hermes_json` | Hermes 会话 JSON | `~/.hermes/sessions` |
| `claude_jsonl` | **Claude Code** 会话 | `~/.claude/projects/**/*.jsonl` |
| `codex_jsonl` | **Codex** 会话 | `~/.codex/sessions/**/*.jsonl` |
| `openclaw_jsonl` | **OpenClaw** 会话 | `~/.openclaw/agents/*/sessions/*.jsonl` |
| `DSH_SESSION`（独立脚本） | **agent-x Harness** 会话 | `~/.dsh/sessions/**` |

## 2 一键接入（统一客户端 `lions-sync.py`）

```bash
# 1) 生成默认配置（写入 ~/.config/lions-sync/config.yaml）
python3 scripts/lions-sync.py --init
# 2) 编辑 config.yaml / agents/<agent_id>.yaml，填 session_service.url 与 api_key
# 3) 先干跑看清会传什么，再增量同步
python3 scripts/lions-sync.py --dry-run
python3 scripts/lions-sync.py --incremental
python3 scripts/lions-sync.py --agent agent-operator   # 只同步指定 agent
python3 scripts/lions-sync.py --selftest              # 适配器自测（含 Codex 解析）
```

## 3 agent-x Harness（DSH）会话

```bash
python3 scripts/dsh-session-sync.py --dry-run
python3 scripts/dsh-session-sync.py --since <epoch_ms>   # 或 --session <id>
```

## 4 配置契约

- 主配置 `~/.config/lions-sync/config.yaml`：
  - `session_service.url`（默认 `http://localhost:3002`）
  - `session_service.api_key`（也可用环境变量 `LIONS_UPLOAD_API_KEYS`；**不内置默认 key**）
  - `default_source`（默认 `hermes_db`）；`agents` 留空=自动检测
- 单 agent `~/.config/lions-sync/agents/<agent_id>.yaml`：`api_key` / `sources` 等。

## 5 路径解析（开源可移植）

所有数据库路径按 `LIONS_HOME` 解析（可用 `LIONS_MIND_DB` / `LIONS_SESSION_DB` 覆盖），
**不再写死开发者机器路径**；由守门 `check:open-source` 守护。

## 6 数据源适配器与新增挂点（Codex 已支持）

1. 在 `scripts/lions-sync.py` 加一个适配器类：`__init__` 存路径、`source_type` 常量、`list_sessions(since_ts)`、`get_messages(session_id)`。
2. 在 `detect_data_source(agent_id)` 的候选列表里注册该源与路径探测。
3. `sourceId` 必须稳定（幂等去重依赖 `(agentId, source, sourceId)`）；筛选类消息走 `is_system_injection`，避免 cron/心跳污染。

## 7 8 维审视（本接入引导）

1. **业务目标**：让陌生人"有原料可接"，飞轮才可能在他机器上转（§1.6）。
2. **架构**：复用既有统一客户端与上传契约，不新增协议。
3. **模块影响**：仅 `scripts/lions-sync.py`、`scripts/dsh-session-sync.py`、本页、开源守门。
4. **业务流程**：`--init → 填 key → --dry-run → --incremental` 四步可懂可做。
5. **数据准确**：DB 路径按 `LIONS_HOME` 解析；`sourceId` 稳定保证幂等。
6. **根治 vs 治标**：既补文档，也修"写死路径"这一开源拦截项。
7. **稳定/无冲突**：默认路径与线上一致（`~/lions`），不改上传契约，不影响在跑的 cron。
8. **可持续**：新增源有固定挂点（适配器 + 注册）；路径契约集中，后续加源不改调用方。
