"use client";
// lineage 页 · 端到端链路 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Fragment } from "react";
import { PanelCard, StateBlock } from "@/components/ui";
import { fmtNum } from "@/lib/format";

export default function LineageLane({ stages, loadingAll }: { stages: any[]; loadingAll: boolean }) {
  return (
    <PanelCard title="端到端链路" extra={<span className="tiny">① 入湖 → ② 提炼 → ③ 落库 → ④ 使用 → ⑤ 产出回流</span>}>
      {loadingAll ? <StateBlock loading rows={1} /> : (
        <div className="lane">
          {stages.map((s: any, i: number) => (
            <Fragment key={s.id}>
              <div className="lane-node" style={{ borderLeftColor: s.color }}>
                <div className="ln-title">{s.label}</div>
                <div className="ln-value" style={{ color: s.color }}>{fmtNum(s.value)}</div>
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
