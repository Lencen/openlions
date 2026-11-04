-- 2026-09-15 f-002 提案落地: Knowledge 表加 contentType 字段 (KNOWLEDGE / SOP / RUNBOOK)
-- 提案: Knowledge cmtwtf1cd05ti1j76genllwms (挑战 f-002) + Reflection cmu2rrylk003722n2rxtz2jhf
-- 目的: 区分陈述性知识 vs 紧急恢复步骤, 让 runbook 类内容不再污染 Knowledge 主题内去重与语义检索
-- 默认值 KNOWLEDGE (兼容历史); SOP=标准化操作程序; RUNBOOK=紧急恢复手册 (建议转入 runbook 文档/Skill)
--
-- ALTER TABLE 模式: 加可空 + 默认值, 不影响现有行; 老行 contentType=NULL, Prisma 默认 KNOWLEDGE 兜底

ALTER TABLE "Knowledge" ADD COLUMN "contentType" TEXT DEFAULT 'KNOWLEDGE';

-- 索引: 让 reconcile-findings 在 RUNBOOK 排除时能直接命中
CREATE INDEX "Knowledge_contentType_idx" ON "Knowledge"("contentType");
