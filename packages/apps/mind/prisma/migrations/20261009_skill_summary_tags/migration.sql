-- 2026-10-09 round 70: Skill 加 summary + tags (名称/摘要/标签 三件套)
-- 人类口径: "技能是不是也要加标签, 再就是技能摘要或者简要说明是不是也需要加一个。
--   用于通过名称, 摘要, 标签快速确认技能的匹配, 匹配到的再看技能详情确认是否与当前工作匹配"
--
-- 方案: 加两个**可空**列, 不影响现有 39,543 行; 存量回填走 LLM(配额窗口内跑), 不在这里做。
--   summary: 摘要 <= 80 字
--   tags:    标签 JSON 数组字符串(<=8 个, 每个 <=12 字)
--
-- 为什么 tags 用 JSON 数组字符串而不是逗号串: 标签本身可能含逗号/顿号, 用分隔符拼串会有歧义;
--   检索侧用 LIKE '%"tag"%' 命中(带引号, 避免 "net" 误命中 "network")。
--   若将来标签规模上去(需要按标签 join 聚合), 再考虑独立表 + 关联表。

ALTER TABLE "Skill" ADD COLUMN "summary" TEXT;
ALTER TABLE "Skill" ADD COLUMN "tags" TEXT;

CREATE INDEX "Skill_summary_idx" ON "Skill"("summary");
