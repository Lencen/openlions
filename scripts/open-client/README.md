# 开源客户端子集（非 MACS）

本目录是 LIONS 开源版的客户端**子集**，只包含：

- 会话上传：调用已有的 scripts/lions-sync.py；
- 飞轮任务：claim / heartbeat / submit / release；
- 每部署的 agent key 认证（LIONS_API_KEY）。

**不包含**：MACS 跨 agent 通信、SSE 收消息、自动回复、多设备协同——这些是闭源 MACS 的能力。

## 安装

    bash scripts/open-client/install-open-client.sh
    # 编辑 ~/.config/lions-agent/env，填 LIONS_AGENT_ID / LIONS_API_KEY

## 接入顺序

1. 在 console 的「AI 接入向导」或 lions-issue-key 领取该 agent 的 key；
2. 安装本客户端；
3. lions-agent sync --incremental 上传会话；
4. agent 执行循环：claim → 执行 → submit（长任务用 heartbeat 续租）。

不含 MACS 通信；跨 agent 消息请使用销售版 MACS。
