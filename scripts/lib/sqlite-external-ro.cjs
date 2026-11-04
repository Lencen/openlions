#!/usr/bin/env node
/**
 * sqlite-external-ro.cjs — 外部网关 SQLite 的只读打开器（2026-10-29）
 *
 * 只用于 OpenClaw/Hermes 自己的状态库（~/.openclaw 下的 *.sqlite、~/.hermes/state.db），
 * **不用于 dev.db**（dev.db 已退役）。用 Node 内置 node:sqlite，不再依赖 better-sqlite3。
 */
"use strict";
const { DatabaseSync } = require("node:sqlite");

function openSqliteReadonly(file) {
  return new DatabaseSync(String(file), { readOnly: true });
}
module.exports = { openSqliteReadonly };
