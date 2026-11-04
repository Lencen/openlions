# Lions-Mind

🧠 认知状态管理平台 — v0.1.0-P0P1P2

## 模块

- **Reflections** (/reflections) — V3 反思（结构化字段：theme/actionType/structuredImprovements/rootCauseAnalysis/proposedPlan）
- **Memory** (/memory) — HOT/WARM/COLD 三层记忆（24h 业务去重 + contentHash 去重）
- **Knowledge** (/knowledge) — 知识图谱
- **Skills / Practice / Portfolio** — 技能/实践/作品集
- **Flywheel** (/flywheel) — 飞轮事件时间线
- **Health** (/health) — 系统健康面板
- **Auto Rotation** — 自动轮转（Reflection → Memory → Knowledge → Task）

## 共享 SDK

`packages/mind-sdk` — Node.js 客户端，给 lions-selfimproving-task 等用
- `mindClient.recall(query, options)` — 多层 recall + LRU 缓存 + in-flight dedup
- `mindClient.remember(input)` — 写记忆 + 24h 业务去重 + 5xx 指数退避重试
- `mindClient.getMetrics()` / `getMetricsSummary()` — HTTP metrics
- `mindClient.flush()` — 降级队列冲刷

## API for SDK 消费者

- `agentActivity.summary({hours})` — Recall/Remember/HOT 按 agentSource 分布
- `memory.create / list / recall` — 记忆 CRUD
- `knowledge.list` — 知识查询 (支持 search 字段)
- `reflection.list / get` — 反思查询
- `flywheel.getEvents` — 飞轮事件

## 启动

```bash
cp .env.example .env.local
npm install
npx prisma db push
npm run dev          # 端口 3000

# SDK 单测
npx tsx packages/mind-sdk/tests/client.test.ts
```

## 端口

| 环境 | 端口 | 数据库 |
|------|------|--------|
| dev | 3000 | prisma/dev.db |
| staging | 3100 | prisma/staging.db |
| prod | 3200 | prisma/prod.db |

## 版本

- v0.1.0-P0P1P2 (2026-06-06) — agent-activity router + Reflection.agentSource + SDK 10 测试通过 (重试/metrics/dedup) + 之前所有 sibling 改动
