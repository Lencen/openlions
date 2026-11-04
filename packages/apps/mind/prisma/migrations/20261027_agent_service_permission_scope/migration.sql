-- 2026-10-27 K 第一步: AgentServicePermission（授权表 = "key 表"）加 scope
--
-- 业务口径（docs/practices/2026-10-26-macs-key-lifecycle-and-approval-8dim.md §1/§4）:
--   scope ∈ {agent, admin}；**无值视为 agent** —— 保证今天所有 key 继续可用（红线: 不能一刀切）。
--   agent = 只收发自己线上的消息（daily_messaging）；
--   admin = 可开线/发凭证/改归属/看全局/代发系统通知，必须人工审批。
--
-- 为什么可空而不给默认值: 存量 55 行没有 scope，给 DEFAULT 'agent' 会把"未分类"永久固化成
--   "已分类"，之后无法区分"历史遗留"与"明确授予 agent"。NULL 保留语义，读取侧一律按 agent 解释。
--
-- 写入边界: 这一列由 MACS 的 key 生命周期负责写（审批/续期），平台只建行。
-- 时间口径坑: 本表 Prisma 写入的是 UTC（timestamp 无时区列里存 UTC 值），
--   而 MACS 自己的库存本地时间；比较/写入必须用 (now() AT TIME ZONE 'UTC')。

ALTER TABLE "AgentServicePermission" ADD COLUMN "scope" TEXT;

CREATE INDEX "AgentServicePermission_scope_idx" ON "AgentServicePermission"("scope");
