-- 2026-09-22 知识库结构化整理: Knowledge 表加 domain 字段 (领域维度)
-- 方案: docs/platform-logic/knowledge-base-reorg-2026-09-22.md §3.1
-- 目的: 让知识可跨领域检索(平台机制/agent运维/环境部署/业务产品/数据模型), 规范类知识独立标记
-- 与 Memory.domain 对齐(受控枚举): platform / agent-ops / devops / product / data
--
-- ALTER TABLE 模式: 加可空列, 不影响现有行; 存量回填由 scripts/knowledge-domain-backfill.cjs 执行
--   (启发式按 category+theme+规范关键词映射, 干跑先行, --apply 幂等)

ALTER TABLE "Knowledge" ADD COLUMN "domain" TEXT;

-- 索引: 跨领域检索/规范列表(domain=platform)直接命中
CREATE INDEX "Knowledge_domain_idx" ON "Knowledge"("domain");
