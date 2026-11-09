"use client";
// system/api 页 · 工具实时调测面板 (从 page.tsx 抽出, 页面瘦身)
// 2026-11-05 P2 批6：12 处内联 style 清零，样式下沉同目录 ./ToolPlayground.module.css；
//   调用中按钮的 cursor:wait 由 :disabled 承担（按钮本来就用 disabled={calling}）。
//   取数与回调 props（selectedTool / inputJson / setInputJson / callResult / calling / onInvoke）与文案未动。
import { t } from "@/i18n";
import type { McpTool } from "./types";
import styles from "./ToolPlayground.module.css";

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
        <div className={styles.tpBody}>
          <div className={styles.tpHead}>
            <div className={styles.tpName}>
              {selectedTool.name}
            </div>
            {selectedTool.description && (
              <div className={styles.tpDesc}>
                {selectedTool.description}
              </div>
            )}
          </div>
          <div className={styles.tpLabel}>
            输入参数（结构化数据）：
          </div>
          <textarea
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
            className={styles.tpInput}
          />
          <div className={styles.tpInvokeRow}>
            <button
              onClick={onInvoke}
              disabled={calling}
              className={"badge badge-blue " + styles.tpInvoke}
            >
              {calling ? "调用中..." : "▶ 调用"}
            </button>
          </div>
          {callResult && (
            <div className={styles.tpResult}>
              <div className={styles.tpResultLabel}>结果:</div>
              <pre className={styles.tpPre}>
                {callResult}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.tpEmpty}>
          ← 点击上方服务行展开工具，再点击工具名称开始调测
        </div>
      )}
    </div>
  );
}
