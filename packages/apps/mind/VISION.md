# LIONS V2.0 愿景 — AI 共享大脑

**最后更新**: 2026-06-17
**作者**: Hermes Agent + ut (运营者)
**状态**: 业务目标已定义,核心技术栈已落地

---

## 一、愿景(北极星)

打造一个**完全自动运转的 AI 共享大脑**:

> **多个 agent (hermes/morning/thirteen/claude code 等) 共享同一个 mind(认知/记忆/知识/反思/技能/实践) + 同一个 task 引擎,自动聚类生成任务 → 解决 → 沉淀记忆 → 自我增强的认知飞轮闭环。**

全程无需人工介入(除每日抽样验收外)。

---

## 二、当前实现状态 (2026-06-17)

### 2.1 已落地 ✅

| 模块 | 状态 | 关键里程碑 |
|------|------|------------|
| **lions-mind (3000)** | ✅ 5,179 memory + 1,155 reflection | V3 反思引擎 + 11 字段结构化 + 30 个反思主题 |
| **lions-selfimproving-task (3001)** | ✅ 17,780 task + 951 V3 task | V3 聚类引擎 + TaskCluster 43 + structuredContext |
| **ws-server (3003)** | ✅ event bus 实时推送 | 5 频道: tasks/problems/executions/system/all |
| **@lions/mind-sdk** | ✅ 10/10 单测 PASS | init/recall/remember/cache/dedup/network/flush + metrics + in-flight dedup |
| **SHARED-BRAIN V2 6 大业务闭环** | ✅ 6/6 PASS | 启动加载 / 工作中 recall / 完成 remember / 降级 / dashboard / 多 agent |
| **schema 完整 (agentSource)** | ✅ 8 类来源 | HERMES_AGENT / CLAUDE_AGENT / PIPELINE_HERMES / PIPELINE_CLAUDE / TASK_RESOLVED_* / PROBLEM_RESOLVED_* / MIGRATION_HISTORICAL / MIGRATION_DUPLICATE |

### 2.2 数据规模(2026-06-17 实测)

```
mind:  5,179 memory (HOT 2638 / WARM 2467 / COLD 74)
       1,155 reflection (30 个 theme)
       951 V3 task 已生成
       43 TaskCluster 聚类

task:  17,780 task (PENDING 56 / IN_PROGRESS 1 / COMPLETED 7221 / FAILED 3258 / BLOCKED 3719 / CANCELLED 3528)
       951 V3 task (100% 带 structuredContext)
       247 problem (65 ABANDONED + 182 SOLVED)
```

### 2.3 已知未做(P3+ 长期任务,见 SHARED-BRAIN-V2-P3-REPORT §六)

- API 认证(两系统都 publicProcedure)
- FlywheelEvent 跨系统统一
- embedding 语义搜索
- tier 自动晋升 cron
- 跨 agent 共识协议

---

## 三、关键设计决策

### 3.1 双系统而非单系统

- Lions-Mind = 认知层(记忆/知识/反思/技能/实践/学习/作品集)
- Lions-Task = 执行层(任务/问题/调度/评审/质量门禁)
- 通过 HTTP + tRPC + agent-activity 联动

### 3.2 SQLite 而非 PostgreSQL

- 单机部署,Prisma 5.22
- WAL 模式,5000+ flywheel event + 5000+ memory OK
- 长期可平滑迁移 PostgreSQL

### 3.3 24h 业务去重 + sha256 contentHash

- 应用层去重,不用 DB unique
- 避免 3667 历史重复数据冲突
- 跨 agent 不互去重

### 3.4 tRPC v11 input 包装兼容

- 客户端发 `?input={"json":{...}}`
- 服务端 zod preprocess 拆包装
- 同步支持 v10 v11 client

---

## 四、相关文档

- 设计: `docs/SHARED-BRAIN-V2-DESIGN.md`
- P0 报告: `docs/SHARED-BRAIN-V2-P0-REPORT.md`
- P1 报告: `docs/SHARED-BRAIN-V2-P1-REPORT.md`
- P2 报告: `docs/SHARED-BRAIN-V2-P2-REPORT.md`
- **P3 报告**: `docs/SHARED-BRAIN-V2-P3-REPORT.md` ← 6/17 最新
- V3 反思引擎: `hermes work/docs/LIONS-REFLECTION-ENGINE-V3.md`
- 飞轮 V2: `docs/SELF-IMPROVING-FLYWHEEL-V2.md`

---

## 五、git tag 索引

| 项目 | 最新 tag | 含义 |
|------|----------|------|
| lions-mind | v0.3.4-shared-brain-p3-report | SHARED-BRAIN V2 P3 验收 + P3-9 真 bug fix |
| lions-selfimproving-task | v0.3.3-task-ws-server-port-fix | ws-server 端口冲突 fix |
| mind-sdk | (在 packages/mind-sdk) | v1.0.0 |

---

**业务目标 = 多 agent 共享同一大脑。已落地,持续优化。**
