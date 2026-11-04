# Lions-Selfimproving-Task

🦁 自我迭代任务调度平台 — v0.1.0-P0P1P2

## 模块

- **Dashboard** (/) — 飞轮状态 + 任务/问题 KPI + Agent 活跃度
- **Tasks** (/tasks) — 任务列表（状态/优先级/时间筛选）+ 详情页（Mind 同步状态 + 反思来源）
- **Problems** (/problems) — 问题池（状态/严重度筛选）+ 详情页（Mind 同步状态）
- **Health** (/health) — 10 维度 SRE 监控面板
- **Reviews** (/reviews) — 任务评审记录

## 飞轮链路

```
Mind Reflection (3000)
   ↓ pending-action-bridge
Task Scheduler (3001) ←→ Problem Resolver
   ↓ 执行
TaskCompletionTrigger → Mind Memory
   ↓ scanner (P1-1, P1-2)
Memory agentSource 标注
```

## 启动

```bash
# Dev
cp .env.example .env.local
npm install
npx prisma db push
npm run dev          # 端口 3001

# Mind SDK 单测
npx tsx tests/sdk-client.test.ts  # 待迁
```

## 端口

| 环境 | 端口 | 数据库 |
|------|------|--------|
| dev | 3001 | prisma/dev.db |
| staging | 3101 | prisma/staging.db |
| prod | 3201 | prisma/prod.db (或 PG) |

## 版本

- v0.1.0-P0P1P2 (2026-06-06) — Agent 活跃度 dashboard + 2 scanner + 详情页 Mind 同步 + 严重度/优先级/时间筛选 + SDK 10 测试通过
