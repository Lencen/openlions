# 开源治理与法务落地（LIONS）

> 对齐：《2026-10-15 产品化路线图》§1.8 与《平台手册》§12.4 开源边界。
> 审视基准：8 维清单 `packages/apps/mind/src/server/pipeline/eight-dimensions.ts`（复用既有，不另造）。

## 1 许可与法务

| 文件 | 作用 |
| --- | --- |
| `LICENSE` | **Apache-2.0** 全文（本地权威文本，非手打） |
| `NOTICE` | 版权与第三方组件声明 |
| `SECURITY.md` | 漏洞私有报告渠道 + 部署者须知（密钥/模型/提权边界） |
| `CODE_OF_CONDUCT.md` | 社区行为准则 |
| `CONTRIBUTING.md` | 贡献流程 |
| `.github/ISSUE_TEMPLATE/*`、`PULL_REQUEST_TEMPLATE.md` | 协作模板 |

## 2 开源边界（人类 2026-10-15 定稿，§12.4）

| 开源（"会学"的最小闭环） | 闭源收费（"自己动手 + 跨设备"） |
| --- | --- |
| 1 个 agent + 会话同步 + 提炼 + 反思 + 知识/经验沉淀 | macs 执行体、待办闭环、多设备协同、三方对接、商城、企业治理 |

> 依据：飞轮**不需要多个 agent** 才能转；决定"闭环到哪一步"的是 **macs 在不在**。

## 3 开源前清单（对应路线图 §1）

- [x] **8 开源治理**：密钥轮换、历史清理工具、写死路径棘轮、本治理包；**纯私有组件边界已定（B）**并机检（`open-source-boundary.json` + `check:open-source-boundary`）
- [x] 2 模型可配置：配置面 + **界面**（`console/platform/model`，D3 产品化线实现）
- [x] 3 时效 / [x] 4 去重更新：**已在库**（`expiresAt`+清扫器；`contentHash`+`supersededBy` 链），见 MEMORY-GOVERNANCE.md
- [x] 5 记忆归属字段：**已迁移**（`ownerAgentId`/`memoryScope`，只加字段；窗口协议执行 + 复验）
- [x] 6 会话源接入：`hermes_db`/`hermes_json`/`claude_jsonl`/`openclaw_jsonl`/**`codex_jsonl`** + DSH 脚本；`--selftest` 自测；`SESSION-SOURCES.md`
- [x] 7 用户视角「飞轮看得见」页面：**已实现**于 `console/flywheel/learning`（nav 可见）；开源侧可用性取决于边界决定
- [x] 9 selfimproving 技术债：类型错误 **0** + 质量门禁已恢复（完整 build 验收待发布窗口）

## 4 守门（防回归）

- `pnpm check:open-source`：① 治理文件齐备；② `LICENSE` 为 Apache-2.0 全文；③ `README` 标注 Apache-2.0；④ **无被跟踪的 `*.env`（`.example` 除外）**；⑤ **无被跟踪的数据库文件**。
- 已注册进守门 SSOT（`scripts/guard-registry.cjs`）。

## 5 8 维审视（本治理包）

1. **业务目标**：开源发布的法务/治理前置，决定"能不能开源"（§1.8）。
2. **架构**：仅仓库根标准治理文件，不改运行时代码/数据模型。
3. **模块影响**：无运行时影响；CI/守门 +1，registry 同步。
4. **业务流程**：贡献者/使用者有明确许可、报告、行为路径。
5. **数据准确**：LICENSE 取本地权威全文；守门为机检而非人眼，含形态断言。
6. **根治 vs 治标**：缺口一次性补齐 + 守门防回归（治本）。
7. **稳定/无冲突**：不碰事故 §3 热文件、不碰 DB、不重启服务。
8. **可持续**：守门进 SSOT，新增治理文件可扩展，不重复改。

## 6 待人类决定

- 已定：版权署名 **Lencen**；对外安全邮箱 **iamlencen@qq.com**（2026-11-04 人类确认）。
