"use client";
// agents-live 页 · 工作计划视图 (workplan tab, 从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { t } from "@/i18n";
import { PageHero, Pill } from "@/components/ui";
import WorkPlanView from "@/components/WorkPlanView";
import ViewSwitch, { type AgentsLiveView } from "./ViewSwitch";

export default function AgentsLiveWorkplan({
  range,
  view,
  onChange,
}: {
  range: string;
  view: AgentsLiveView;
  onChange: (v: AgentsLiveView) => void;
}) {
  return (
    <>
      <PageHero
        title={t('agentsLive.work.title')}
        subtitle={t('agentsLive.work.subtitle')}
        tags={
          <>
            <Pill tone="info">窗口 {range === "24h" ? "近 24 小时" : range}</Pill>
            <Pill tone="mute">只读</Pill>
          </>
        }
      />
      <ViewSwitch view={view} onChange={onChange} hint={t('agentsLive.toggleHint')} />
      <WorkPlanView />
    </>
  );
}
