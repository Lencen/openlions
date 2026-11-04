# PostgreSQL 随介质分发（用户指南）

LIONS 开源版要求 PostgreSQL。安装介质可以自带 PostgreSQL，用户不必先在系统里装 PG。

## 1. 介质布局

    <media>/
      this file is part of the open-source repo: pg/
      compose.yml
      bundle.json            # 可选；给出 mode/port/user/dbs/image
      postgres-16-alpine.tar # 可选；docker save 的镜像
      deb/*.deb              # 可选；离线 apt 包
      LICENSE-postgresql.txt
      THIRD-PARTY-NOTICES.md
      pg-password            # 安装器生成（0600），不要提交

## 2. 三种交付方式

### A. Docker / docker run（推荐）

    # 介质里放 compose.yml + 可选镜像 tar
    # 安装：
    node scripts/lions-install.cjs --from=<media> --home=~/lions --pg-bootstrap=compose

安装器会：

1. 有 postgres-*.tar 时先 docker load；
2. 没有现成 PG 时用 docker run 起一个（不依赖 compose 插件）；
3. 用容器内 pg_isready 等就绪；
4. 建角色、lions_mind / lions_session / lions_selfimproving 三库；
5. 每个库执行 CREATE EXTENSION IF NOT EXISTS pg_trgm；
6. 把三个 URL 写入 run/pg-urls.env（0600）。

数据在 Docker named volume（默认 lions-pgdata-<port>）。升级/备份用 pg_dump；卸载默认不删 volume。

### B. 离线 deb（需要 root）

    node scripts/lions-install.cjs --from=<media> --home=~/lions --pg-bootstrap=deb

deb 方式用 sudo -n apt-get install；没有免密 sudo 会报错并打印手工命令，不会挂起等密码。

### C. 已有 PostgreSQL

    node scripts/lions-install.cjs --from=<media> --home=~/lions --pg-bootstrap=off

并设置：

    MIND_DATABASE_URL=postgresql://lions:***@127.0.0.1:5432/lions_mind
    SESSION_DATABASE_URL=postgresql://lions:***@127.0.0.1:5432/lions_session
    SELFIMPROVING_DATABASE_URL=postgresql://lions:***@127.0.0.1:5432/lions_selfimproving

已有 PG 必须支持 pg_trgm：

    CREATE EXTENSION IF NOT EXISTS pg_trgm;

## 3. 只验证、不安装

    node scripts/pg-bootstrap.cjs --media=<media> --plan
    node scripts/pg-bootstrap.cjs --probe

## 4. 备份与恢复

    docker exec <container> pg_dump -U postgres -d lions_mind > lions_mind.sql
    docker exec <container> pg_dump -U postgres -d lions_session > lions_session.sql
    docker exec <container> pg_dump -U postgres -d lions_selfimproving > lions_selfimproving.sql

恢复：

    cat lions_mind.sql | docker exec -i <container> psql -U postgres -d lions_mind

升级前建议先做一次三库备份。

## 5. 许可

- PostgreSQL 本体：PostgreSQL License（宽松，允许再分发），全文见 [LICENSE-postgresql.txt](../../pg/LICENSE-postgresql.txt)。
- Docker 镜像（若随介质分发）：还包含 Alpine/Debian 基础包（如 BusyBox GPLv2、musl MIT、OpenSSL Apache-2.0）。
  分发镜像 tar 时需随包提供第三方许可/NOTICE，并对 GPL/LGPL 组件提供源码获取方式。
- deb 方式：保留各包的 /usr/share/doc/<pkg>/copyright。
- 商标：可以指名性说明“内置 PostgreSQL”，不要用 PostgreSQL logo 做产品名或暗示官方背书。

第三方组件说明见 [THIRD-PARTY-NOTICES.md](../../pg/THIRD-PARTY-NOTICES.md)。
