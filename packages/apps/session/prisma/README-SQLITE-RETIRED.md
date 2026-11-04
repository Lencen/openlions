# SQLite 已退役（2026-10-26）

本目录的 `dev.db` 已于 **2026-10-26** 退役（P1 止血）：

- 原库（7,310,041,088 字节）已移至**外置盘**：
  `/media/operator/数据/系统盘迁移/261102/session-legacy.db`
  （2026-11-02 复核：页数 × 页大小与文件大小精确一致，结构完好）。
  仓库内 `backups/legacy-sqlite/session/dev.db` **不存在** —— 旧文档写的位置不实，已在 261102 目录留 MANIFEST；
- 原地保留 **0 字节占位**，任何仍尝试打开它的代码都会**当场失败**，而不是静默读旧数据；
- 线上唯一数据源是 PostgreSQL 的 `lions_session`（`MIND_DB_DRIVER=pg` / `SESSION_DB_DRIVER=pg` / `SELFIMPROVING_DB_DRIVER=pg`）。

## 为什么要这样做

只要路径还能打开，定时任务/验收脚本就会反复读旧库，把 page cache 挤出去，并且迁移缺口无人发现。
退役后失败是**显式**的，修起来有方向。

## 需要旧数据怎么办

仅限**离线取证/复算**，不要在生产路径原地恢复：

```bash
# 复制到临时位置再用（不要覆盖本目录的 0 字节占位）
cp backups/legacy-sqlite/session/dev.db /tmp/session-legacy.db
sqlite3 -readonly /tmp/session-legacy.db "pragma quick_check"
```

生产恢复必须走 PG 备份（`scripts/backup-pg.sh`），不是这个文件。

## 证据

- 交接：`verification/HANDOFF-SQLITE-RETIREMENT-2026-10-26.md`
- 验收：`verification/SQLITE-RETIREMENT-2026-10-26.md`
- 禁止回潮：`node scripts/check-sqlite-retired.cjs`

## 2026-10-26 补充：占位文件已设不可写

- chattr +i 已施加到 0 字节占位（防旧脚本把库写回来）。实测写入返回
  SQLITE_READONLY: attempt to write a readonly database。
- 恢复/取证前先解除：sudo chattr -i packages/apps/<app>/prisma/dev.db；
  恢复后如仍要维持退役，再 sudo chattr +i ...。
- worktree 的 prisma/dev.db 也已清零/软链到 0 字节并做同样处理；
  巡检：node scripts/check-worktree-sqlite.cjs --strict。
