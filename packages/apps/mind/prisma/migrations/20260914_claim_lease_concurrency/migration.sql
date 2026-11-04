-- 2026-09-14 认领并发控制落地 — Task 表 3 字段 + 1 索引
-- 来源: 知识条目 cmtwa1b1900j0yn162「任务认领机制应内建的并发控制要素」
--       提案 cmtwb7z1o00l11j76e6tx65um (PROPOSAL_LANDING_REJECTED)
--       复核 cmu0stufv00nuki4ag8rzt5ur 限定的最小命题:
--         "新增 version/lease/expireAt/expectedOwner 字段 + 释放侧对称记 transition"
--
-- version        : 乐观锁版本号。认领/续约/释放/接管/提交都做 `WHERE ... AND version=?` CAS,
--                  影响行=0 即"归属已变/发生竞争", 用于检测并发双领与过期持有者回写。
-- leaseExpiresAt : 租约到期时间(lease TTL)。NULL = 无租约(兼容改动前的历史 IN_PROGRESS 数据)。
-- expectedOwner  : 显式归属断言(expectedOwner/takeover)。与 assignedAgent 一起参与 CAS。

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "expectedOwner" TEXT;

-- CreateIndex (回收器按租约到期扫描)
CREATE INDEX "Task_leaseExpiresAt_idx" ON "Task"("leaseExpiresAt");
