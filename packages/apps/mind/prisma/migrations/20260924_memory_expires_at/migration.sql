-- 2026-09-24 uos20 #7 记忆过期 expires_at 自动清理
-- 方案: docs/platform-logic/memory-expires-at-2026-09-24.md §2.1
-- 目的: 给 Memory 一个**显式到期契约**, 让"到期即归档"可被独立调度器执行, 而不是依赖写者自觉。
-- 口径: NULL = 永不过期(默认)。存量 8.6万+ 行迁移后全为 NULL, 不触发任何清扫 -> 行为不变。
--   非空且 expiresAt <= now 且 supersededBy IS NULL 的行由
--   scripts/memory-expiry-sweep.cjs 归档为 tier='COLD' + decayScore=1.0 (归档不删除, 与 memory.md §4 同口径)。

ALTER TABLE "Memory" ADD COLUMN "expiresAt" DATETIME;

-- 索引: 清扫候选 = expiresAt <= now, 无索引会全表扫 (8.6万+ 行)
CREATE INDEX "Memory_expiresAt_idx" ON "Memory"("expiresAt");
