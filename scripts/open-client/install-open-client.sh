#!/usr/bin/env bash
# install-open-client.sh — 开源客户端子集安装（2026-11-04）
# 只装：会话同步 + 任务 CLI；不装 MACS 跨 agent 通信/SSE。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/bin"
CFG="$HOME/.config/lions-agent"
mkdir -p "$BIN" "$CFG"
chmod +x "$HERE/lions_agent_client.py"
ln -sf "$HERE/lions_agent_client.py" "$BIN/lions-agent"
if [ ! -f "$CFG/env" ]; then
  cat > "$CFG/env" <<'EOF'
# LIONS 开源客户端配置（0600；按你的部署填写）
LIONS_MIND_URL=http://127.0.0.1:3000
LIONS_SESSION_API_BASE=http://127.0.0.1:3002
LIONS_AGENT_ID=agent-demo
# 由接入向导/claim-service-key 领取；不要提交到仓库
LIONS_API_KEY=replace-me
EOF
  chmod 600 "$CFG/env"
fi
echo "已安装: $BIN/lions-agent"
echo "配置:   $CFG/env（先填 LIONS_AGENT_ID / LIONS_API_KEY）"
echo "会话同步: lions-agent sync --incremental"
echo "任务:     lions-agent claim / heartbeat / submit / release"
