#!/bin/bash
# LIONS service wrapper — keeps systemd tracking a stable PID
#
# Why: Next.js 14 dev mode forks next-server, then the CLI exits.
# systemd Type=simple sees the exit and restarts.
#
# Strategy:
#   1. Start next dev as a child of this wrapper.
#   2. Poll ss -tlnp for the port to come up — extract the next-server
#      worker PID from the inode owner. (Next.js worker cmdline has
#      no port number, only "next-server (v14.2.X)", so we can't
#      pgrep by port — must go via inode → PID.)
#   3. Write that PID to a PIDFile.
#   4. `exec sleep infinity` so the wrapper is the systemd-tracked PID.
#   5. On systemd SIGTERM, kill the worker, remove PIDFile, exit.

set -e

APP_DIR="$1"
PORT="$2"
LOG_FILE="$3"
PIDFILE="$4"

if [ -z "$APP_DIR" ] || [ -z "$PORT" ] || [ -z "$LOG_FILE" ] || [ -z "$PIDFILE" ]; then
  echo "Usage: $0 <app_dir> <port> <log_file> <pidfile>" >&2
  exit 2
fi

# 2026-09-17 OOM 保护(实战根因: mind 的 next-server 曾涨到 8.5GB 被内核 OOM SIGKILL,
#   而它正在写 SQLite -> 撕裂写 -> 库反复损坏。systemd 的 OOMScoreAdjust 在本机未落到进程,
#   故在 wrapper 内直接设定: 子进程(next dev/next-server)会继承该值, 内存不足时优先杀别的进程。)

cd "$APP_DIR"

# 2026-10-10 round 72-T: 单元可选择**生产模式**(next start)。默认仍是 dev, 其它 app 行为不变。
#   为什么要这个开关: 已确认 mind 活库的 WAL 会在"干净启动后 15 秒内"被替换 => 长驻 mind 连接与磁盘
#   WAL 脱钩(孤儿化), 之后多个 WAL 世代各自 checkpoint 进同一主库 = 物理损坏。
#   最强假设: **next dev 会为编译反复 fork 短命 worker**, 每个 worker 加载应用 -> 初始化 Prisma ->
#   打开活库 -> 退出; 这种"短命进程开库后退出"若被 SQLite 判为最后一个连接, 关闭时会 checkpoint +
#   unlink 掉 -wal。生产模式没有 per-compile worker, 正好用来检验该假设。
# 2026-10-26（前端线约束）：发布面服务绝不允许开"缺构建快速失败"——
#   console / portal / session 由发布脚本保证产物；若这里也 strict，一次发布失败就会变成服务起不来，更难救。
#   这里做成硬约束：即使单元里误设 LIONS_STRICT_BUILD=1，也会被忽略并记 WARN。
APP_NAME="$(basename "$APP_DIR")"
case "$APP_NAME" in
  console|portal|session)
    if [ "${LIONS_STRICT_BUILD:-0}" = "1" ]; then
      echo "[wrapper] WARN: $APP_NAME 属于发布面，忽略 LIONS_STRICT_BUILD=1（不允许缺构建快速失败）" >> "$LOG_FILE"
      LIONS_STRICT_BUILD=0
    fi
    ;;
esac
NEXT_CMD="${LIONS_NEXT_CMD:-dev}"
if [ "$NEXT_CMD" = "start" ] && [ ! -f "$APP_DIR/.next/BUILD_ID" ]; then
  # 2026-10-26 P4: 不再默认回退 dev —— 回退会让"构建产物缺失"变成"dev 模式带病跑 + 崩循环"，
  #   外部只看到 systemd failed，真实原因埋在日志里。默认改为**快速失败**（可读的一行原因）。
  #   真要在开发机上跑，显式设 LIONS_ALLOW_DEV_FALLBACK=1。
  # 2026-10-26 修正：严格性改为**按服务选择**（LIONS_STRICT_BUILD=1 才快速失败）。
  #   原实现默认对所有服务快速失败，会让"本来靠 dev 回退在跑"的 console 直接起不来 —— 那是另一个线的服务，
  #   不该被本线的加固拖停。mind 的单元里显式设 LIONS_STRICT_BUILD=1。
  if [ "${LIONS_STRICT_BUILD:-0}" = "1" ] && [ "${LIONS_ALLOW_DEV_FALLBACK:-0}" != "1" ]; then
    echo "[wrapper] FATAL: LIONS_NEXT_CMD=start 但 ($APP_DIR/.next/BUILD_ID 缺失); 本服务启用了 LIONS_STRICT_BUILD=1，拒绝回退 dev。修复: bash scripts/build-mind-atomic.sh" >> "$LOG_FILE"
    exit 2
  else
    echo "[wrapper] WARN: LIONS_NEXT_CMD=start 但 ($APP_DIR/.next/BUILD_ID 缺失); 回退 dev（未启用 LIONS_STRICT_BUILD）" >> "$LOG_FILE"
    NEXT_CMD=dev
  fi
