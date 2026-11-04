-- 2026-07-17 V1.5 反思引擎 — FlywheelReflection 表 (lions-flywheel-engine-v2-design.md §2.3.1)
-- 1 主题 1 条最新反思 (theme @unique)
-- 输入: 主题全文 + 该主题所有 4 类产物
-- 状态: OK / FAILED

-- CreateTable
CREATE TABLE "FlywheelReflection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "theme" TEXT NOT NULL,
    "missedTopics" TEXT NOT NULL,
    "improvements" TEXT NOT NULL,
    "coverageScore" REAL NOT NULL,
    "conflicts" TEXT,
    "productCounts" TEXT NOT NULL,
    "lastErrors" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "reportedMemoryIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "FlywheelReflection_theme_key" ON "FlywheelReflection"("theme");
CREATE INDEX "FlywheelReflection_status_idx" ON "FlywheelReflection"("status");
CREATE INDEX "FlywheelReflection_coverageScore_idx" ON "FlywheelReflection"("coverageScore");
CREATE INDEX "FlywheelReflection_updatedAt_idx" ON "FlywheelReflection"("updatedAt");
