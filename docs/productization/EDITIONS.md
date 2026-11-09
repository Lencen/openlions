# 版本与许可隔离（open / sales）

同一个打包器产两个 edition；边界单一来源是 scripts/open-source-boundary.json。

## 1 两个 edition

| edition | 内容 | 用途 |
| --- | --- | --- |
| **open** | **21 个开源包**（4 个闭源包整目录移除：MACS、mcp-server、doc-portal；portal 只保留公共页） | 开源发布 v0.4.40-open.1 |
| **sales** | 全部包（含 MACS 执行体、portal 完整页、mcp-server、doc-portal） | 销售版 |

开源版服务：mind / selfimproving / session / console / portal（公共页）。

## 2 打包

    # 开源版
    node scripts/lions-pack.cjs --edition=open --out=<dir> --summary="..."

    # 销售版
    node scripts/lions-pack.cjs --edition=sales --out=<dir>

    # 兼容旧写法
    node scripts/lions-pack.cjs --open-source --out=<dir>

打包机检：

- open：闭源前缀整目录剔除；manifest 记 edition=open 与 closedPackages；
- sales：每个闭源前缀至少有一个文件进包，缺一即拒绝；
- 渠道索引 latest.json 带 edition。

## 3 安装/升级侧

- 安装器自动识别 edition：产物含 MACS/mcp-server/doc-portal ⇒ sales，否则 open；
- 可显式 --edition=open|sales；与产物不一致即拒绝安装（fail-closed）；
- install.json 记 edition；
- 升级前比较已装 edition 与新包 edition；不一致默认拒绝，需显式 --allow-edition-change。

## 4 开源边界（2026-11-04）

开源 21：

    apps/mind, apps/session, apps/selfimproving, apps/console, apps/portal
    modules/{flywheel,knowledge,memory,pipeline,practice,product-contract,reflection,skill,task}
    core/{config,errors,events,id-gen,logger}
    configs, ui

闭源 3：

    apps/mcp-agent-chat-server   # MACS：跨 Agent 通信 / 多设备协同
    apps/mcp-server              # 对外 MCP 接口
    apps/doc-portal              # 文档门户

portal 只导出公共页（home/agents/guide/register/client/docs）；report、knowledge、daily-report、ingest 不导出。

## 5 验收

    node scripts/check-open-source-boundary.cjs --selftest
    node scripts/lions-pack.cjs --selftest
    node scripts/test-lions-pack.cjs
