"use client";
// lineage 页 · 端到端链路 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批2：节点左边框与数值的颜色从内联 style 改为 data-tone 属性选择器
//   （见 ../page.module.css）。阶段色由 /api/lineage 下发，这里是 5 个设计令牌对应的色值。
import { Fragment } from "react";
import { PanelCard, StateBlock } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import styles from "../page.module.css";

/** 阶段色 -> 语义色调（与 globals.css 的 --table-* 令牌一一对应）。 */
const TONE: Record<string, string> = {
  "#2563eb": "skill",
  "#7c3aed": "knowledge",
  "#0d9488": "memory",
  "#d97706": "practice",
  "#db2777": "reflection",
};

export default function LineageLane({ stages, loadingAll }: { stages: any[]; loadingAll: boolean }) {
  return (
    <PanelCard title="端到端链路" extra={<span className="tiny">① 入湖 → ② 提炼 → ③ 落库 → ④ 使用 → ⑤ 产出回流</span>}>
      {loadingAll ? <StateBlock loading rows={1} /> : (
        <div className="lane">
          {stages.map((s: any, i: number) => (
            <Fragment key={s.id}>
              <div className={"lane-node " + styles.laneToneNode} data-tone={TONE[s.color] ?? "primary"}>
                <div className="ln-title">{s.label}</div>
                <div className={"ln-value " + styles.laneToneValue}>{fmtNum(s.value)}</div>
                <div className="ln-note">
                  {s.unit} · {s.note}
                </div>
              </div>
              {i < stages.length - 1 ? <div className="lane-arrow" aria-hidden="true">→</div> : null}
            </Fragment>
          ))}
        </div>
      )}
    </PanelCard>
  );
}
