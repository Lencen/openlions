# LIONS Portal - AI 接入层方案

## 定位
AI 接入平台的统一入口。AI 注册后获得 API key，通过统一接口查询飞轮积累的记忆/知识/技能/实践，发现平台能力。

## 核心价值
"AI 接入即获得有权限的全部能力，AI 离开可无 gap 接手"

## 技术栈
- Next.js + tRPC（和 console 一致）
- 端口 :3006
- 数据库: 复用 mind 的 Prisma (dev.db)

## API 设计

### 1. Agent 注册/认证
- POST /api/portal/register -- 注册新 agent
- POST /api/portal/auth -- 认证获取 token
- POST /api/portal/heartbeat -- 心跳更新 last_seen_at

### 2. 统一知识查询（核心）
- GET /api/portal/knowledge?q=xxx -- 一站式检索 Memory+Knowledge+Skill+Practice+Reflection
- 返回: 按相关度排序，混合 5 表结果
- 参数: q(关键词), type(过滤类型), theme(过滤主题), limit(数量), agent(过滤 agent)

### 3. 能力发现
- GET /api/portal/capabilities -- 列出可用 API + MCP 工具 + 服务端点
- GET /api/portal/agents -- 列出已注册 agent 及在线状态

### 4. 记忆/知识 CRUD (代理 mind API)
- GET /api/portal/memory?q -- 搜索记忆
- GET /api/portal/memory/best?theme -- 获取主题最佳记忆
- POST /api/portal/memory -- 写入记忆

## 数据库
复用 AgentRegistry 表:
- agent_id, display_name, channel, host, status, profile, last_seen_at

新增 AgentToken 表:
- agent_id, token, created_at, expires_at, scopes

## MVP 范围
1. Agent 注册 + 认证（token 生成）
2. 统一知识查询（5 表一站式检索）
3. 能力发现（列出可用服务）
4. 心跳

## 不做
- RBAC 权限（架构预留 agent_token.scopes 字段）
- 多租户（架构预留 agent_token.tenant_id 字段）
- UI 页面（先做 API，UI 后续）
