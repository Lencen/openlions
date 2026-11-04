-- 2026-10-09 round 72-D: Practice 升级为一等产物 + K/M/S 反向引用
-- 人类裁决(2026-10-09): "我们是不是可以改成这样: 会话内容先整理成实践比较好... 实践中发现的遗留改进
--   进改进任务自动处理"。本迁移是这套架构的**地基**(schema 层), 不改任何现有行。
--
-- 背景(实测): Practice 现在只有 title/description/outcome/difficulty ——
--   没有"经验与教训"、没有"关联任务"、没有"产出"、没有"遗留改进";
--   而关联表 PracticeKnowledgeLink 只有 **1 行**、PracticeUsedMemoryLink **不存在**。
--   于是 83-98% 的数据 use=0: 产出来但没人(也没机制)能把它接回"哪次实践用过它"。
--
-- 改动:
--   1) Practice 加 4 列: taskRef / lesson / outputs / leftovers(全可空, 现有 56,569 行不受影响)
--   2) K/M/S 各加 sourcePracticeId(可空): 反向指回产出它的 Practice
--   3) Skill 加 referencedKnowledgeIds(可空): 技能引用了哪些知识(JSON 数组)
--   4) 新表 PracticeUsedMemoryLink: 实践用到了哪些记忆(**现有的最大空洞**)
--      role 字段: used_to_resolve / derived_from / context_of ... 由 LLM 自填
--
-- 注意: createTime 不设默认值, 由 Prisma @default(now()) 在应用层填; 但 SQLite 直连插入需要默认值,
--   故这里给 PracticeUsedMemoryLink.createdAt 加 DB 级默认(与 Memory.createdAt 的既有做法一致)。

ALTER TABLE "Practice" ADD COLUMN "taskRef"   TEXT;
ALTER TABLE "Practice" ADD COLUMN "lesson"    TEXT;
ALTER TABLE "Practice" ADD COLUMN "outputs"   TEXT;
ALTER TABLE "Practice" ADD COLUMN "leftovers" TEXT;

ALTER TABLE "Memory"    ADD COLUMN "sourcePracticeId" TEXT;
ALTER TABLE "Knowledge" ADD COLUMN "sourcePracticeId" TEXT;
ALTER TABLE "Skill"     ADD COLUMN "sourcePracticeId" TEXT;
ALTER TABLE "Skill"     ADD COLUMN "referencedKnowledgeIds" TEXT;

CREATE INDEX IF NOT EXISTS "Memory_sourcePracticeId_idx"    ON "Memory"("sourcePracticeId");
CREATE INDEX IF NOT EXISTS "Knowledge_sourcePracticeId_idx" ON "Knowledge"("sourcePracticeId");
CREATE INDEX IF NOT EXISTS "Skill_sourcePracticeId_idx"     ON "Skill"("sourcePracticeId");

CREATE TABLE IF NOT EXISTS "PracticeUsedMemoryLink" (
  "practiceId" TEXT NOT NULL,
  "memoryId"   TEXT NOT NULL,
  "role"       TEXT,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PracticeUsedMemoryLink_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PracticeUsedMemoryLink_memoryId_fkey"   FOREIGN KEY ("memoryId")   REFERENCES "Memory" ("id")   ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("practiceId", "memoryId")
);
CREATE INDEX IF NOT EXISTS "PracticeUsedMemoryLink_memoryId_idx" ON "PracticeUsedMemoryLink"("memoryId");
