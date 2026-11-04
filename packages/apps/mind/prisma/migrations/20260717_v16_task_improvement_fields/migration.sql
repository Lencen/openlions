-- 2026-07-17 V1.6 自动改进闭环 — Task 表 4 字段扩展 (lions-flywheel-v16-implementation-design.md §3.1)
-- 复用 V1 Task 表, 不新增表 (V1.6 §3.3 决策)
-- 1 任务可绑定 1 个 FlywheelReflection.id (V1.6 反思驱动)
-- 4 type 枚举: FIX_THEME / FIX_CONFLICT / MIGRATE_DATA / RE_RUN
-- improvementPayload: type 特定参数 JSON
-- rerunResult: 重跑前/后 coverage 对比 JSON (V1.6 §3.1 ⑧ 验证再跑产出)

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "improvementType" TEXT;
ALTER TABLE "Task" ADD COLUMN "improvementPayload" TEXT;
ALTER TABLE "Task" ADD COLUMN "rerunResult" TEXT;

-- CreateIndex (rerun 限流查询需要按 theme + rerunResult + updatedAt 走索引)
CREATE INDEX "Task_improvementType_idx" ON "Task"("improvementType");
CREATE INDEX "Task_rerunResult_idx" ON "Task"("rerunResult");
