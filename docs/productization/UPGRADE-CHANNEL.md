# 升级通道（渠道目录约定）

> 升级源 = 一个目录（或以后是 HTTP 基址），里面放版本清单与产物。\`lions upgrade --check\` 读它。

## 目录布局

```
<channel>/
  latest.json                      # 渠道索引：{"version":"0.2.0", ...}
  stable.json / beta.json          # 按渠道的索引（可选）
  lions-0.2.0.manifest.json        # lions-pack 产物
  lions-0.2.0.tar.gz
```

## 生成

```bash
node scripts/lions-pack.cjs --version=0.2.0 --channel=stable --out=channel/ --latest --summary="修好了 X"
```

产物：
- \`lions-0.2.0.tar.gz\`（只含 tracked 文件，**不含**数据/密钥/构建产物）；
- **默认 fail-closed**：工作区若有未跟踪的包内文件，\`lions-pack\` 拒绝打包（否则产物会静默不完整）。先提交再打包；
  本地自测可用 \`--include-untracked\`（纳入）或 \`--allow-dirty\`（明知会漏）。
- \`lions-0.2.0.manifest.json\`（schema \`lions-release-package/1\`：版本/git sha/逐文件 sha256/迁移清单/变更摘要）；
- \`latest.json\` 与 \`stable.json\`（渠道索引）。

## 消费

```bash
# 只看
node scripts/lions-upgrade.cjs --home ~/lions --check --source=file:///path/to/channel
# 升级（指定产物）
node scripts/lions-upgrade.cjs --home ~/lions --from=/path/to/channel/lions-0.2.0.tar.gz
```

## 校验与签名

- v1：强制 sha256（清单里 \`archive.sha256\` 与逐文件 sha256，\`--verify\` 可复算）。
- v1.1：增加签名；HTTP 渠道下不允许无签名。

## 版本公告（H3，2026-10-16）

打包时写入"这次修了什么"（一行摘要 + 多行说明）：
```bash
node scripts/lions-pack.cjs --version=0.2.0 --channel=stable --out=channel/ --latest \
  --summary="一句话摘要" --notes-file=docs/release-notes/0.2.0.md
```
- `--summary` → 渠道索引/清单的 `summary`（一行）；
- `--notes` / `--notes-file` → 渠道索引/清单的 `notes`（可多行，"本次说明"）。

用户侧查看公告：
```bash
node scripts/lions-upgrade.cjs --home ~/lions --check --source=file:///path/to/channel
# 显示：当前版本 / 可用版本 ← 有更新 / 本次摘要 / 本次说明
node scripts/lions-upgrade.cjs --home ~/lions --check --source=file:///path/to/channel --json
```
- `--check` 默认**人类可读**；`--json` 返回 `{current, available, updateAvailable, summary, notes}`。
- 自测：`node scripts/lions-pack.cjs --selftest`（18 断言）/ `node scripts/lions-upgrade.cjs --selftest`（6 断言）。

> 待发布窗口：把渠道目录（`latest.json` + 产物）推到一个 HTTP 基址，用户机 `--source=https://...` 即可。
