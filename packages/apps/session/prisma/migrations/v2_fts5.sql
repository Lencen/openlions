-- lions-session V2: FTS5 全文索引 (trigram tokenizer 支持中文)

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  content,
  toolName,
  toolCalls,
  tokenize='trigram'
);

-- 触发器: Message 写入 → fts 同步 (按 rowid 关联)
CREATE TRIGGER IF NOT EXISTS message_fts_insert AFTER INSERT ON Message BEGIN
  INSERT INTO message_fts(rowid, content, toolName, toolCalls)
  VALUES (new.rowid, COALESCE(new.content,''), COALESCE(new.toolName,''), COALESCE(new.toolCalls,''));
END;

CREATE TRIGGER IF NOT EXISTS message_fts_delete AFTER DELETE ON Message BEGIN
  DELETE FROM message_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS message_fts_update AFTER UPDATE ON Message BEGIN
  DELETE FROM message_fts WHERE rowid = old.rowid;
  INSERT INTO message_fts(rowid, content, toolName, toolCalls)
  VALUES (new.rowid, COALESCE(new.content,''), COALESCE(new.toolName,''), COALESCE(new.toolCalls,''));
END;

-- 一次性回填
INSERT INTO message_fts(rowid, content, toolName, toolCalls)
SELECT rowid, COALESCE(content,''), COALESCE(toolName,''), COALESCE(toolCalls,'')
FROM Message;