fi
echo "[wrapper] start port=$PORT pidfile=$PIDFILE next=$NEXT_CMD at $(date -Iseconds)" >> "$LOG_FILE"

# 2026-10-15 产品化 S0-1: 解析安装根与 next 可执行文件，**不再写死本机绝对路径**。
#   安装根优先 $LIONS_HOME，其次本脚本所在仓库根（scripts/ 的上一级）。
#   行为与旧实现一致：旧默认安装根就是 ~/lions。
WRAPPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 代码根 = 本脚本上一级（wrapper 在 <codeRoot>/scripts/）。next 可执行文件可能在 app 本地，
#   也可能在代码根的 node_modules/.bin（pnpm hoisted）。注意：不能用 LIONS_HOME —— 托管布局下
#   代码在 <home>/current（软链），node_modules 在 releases/<ver>/，不在 <home>/ 下。
CODE_ROOT="$(cd "$WRAPPER_DIR/.." && pwd)"
# 2026-10-16: 给"开库即校验世代"这道门一个**打包后路径稳定**的锚。
#   门的薄接线(src/lib/ledger-open-check.ts)会从模块自身位置向上找仓库根; 进了 Next 产物后模块位于
#   `.next/server/app/api/.../route.js` 这类深路径(实测最深到仓库根 11 层), 虽然已验证"走到文件系统根"
#   能锚到(见 scripts/acceptance/ledger-open-gate-packaged-anchor.cjs), 但**显式 env 是最稳的**:
#   它让"锚不到"这件事从"依赖路径深度"变成"配置约定"。设了也不会更坏 —— 该目录下若没有
#   scripts/lib/mind-db-open-gate.cjs, 解析会**自动落到下一个锚**(db-path/module-dir/cwd)。
: "${LIONS_REPO_ROOT:=$CODE_ROOT}"
export LIONS_REPO_ROOT
: "${LIONS_HOME:=$CODE_ROOT}"
if [ -x "$APP_DIR/node_modules/.bin/next" ]; then
  NEXT_BIN="$APP_DIR/node_modules/.bin/next"
else
  NEXT_BIN="$CODE_ROOT/node_modules/.bin/next"
fi
if [ ! -x "$NEXT_BIN" ]; then
  echo "[wrapper] FATAL: 找不到 next 可执行文件(app=$APP_DIR home=$LIONS_HOME); 先安装依赖" >> "$LOG_FILE"
  exit 1
fi

# Start the Next CLI as a child of this wrapper
"$NEXT_BIN" "$NEXT_CMD" -p "$PORT" >> "$LOG_FILE" 2>&1 &
NEXT_CLI_PID=$!

echo "[wrapper] next CLI PID=$NEXT_CLI_PID" >> "$LOG_FILE"

