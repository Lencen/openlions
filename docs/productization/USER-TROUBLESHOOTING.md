# LIONS 多 Agent 管理系统 — 自助排障

## 1 先跑体检

    node ~/lions/current/scripts/lions-doctor.cjs --home ~/lions

逐项 ✓ / ! / ✗，并给出建议命令。加 --json 可给程序读。

## 2 生成脱敏诊断包（需要求助时）

    node ~/lions/current/scripts/lions-doctor.cjs --home ~/lions --bundle=~/lions-doctor.tar.gz
    node ~/lions/current/scripts/lions-doctor.cjs --home ~/lions --bundle=~/lions-doctor.tar.gz --yes

不加 --yes 只打印“将包含什么 / 排除什么”，不落盘。包内：

- doctor.json（检查结果）、system.txt（系统信息）、logs/*.tail（最近日志片段）；
- 不含 .env、data/、backups/、会话原文；key 值替换为 ***，家目录替换为 ~；
- 包不会自动上传，分享与否由你决定。

## 3 五个服务

    systemctl --user status \
      lions-mind lions-selfimproving lions-session lions-console lions-portal

单服务日志：

    tail -n 100 ~/lions/logs/mind.log
    tail -n 100 ~/lions/logs/console.log
    tail -n 100 ~/lions/logs/portal.log

常用操作：

    systemctl --user daemon-reload
    systemctl --user restart lions-mind
    systemctl --user restart lions-portal

## 4 常见症状与处置

| 症状 | 先做什么 |
| --- | --- |
| 某个页面打不开 | systemctl --user status lions-<app>；tail 对应日志；curl 本机端口 |
| 五个服务都不在 | systemctl --user daemon-reload；再逐个 start；看 install.json 的端口 |
| 端口被占用 | 看 ~/lions/install.json 的 ports；或重装时用 --port-* 换端口 |
| 数据库连不上 | docker ps 看 PG 容器；docker logs <container>；pg_isready；检查 .env 的 MIND_DATABASE_URL |
| 启动报 pg_trgm 不存在 | 在三个库执行 CREATE EXTENSION IF NOT EXISTS pg_trgm；或重跑 pg-bootstrap |
| 飞轮不见产出 | 检查模型 Key；看 mind.log 是否有模型调用/限流报错；看 Console 业务看板 |
| 会话不同步 | 检查 lions-agent sync 配置的 LIONS_SESSION_API_BASE / LIONS_API_KEY；先 --dry-run |
| 注册后一直 PENDING | 管理员在 Console → 智能体 → 接入审批 通过；Portal 会显示 approveUrl |
| 升级后异常 | 升级失败会自动回滚；已成功但体验差可 lions-upgrade --rollback；先看 upgrade-evidence.jsonl |
| 磁盘满 | df -h；清理 ~/lions/backups 旧副本；不要删 data/ |

## 5 关键文件

    ~/lions/install.json              # 版本/端口/dbMode/edition/服务清单
    ~/lions/current/                  # 当前代码根
    ~/lions/logs/                     # 各 app 日志、upgrade-evidence.jsonl
    ~/lions/backups/<时间戳>/         # 升级/安装备份（PG 为 <app>.sql）
    ~/lions/config/                   # install-secrets.json、签名密钥（0600）
    ~/lions/run/                      # pg-password、pg-urls.env、pid/lock

## 6 升级后检查（可复跑）

    node ~/lions/current/scripts/lions-doctor.cjs --home ~/lions
    for p in 3000 3001 3002 3004 3006; do
      curl -s -o /dev/null -w "$p:%{http_code}\n" "http://127.0.0.1:$p/"
    done

注意：mind 的健康路径是 /api/health/db，portal 是 /api/portal/guide/version，首页 200 只说明进程在。

## 7 需要提供什么给支持人员

1. lions-doctor 的终端输出（或 --json）；
2. 脱敏诊断包（可选，自己确认过内容再给）；
3. 你做了什么、期望什么、实际看到什么（三行即可）。
