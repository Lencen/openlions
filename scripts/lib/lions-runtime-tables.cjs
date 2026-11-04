#!/usr/bin/env node
/**
 * lions-runtime-tables.cjs — Prisma schema 之外的"运行期自建表"初始化 SQL（产品化 S0-1）
 * =====================================================================================
 * 为什么需要:
 *   mind 的 `Todo` / `Discussion` 不在 Prisma schema 里（历史上由运行期/脚本 CREATE TABLE 建立）。
 *   全新安装用 `db push` 建的是 schema 内的表，这两个表缺失 -> `/api/health/db` 的 `count:Todo` 失败 -> 503。
 *   DDL 取自线上库 `sqlite_master`（2026-10-15），与 `scripts/tool-parse-error-aggregator.cjs` 等生产者一致；
 *   全部 `IF NOT EXISTS`，可重复执行。
 */
"use strict";

const RUNTIME_TABLES = {
  mind: [
    "CREATE TABLE IF NOT EXISTS Todo (id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT, source TEXT NOT NULL, sourceRefId TEXT, ownerType TEXT NOT NULL, ownerId TEXT, status TEXT NOT NULL, priority TEXT NOT NULL, dueAt INTEGER, evidence TEXT, note TEXT, createdBy TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, doneAt INTEGER, doneBy TEXT, meta TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_todo_owner ON Todo(ownerType, ownerId, status)",
    "CREATE INDEX IF NOT EXISTS idx_todo_status ON Todo(status, priority, dueAt)",
    "CREATE TABLE IF NOT EXISTS Discussion (id TEXT PRIMARY KEY, entityType TEXT NOT NULL, entityId TEXT NOT NULL, authorType TEXT NOT NULL, authorId TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, replyToId TEXT, taskId TEXT, meta TEXT, createdAt INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_discussion_entity ON Discussion(entityType, entityId, createdAt)",
  ],
};

// 2026-10-27 (商业化线, A 方案): PG 版运行期表。PG 未加引号会折成小写，
//   而 Prisma/业务查询用 "sourceRefId" 等 CamelCase，必须带引号；时间列是 BIGINT(epoch ms)。
const RUNTIME_TABLES_PG = {
  mind: [
    'CREATE TABLE IF NOT EXISTS "Todo" (id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT, source TEXT NOT NULL, "sourceRefId" TEXT, "ownerType" TEXT NOT NULL, "ownerId" TEXT, status TEXT NOT NULL, priority TEXT NOT NULL, "dueAt" BIGINT, evidence TEXT, note TEXT, "createdBy" TEXT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL, "doneAt" BIGINT, "doneBy" TEXT, meta TEXT)',
    'CREATE INDEX IF NOT EXISTS "idx_todo_owner" ON "Todo"("ownerType", "ownerId", status)',
    'CREATE INDEX IF NOT EXISTS "idx_todo_status" ON "Todo"(status, priority, "dueAt")',
    'CREATE TABLE IF NOT EXISTS "Discussion" (id TEXT PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL, "authorType" TEXT NOT NULL, "authorId" TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, "replyToId" TEXT, "taskId" TEXT, meta TEXT, "createdAt" BIGINT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS "idx_discussion_entity" ON "Discussion"("entityType", "entityId", "createdAt")',
  ],
};

module.exports = { RUNTIME_TABLES, RUNTIME_TABLES_PG };
