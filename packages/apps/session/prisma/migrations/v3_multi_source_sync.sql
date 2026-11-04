-- v3_multi_source_sync (2026-06-24): 新增 SyncWatermark 表 + source 索引
CREATE TABLE IF NOT EXISTS SyncWatermark (
  source TEXT NOT NULL PRIMARY KEY,
  lastTs DATETIME NOT NULL,
  lastRunAt DATETIME NOT NULL,
  lastCount INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_source_agent ON Session(source, agentId);
