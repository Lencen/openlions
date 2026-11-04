"use client";
// agents-live 页 · 视图切换器 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Segmented } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";

export type AgentsLiveView = "board" | "collab" | "workplan";

export default function ViewSwitch({
  view,
  onChange,
  hint,
}: {
  view: AgentsLiveView;
  onChange: (v: AgentsLiveView) => void;
  hint?: string;
}) {
  return (
    <div className="view-switch">
      <Segmented
        value={view}
        onChange={(v) => onChange(v as AgentsLiveView)}
        options={[
          { label: t('agentsLive.tab.board'), value: "board" },
          { label: t('agentsLive.tab.work'), value: "workplan" },
          { label: t('agentsLive.tab.collab'), value: "collab" },
        ]}
      />
      {hint ? <span className="tiny">{hint}</span> : null}
    </div>
  );
}
