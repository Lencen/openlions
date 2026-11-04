# pg/ — 安装介质里的 PostgreSQL 模板

这个目录会随安装介质复制到 <media>/pg/：

- compose.yml：默认 compose（POSTGRES_PASSWORD_FILE 读 ./pg-password）
- bundle.json.example：复制为 bundle.json 后可指定 image / port / container / volume
- LICENSE-postgresql.txt：PostgreSQL License 全文
- THIRD-PARTY-NOTICES.md：镜像/deb 再分发的第三方许可说明

安装器（lions-install --pg-bootstrap=auto）会自动：

1. 有 postgres-*.tar 时 docker load；
2. 优先 docker run（不依赖 compose 插件），没有 image 时走 compose；
3. 等 pg_isready；
4. 建角色/三库/pg_trgm；
5. 写 run/pg-urls.env。

注意：pg-password 是安装时生成的（0600），不要提交到仓库。
