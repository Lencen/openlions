"use client";
// system/api 页 · 工具实时调测面板 (从 page.tsx 抽出, 页面瘦身)
import { t } from "@/i18n";
import type { McpTool } from "./types";

export default function ToolPlayground({
  selectedTool,
  inputJson,
  setInputJson,
  callResult,
  calling,
  onInvoke,
}: {
  selectedTool: McpTool | null;
  inputJson: string;
  setInputJson: (v: string) => void;
  callResult: string;
  calling: boolean;
  onInvoke: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{t('api.panel.mcpTest')}</span>
      </div>
      {selectedTool ? (
        <div style={{ padding: "var(--sp-4)" }}>
          <div style={{ marginBottom: "var(--sp-3)" }}>
            <div style={{ fontWeight: 600, color: "var(--primary)" }}>
              {selectedTool.name}
            </div>
            {selectedTool.description && (
              <div
                style={{
                  fontSize: "var(--fs-base)",
                  color: "var(--text-dim)",
                  marginTop: "var(--sp-1)",
                }}
              >
                {selectedTool.description}
              </div>
            )}
          </div>
          <div style={{ marginBottom: "var(--sp-2)", fontSize: "var(--fs-base)" }}>
            输入参数（结构化数据）：
          </div>
          <textarea
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
            style={{
              width: "100%",
              minHeight: 120,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-base)",
              padding: "var(--sp-2)",
              background: "var(--bg-surface2)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xs)",
            }}
          />
          <div style={{ marginTop: "var(--sp-3)" }}>
            <button
              onClick={onInvoke}
              disabled={calling}
              className="badge badge-blue"
              style={{
                cursor: calling ? "wait" : "pointer",
                padding: "var(--sp-1-5) var(--sp-4)",
              }}
            >
              {calling ? "调用中..." : "▶ 调用"}
            </button>
          </div>
          {callResult && (
            <div style={{ marginTop: "var(--sp-4)" }}>
              <div style={{ fontSize: "var(--fs-base)", marginBottom: "var(--sp-1-5)" }}>结果:</div>
              <pre
                style={{
                  background: "var(--bg-surface2)",
                  padding: "var(--sp-3)",
                  borderRadius: "var(--radius-xs)",
                  border: "1px solid var(--border)",
                  fontSize: "var(--fs-sm)",
                  maxHeight: 400,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {callResult}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            padding: "var(--sp-7)",
            textAlign: "center",
            color: "var(--text-dim)",
            fontSize: "var(--fs-md)",
          }}
        >
          ← 点击上方服务行展开工具，再点击工具名称开始调测
        </div>
      )}
    </div>
  );
}
