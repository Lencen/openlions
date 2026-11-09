# 升级 LIONS 多 Agent 管理系统

> 升级会：先备份数据库 → 暂停服务 → 安装新版本 → 迁移/建库 → 构建 → 启动 → 健康检查。
> 失败会尝试自动回滚：恢复数据库、切回旧版本、重启服务；回滚结果写入升级证据。

## 1 先看有没有新版本

    node ~/lions/current/scripts/lions-upgrade.cjs \
      --home ~/lions \
      --check \
      --source=file:///你的/升级源目录

输出包含 current / available / updateAvailable。

## 2 升级（推荐先 dry-run）

    # 只读预检：不动代码、不动库
    node ~/lions/current/scripts/lions-upgrade.cjs \
      --home ~/lions \
      --from=/path/to/lions-0.4.40.tar.gz \
      --dry-run

    # 真正升级
    node ~/lions/current/scripts/lions-upgrade.cjs \
      --home ~/lions \
      --from=/path/to/lions-0.4.40.tar.gz

升级从**安装介质**取新版本；PostgreSQL 数据目录不随升级重建。
如果本次升级同时要换 PostgreSQL（例如换镜像/大版本），先单独按 PG 文档做备份与迁移。

## 3 升级做了什么

1. 读取 ~/lions/install.json，确认当前版本、端口、dbMode、edition；
2. 用 pg_dump 备份 mind / session / selfimproving 三个库到 ~/lions/backups/<时间戳>/；
3. 停服务，解包新版本到 releases/<version>；
4. 安装依赖 → Prisma generate → schema 检查/建库 → 构建；
5. 切换 current 软链，写新 .env，启动 5 个 systemd --user 服务；
6. 健康检查；任一失败进入回滚路径。

## 4 升级后检查

    node ~/lions/current/scripts/lions-doctor.cjs --home ~/lions
    systemctl --user is-active lions-mind lions-selfimproving lions-session lions-console lions-portal
    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health/db
    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3006/api/portal/guide/version

## 5 出问题怎么办

- 升级失败自动回滚：日志出现 ROLLED_BACK_OK 表示已回到升级前；
- 证据：~/lions/logs/upgrade-evidence.jsonl（UPGRADED_OK / ROLLED_BACK_OK / ROLLBACK_FAILED）；
- 数据库备份：~/lions/backups/<时间戳>/<app>.sql（PG 逻辑备份，带 sha256）；
- 手动回滚到指定备份：

    node ~/lions/current/scripts/lions-upgrade.cjs --home ~/lions --rollback
    # 或指定备份目录
    node ~/lions/current/scripts/lions-upgrade.cjs --home ~/lions --rollback --backup=~/lions/backups/<时间戳>

- 回滚后仍不健康：先跑 lions-doctor，再生成脱敏诊断包，见 [USER-TROUBLESHOOTING.md](USER-TROUBLESHOOTING.md)。

## 6 升级源目录

最小形态：

    channel/
      latest.json
      lions-0.4.40.manifest.json
      lions-0.4.40.tar.gz

也可以直接用发布介质 tar.gz 作为 --from。渠道说明见 [UPGRADE-CHANNEL.md](UPGRADE-CHANNEL.md)。

## 7 注意

- 升级前确认磁盘至少留出“当前版本体积 + 备份”空间；
- 不要手改 install.json；它是升级/回滚/体检的共同事实源；
- 升级期间不要并发跑安装器或手工切换 current。
