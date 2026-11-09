# 安装 LIONS 多 Agent 管理系统

> 面向第一次接触 LIONS 的人。**平台不提供大模型额度**：你需要自备 API Key，或接入自部署模型。
> 支持环境：**Linux + systemd --user + Node 20+**；PostgreSQL 16（可由安装介质自带）。

## 1. 你需要准备什么

- 一台 Linux 机器（建议 4 核 / 8GB 内存 / 10GB 可用磁盘）；
- Node.js 20 或更高版本；
- 一个模型服务 API Key（MiniMax / Anthropic 兼容 / 自部署）；
- 安装介质：lions-0.4.36.tar.gz，以及可选的 pg/ 目录（自带 PostgreSQL）。

介质目录长这样：

    /path/to/media/
      VERSION
      packages/
      scripts/
      pg/                 # 可选：自带 PostgreSQL
        compose.yml
        bundle.json
        LICENSE-postgresql.txt
        THIRD-PARTY-NOTICES.md
        postgres-16-alpine.tar   # 可选：离线镜像
        deb/*.deb                # 可选：离线 apt 包

没有 pg/ 时，安装器会要求你提供已有的 PostgreSQL 连接串。

**用已有 PostgreSQL 时，每个库必须有 `pg_trgm` 扩展**（Prisma schema 的 GIN 索引需要 `gin_trgm_ops`）。
安装器在预检阶段会检查并尝试自动创建；若你的账号没有建扩展权限，请先用有权限的账号执行：

    CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- 对 mind / session / selfimproving 三个库各执行一次

## 2. 一条命令安装

    mkdir -p "$HOME/lions-media"
    tar -xzf lions-0.4.36.tar.gz -C "$HOME/lions-media"

    node "$HOME/lions-media/scripts/lions-install.cjs" \
      --from="$HOME/lions-media" \
      --home="$HOME/lions" \
      --edition=open \
      --pg-bootstrap=auto

安装器会：

1. 若介质带 pg/：docker load（有镜像 tar 时）→ 起 PostgreSQL → 建角色/三库 → 建 pg_trgm；
2. 生成本部署专属 bootstrap/admin key 与 Ed25519 客户端签名密钥（0600）；
3. 写入 5 个服务的 .env（mind / selfimproving / session / console / portal）；
4. 安装依赖 → Prisma generate → db push → 构建 → 启动 systemd --user 服务；
5. 健康检查 → 写 install.json。

### PG 引导开关

    # 自动：介质里有 pg/ 才引导（默认）
    --pg-bootstrap=auto

    # 强制 compose / deb
    --pg-bootstrap=compose
    --pg-bootstrap=deb

    # 已有 PostgreSQL，自己做
    --pg-bootstrap=off
    # 并用环境变量提供三个 URL：
    # MIND_DATABASE_URL / SESSION_DATABASE_URL / SELFIMPROVING_DATABASE_URL

    # 只看计划，不启动 PG、不装包、不建库
    --dry-run

### 已有 PostgreSQL

    export MIND_DATABASE_URL=postgresql://lions:***@127.0.0.1:5432/lions_mind
    export SESSION_DATABASE_URL=postgresql://lions:***@127.0.0.1:5432/lions_session
    export SELFIMPROVING_DATABASE_URL=postgresql://lions:***@127.0.0.1:5432/lions_selfimproving

    node "$HOME/lions-media/scripts/lions-install.cjs" \
      --from="$HOME/lions-media" --home="$HOME/lions" \
      --edition=open --pg-bootstrap=off

## 3. 默认端口

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| mind | 3000 | 认知核心 / 飞轮 / API |
| selfimproving | 3001 | 改进任务引擎 |
| session | 3002 | 会话接入 |
| console | 3004 | 人类管理台 |
| portal | 3006 | 开发者门户 |

端口冲突时：

    --port-mind=3100 --port-selfimproving=3101 --port-session=3102 \
    --port-console=3104 --port-portal=3106

## 4. 装完检查

    node ~/lions/current/scripts/lions-doctor.cjs --home ~/lions

打开：

- Console: http://127.0.0.1:3004
- Portal: http://127.0.0.1:3006

## 5. 接入第一个 Agent

### 5.1 管理员路径（推荐）

Console → 智能体 → AI 接入向导：

1. 填 agent_id / 显示名 / channel / host；
2. 勾选 lions_mind、lions_session；
3. 提交后拿到一次性 claim ticket。

Agent 换正式 key：

    curl -X POST http://127.0.0.1:3000/api/v1/agent/claim-service-key \
      -H 'content-type: application/json' \
      -d '{"agent_id":"agent-demo","ticket":"sk-claim-..."}'

### 5.2 Portal 自助注册

Portal → Agent 注册，提交后进入 PENDING。管理员在 **Console → 智能体 → 接入审批**
通过后，页面会显示一次性领取券；Agent 用上面的 claim-service-key 换取正式 key。

> 开源版只 seed 了 lions_mind / lions_session 两条服务；MCP 跨 Agent 通信不在开源范围。

## 6. 装开源客户端子集

    bash ~/lions/current/scripts/open-client/install-open-client.sh

编辑 ~/.config/lions-agent/env：

    LIONS_MIND_URL=http://127.0.0.1:3000
    LIONS_SESSION_API_BASE=http://127.0.0.1:3002
    LIONS_AGENT_ID=agent-demo
    LIONS_API_KEY=sk-mind-...

上传会话 / 参与任务：

    lions-agent sync --incremental
    lions-agent claim --agent agent-demo --types THEME_IMPROVE
    lions-agent heartbeat --agent agent-demo --task <taskId>
    lions-agent submit --agent agent-demo --task <taskId> --output result.md

## 7. 数据与隐私

- 所有数据都在你自己的机器上（~/lions/data/），平台不上传；
- 只有飞轮的模型调用会带会话内容发给**你自己配置的模型服务**；
- 诊断包默认脱敏且需你确认才生成，不会自动上传。

## 8. 升级 / 卸载

    # 升级（先 dry-run）
    node ~/lions/current/scripts/lions-upgrade.cjs --home ~/lions --from=<新介质> --dry-run
    node ~/lions/current/scripts/lions-upgrade.cjs --home ~/lions --from=<新介质>

    # 卸载（默认 dry-run；数据默认保留）
    node ~/lions/current/scripts/lions-uninstall.cjs --home ~/lions
    node ~/lions/current/scripts/lions-uninstall.cjs --home ~/lions --apply --yes

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| 缺 pnpm | corepack enable；或 corepack prepare pnpm@9.15.9 --activate |
| PG 起不来 | 看 ~/lions/logs/ 与 docker logs；或改用已有 PG + --pg-bootstrap=off |
| 端口被占用 | 用 --port-* 换端口后重跑安装 |
| 服务没起来 | node ~/lions/current/scripts/lions-doctor.cjs --home ~/lions |
| 登录/页面 502 | 检查 LIONS_MIND_URL 与 3000 服务；不要写死内网地址 |

更细的排障见 [USER-TROUBLESHOOTING.md](USER-TROUBLESHOOTING.md)；PG 介质说明见 [PG-MEDIA.md](PG-MEDIA.md)。