# Poll ss for the port — extract worker PID via inode
SERVER_PID=""
for i in $(seq 1 60); do
  # Get the inode of whoever is listening on this port
  INODE=$(ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$INODE" ]; then
    SERVER_PID="$INODE"
    break
  fi
  sleep 0.5
done

if [ -z "$SERVER_PID" ]; then
  echo "[wrapper] FATAL: no listener on port $PORT within 30s" >> "$LOG_FILE"
  kill -9 "$NEXT_CLI_PID" 2>/dev/null || true
  exit 1
fi

# Verify it's actually a next-server
WORKER_CMD=$(tr '\0' ' ' < "/proc/$SERVER_PID/cmdline" 2>/dev/null || echo "")
if [[ "$WORKER_CMD" != *"next-server"* ]]; then
  echo "[wrapper] WARNING: PID $SERVER_PID is not next-server: '$WORKER_CMD'" >> "$LOG_FILE"
fi

echo "$SERVER_PID" > "$PIDFILE"
echo "[wrapper] server PID=$SERVER_PID cmd='$WORKER_CMD' pidfile written" >> "$LOG_FILE"

# Cleanup: kill the worker on exit
cleanup() {
  echo "[wrapper] cleanup at $(date -Iseconds): killing $SERVER_PID (and children of $NEXT_CLI_PID)" >> "$LOG_FILE"
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  pkill -P "$NEXT_CLI_PID" 2>/dev/null || true
  kill -9 "$NEXT_CLI_PID" "$SERVER_PID" 2>/dev/null || true
  rm -f "$PIDFILE"
}
trap cleanup EXIT TERM INT

# Wait for the HTTP endpoint to actually respond
# 2026-09-18 修(实测假失败): 原实现 `curl -fsS .../` —— mind 没有根路由, `/` 恒为 404,
#   `-f` 让每次启动都判"未就绪"(日志固定刷一条 WARNING, 且白打 30 次请求), READY 从未为 yes。
#   改为只看"有没有 HTTP 响应": 任何状态码都说明进程已起, 只有 000(连不上)才算未就绪。
READY=no
for i in $(seq 1 30); do
  # 注意: 连接失败时 curl 也会按 -w 打出 "000" 且退出码非 0 —— 不能再 `|| echo 000`(会拼成 "000000" 被误判为"已起")。
  # 2026-10-21 Phase 2: 探针改用 /readyz（session 的 / 是重查询首页，冷 PG 下 >2s 会被误杀）
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/readyz" 2>/dev/null) || CODE=""
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
    READY=yes
    echo "[wrapper] READY on port $PORT at $(date -Iseconds) (probe / -> HTTP $CODE; 任何 HTTP 响应即视为已起)" >> "$LOG_FILE"
    break
  fi
  sleep 0.5
done

if [ "$READY" = "yes" ]; then
  : # READY 已在上面落日志(带上探针状态码, 便于区分 200/404)
else
  echo "[wrapper] WARNING: server did not respond on port $PORT within 15s" >> "$LOG_FILE"
fi

# 2026-09-10 遗留修复: 子进程看护 (SERVICE-SUPERVISION)
#   实测事故: 09-09 session:3002 与 portal:3006 的 next-server 子进程死亡, wrapper 仍 exec sleep
#   → systemd 视作 active 永不重启, 服务静默消失 ~10h; 反思 cron 因 session API 全失败而整轮 SKIP。
#   现改为轮询看护: 子进程消失 → 记录日志并 exit 1, 交给 systemd (Restart=always/RestartSec=10) 拉起。
#   同时每秒心跳检测端口监听, 端口掉线也视为死亡。
#
# 2026-09-18 修(实测根因: next-server 周期性死于 SIGBUS —— apport 崩溃档 Signal:7, ProcMaps 内含
#   mmap 的 dev.db-shm; 见 /var/crash/_usr_bin_node.1000.crash):
#   原实现 worker PID 一消失就 exit 1 交 systemd 整套重启 —— 于是**任何一次 worker 换代**
#   (Next dev 自己重启子进程、PID 变化)都会变成 10s RestartSec + 冷编译的**服务级停机**,
#   期间所有 mind 端点 0 响应, 被 5h 深检记成 5 项 FAIL(本轮 03:29/03:44/03:49 三次)。
#   改为: worker PID 消失时先确认"端口是否仍由某个 next-server 服务" —— 是则**只重绑 PID**,
#   不重启; 只有端口真的没人听才 exit 1。这样 worker 换代不再造成服务级停机。
resolve_listener() {
  ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true
}
is_next_server() {
  [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] && grep -qa "next-server" "/proc/$1/cmdline" 2>/dev/null
}
WATCH_INTERVAL=15
while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    NEWPID=""
    for i in 1 2 3 4; do
      CAND=$(resolve_listener)
      if is_next_server "$CAND"; then NEWPID="$CAND"; break; fi
      sleep 1
    done
    if [ -n "$NEWPID" ] && [ "$NEWPID" != "$SERVER_PID" ]; then
      echo "[wrapper] REATTACH at $(date -Iseconds): worker $SERVER_PID 消失, 端口 $PORT 仍由 next-server $NEWPID 服务 -> 重绑 PID, 不重启服务" >> "$LOG_FILE"
      SERVER_PID="$NEWPID"
      echo "$SERVER_PID" > "$PIDFILE"
      sleep "$WATCH_INTERVAL"
      continue
    fi
    echo "[wrapper] FATAL: server PID $SERVER_PID died 且端口 $PORT 无 next-server 监听 at $(date -Iseconds); exiting for systemd restart" >> "$LOG_FILE"
    exit 1
  fi
  if ! ss -tln 2>/dev/null | grep -q ":$PORT "; then
    # dev server 重编译瞬间端口可能抖一下: 2s 后复确认, 仍无监听才判死。
    sleep 2
    if ! ss -tln 2>/dev/null | grep -q ":$PORT "; then
      echo "[wrapper] FATAL: port $PORT no longer listening at $(date -Iseconds); exiting for systemd restart" >> "$LOG_FILE"
      kill -TERM "$SERVER_PID" 2>/dev/null || true
      exit 1
    fi
  fi
  sleep "$WATCH_INTERVAL"
done