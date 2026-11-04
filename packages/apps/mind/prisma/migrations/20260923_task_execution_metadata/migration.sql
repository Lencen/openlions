-- 2026-09-23 uos20 #5 机制修复: cronjob 执行期上下文注入
-- 背景: 待办 todo_uos20fb_1790047372341_5 (uos20 P1 #5, operator 拍板"你继续处理吧")
-- 方案: 主 agent 核心 memory 快照捕获 + 执行期注入双段机制,
--       通过 TaskExecution.metadata.agentMemorySnapshot 承载(冻结快照, schemaVersion=1)。
-- 口径: metadata 为 nullable JSON 字符串(TaskStateTransition.metadata 同款), 旧数据不受影响;
--       不新增表/不引入依赖, 只加一列。

-- AlterTable
ALTER TABLE "TaskExecution" ADD COLUMN "metadata" TEXT;
