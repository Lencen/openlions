"use client";
import { useEffect, useRef, useState } from "react";

interface LogFile {
  file: string;
  mtime: string;
  size: number;
  lines: Array<string | { line: string; time: string }>;
}

const LEVEL_COLORS: Record<string, string> = {
  "[dsh-sync]": "var(--primary)",
  "[agent-e]": "var(--agent-e)",
  "[agent-operator]": "var(--agent-operator)",
  "[agent-d]": "var(--agent-d)",
  "error": "var(--status-crit)",
  "fail": "var(--status-crit)",
  "skip": "var(--ink-muted)",
  "完成": "var(--status-ok)",
};

function lineColor(line: string): string | undefined {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("[err]") || lower.includes("failed")) return "var(--status-crit)";
  if (lower.includes("[skip]") || lower.includes("已存在") || lower.includes("无新消息")) return "var(--ink-muted)";
  if (lower.includes("→ 200") || lower.includes("done") || lower.includes("完成")) return "var(--status-ok)";
  if (lower.includes("start") || lower.includes("syncing")) return "var(--primary)";
  return undefined;
}

export default function SyncLogPanel() {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const ticking = useRef(false);

  useEffect(() => {
    const load = async () => {
      if (ticking.current) return;
      ticking.current = true;
      try {
        const r = await fetch("/api/sync-log?lines=60");
        const d = await r.json();
        if (d.success) {
          setFiles(d.files || []);
          setLastUpdate(new Date(d.generatedAt).toLocaleTimeString("zh-CN"));
        }
      } catch {
        // 轮询失败(服务未就绪/网络抖动): 保留上一次数据, 10s 后自动重试 —— 故意不弹错
      }
      finally { ticking.current = false; }
    };
    load();
    const t = setInterval(load, 10000); // 10s 轮询, 与同步 cron 节奏对齐
    return () => clearInterval(t);
  }, []);

  // auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (autoScroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [files, autoScroll]);

  const allLines = files.flatMap((f) => f.lines);
  const totalFiles = files.length;

  return (
    <div className="sync-log-panel">
      <div className="sync-log-head">
        <div>
          <span className="sync-log-title">数据同步日志</span>
          <span className="sync-log-sub">{totalFiles} 个源 · 10s 刷新 · 最后更新 {lastUpdate || "…"}</span>
        </div>
        <button
          className={`sync-log-toggle ${autoScroll ? "on" : ""}`}
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {autoScroll ? "自动滚动 ✓" : "自动滚动"}
        </button>
      </div>
      {/* 2026-10-22 a11y：可滚动区域必须能键盘聚焦（axe: scrollable-region-focusable） */}
      <div className="sync-log-body" ref={boxRef} tabIndex={0}>
        {allLines.length === 0 ? (
          <div className="sync-log-empty">暂无日志 (cron 每 10 分钟执行一次)</div>
        ) : (
          allLines.map((line, i) => {
            const raw = typeof line === "string" ? line : (line as any).line || "";
            const time = typeof line === "object" ? (line as any).time || "" : "";
            return (
              <div key={i} className="sync-log-line" style={{ color: lineColor(raw) || "var(--ink)", display: "flex", gap: 10 }}>
                <span style={{
                  flexShrink: 0,
                  minWidth: 135,
                  color: time.startsWith("~") ? "var(--ink-muted)" : "var(--primary)",
                  fontStyle: time.startsWith("~") ? "italic" : "normal",
                  fontFamily: "var(--mono)",
                }}>{time || "—"}</span>
                <span style={{ flex: 1 }}>{raw}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
