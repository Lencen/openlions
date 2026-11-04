# 模型配置（用户自带 key / 自部署模型）

> **平台不提供大模型额度、不代付**；"数据不出户"是否成立，取决于你是否使用**自持 key** 或**自部署模型**（见《平台手册》§12.3）。
> 本页是模型配置的单一权威口径；改配置契约时改这里。

## 1 契约（代码实际读取的键）

| 键 | 作用 | 备注 |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | 模型服务 base URL（Anthropic 协议） | 自部署/中转/兼容网关填这里 |
| `ANTHROPIC_AUTH_TOKEN` | 模型服务 key | 飞轮调用用它署名 |
| `ANTHROPIC_MODEL` | 模型名 | |
| `MINIMAX_API_KEY` | MiniMax 原生 key | 走 MiniMax 时用 |
| `REFLECT_MODEL` | 反思引擎单独模型 | 可空，空则用默认 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI 协议（兼容） | 视代码路径支持 |

> 以上键写进各 app 的 `.env`（0600）。安装器**不会**写任何默认 key。

## 2 三种配置方式

### 方式 A：安装时 CLI 直传（推荐）
```bash
node scripts/lions-install.cjs --from=/path/to/lions-<ver>.tar.gz --home=~/lions \
  --model-provider=minimax \
  --model-key=<你的 key> --model-name=<模型名>
# 支持 --k=v 与 --k v 两种形式（D8）；--model-base-url 可覆盖默认
```

### 方式 B：answers 文件
```json
{ "ANTHROPIC_BASE_URL": "https://api.minimax.chat/v1", "ANTHROPIC_AUTH_TOKEN": "你的 key", "ANTHROPIC_MODEL": "你的模型名" }
```
```bash
node scripts/lions-install.cjs --from=<tar> --home=~/lions --answers=/tmp/answers.json
```

### 方式 C：直接编辑已安装的 `.env`
编辑 `~/lions/current/packages/apps/mind/.env` 与 `.../selfimproving/.env`，加入第 1 节的键，然后重启对应服务。

### 方式 D：控制台界面（console `/platform/model`，D3）

- 菜单「平台管理 → 模型配置」；GET `/api/model-config` 返回**掩码**后的已配置值，POST 写回各 app 的 `.env`（0600）。
- 保存后**需重启 `lions-mind` / `lions-selfimproving` 生效**；界面不显示明文。
- 纯逻辑在 `packages/apps/console/src/lib/server/model-config.ts`，自测 `pnpm check:model-config`（7 断言）。

## 3 provider 约定

- `--model-provider=anthropic`（默认）：未给 base URL 时用 `https://api.anthropic.com`。
- `--model-provider=minimax`：同时补 `MINIMAX_API_KEY`，未给 base URL 时用 `https://api.minimax.chat/v1`。

## 4 体检

`node scripts/lions-doctor.cjs` 的「模型配置」项：已配置显示 `ok`（值不显示），未配置显示 `warn` 并提示配置方式。

## 5 诚实边界（必须如实表达）

- 只有**飞轮的模型调用**会把（提炼/反思用的）会话内容发到**你配置的模型服务**；这就是"数据不出户"的前提。
- 不开源/未配模型时：飞轮不调用外部模型（不会学），平台仍可运行；不存在"悄悄用我们额度"的路径。
- 向量检索（开源后迭代）也走你的模型：**没有向量也必须能用**（全文+主题保底），这是对用户成本友好的宣传点。
