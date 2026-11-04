-- 2026-10-09 round 72: 给 K/P/Skill 加 tier 列 + 给 Memory 加 scenario/standard 列
-- 背景: 人类裁决「只降权不删除」(round 72-E 已对 Memory 写库 15,035 行);
--   K/P/Skill 当时**没有** tier 列, 本轮 schema 补上让 downweight 脚本能落库。
--   Memory 的 scenario/standard 是人类裁决「Memory 不写长数据, 要加结构化辅助字段」的具体落点。
--
-- 方案: 加可空/tier 三个有默认值的列; 不影响现有行(全填默认值)。
--   索引: tier 已有 @@index (Memory), 给 K/P/Skill 也加(列表过滤常用)。
--   注: tier 用 String 而非 enum —— "WARM/COLD/DEEP_COLD" 三档 + 未来可能加"NEVER"(用户永远排除);
--   enum 在 sqlite 下是个 check constraint, 改成 String 更灵活且迁移成本低。

ALTER TABLE "Knowledge" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'WARM';
CREATE INDEX IF NOT EXISTS "Knowledge_tier_idx" ON "Knowledge"("tier");

ALTER TABLE "Practice"  ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'WARM';
CREATE INDEX IF NOT EXISTS "Practice_tier_idx"  ON "Practice"("tier");

ALTER TABLE "Skill"     ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'WARM';
CREATE INDEX IF NOT EXISTS "Skill_tier_idx"     ON "Skill"("tier");

-- Memory 已有 tier 列(line 87); 只加 scenario/standard 两个可空结构化字段
ALTER TABLE "Memory"    ADD COLUMN "scenario" TEXT;
ALTER TABLE "Memory"    ADD COLUMN "standard" TEXT;
