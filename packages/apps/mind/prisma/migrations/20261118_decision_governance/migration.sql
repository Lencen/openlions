-- 2026-11-18 0.6.3 U-19/U-20 决策治理：三表（决策事项 / 8 维分析 / 落地追踪）
-- 口径：DecisionAnalysis8D 对同一决策恰好 8 行、dimension 唯一（判据 check-decisions.cjs C5 强制；DB 层用唯一键兜底）
-- 只新增表，不改既有表（PG；sqlite 侧由 schema.prisma + db push 生成）

CREATE TABLE "DecisionItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DecisionAnalysis8D" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionAnalysis8D_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DecisionOutcome" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "owner" TEXT,
    "dueAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'todo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DecisionAnalysis8D_decisionId_dimension_key" ON "DecisionAnalysis8D"("decisionId", "dimension");
CREATE INDEX "DecisionAnalysis8D_decisionId_idx" ON "DecisionAnalysis8D"("decisionId");
CREATE INDEX "DecisionItem_status_idx" ON "DecisionItem"("status");
CREATE INDEX "DecisionItem_createdAt_idx" ON "DecisionItem"("createdAt");
CREATE INDEX "DecisionOutcome_decisionId_idx" ON "DecisionOutcome"("decisionId");
CREATE INDEX "DecisionOutcome_status_idx" ON "DecisionOutcome"("status");

ALTER TABLE "DecisionAnalysis8D" ADD CONSTRAINT "DecisionAnalysis8D_decisionId_fkey"
  FOREIGN KEY ("decisionId") REFERENCES "DecisionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionOutcome" ADD CONSTRAINT "DecisionOutcome_decisionId_fkey"
  FOREIGN KEY ("decisionId") REFERENCES "DecisionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 权限：三表由 owner 角色创建，应用角色（lions_app）需显式授权，
--   否则 information_schema 会按权限过滤 -> prisma-schema-drift-guard 误报「表不存在」（2026-11-18 实测）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lions_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "DecisionItem","DecisionAnalysis8D","DecisionOutcome" TO lions_app';
  END IF;
END $$;

