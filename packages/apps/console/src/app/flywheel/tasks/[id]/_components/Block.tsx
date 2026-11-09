"use client";
// 任务详情页 · 契约/产出文本块 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批12（呈现层）：本件 5 处内联 style 清零，样式下沉到同目录 Block.module.css；
//   mono 标志改由 data-mono 属性选择器承载；文案、取数与对外 props（title/text/mono/fullLength/taskId）未动；本件不含表格。
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { fmtNum } from "@/lib/format";
import { TRUNCATE_HINT } from "./constants";
import styles from "./Block.module.css";

export default function Block({
  title, text, mono, fullLength, taskId,
}: { title: string; text?: string | null; mono?: boolean; fullLength?: number | null; taskId?: string }) {
  if (!text) return null;
  const actual = String(text).length;
  const truncated = typeof fullLength === "number" && fullLength > actual;
  return (
    <div className={styles.block}>
      <div className={styles.head}>
        <span>{title}</span>
        <span className={"tiny " + styles.count}>{fmtNum(actual)} 字</span>
        {truncated ? (
          <Tooltip title={TRUNCATE_HINT}>
            <span className={"pill warn " + styles.truncPill}>
              ⚠ 已截断 · 全文 {fmtNum(fullLength)} 字
            </span>
          </Tooltip>
        ) : null}
        {truncated && taskId ? (
          <a href={`/api/task-detail?id=${taskId}`} target="_blank" rel="noreferrer" className="tiny">看接口原文 →</a>
        ) : null}
      </div>
      <div className={styles.text} data-mono={mono ? "true" : undefined}>
        {text}
      </div>
    </div>
  );
}
