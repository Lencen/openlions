"use client";
// agents-live 页 · 协作视图 (collab tab, 从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { t } from "@/i18n";
import { PageHero, Pill } from "@/components/ui";
import CollaborationView from "@/components/CollaborationView";
import ViewSwitch, { type AgentsLiveView } from "./ViewSwitch";

export default function AgentsLiveCollab({
  range,
  agent,
  theme,
  view,
  onChange,
}: {
  range: string;
  agent: string | null;
  theme: string | null;
  view: AgentsLiveView;
  onChange: (v: AgentsLiveView) => void;
}) {
  return (
    <>
      <PageHero
        title={t('agentsLive.collab.title')}
        subtitle={t('agentsLive.collab.subtitle')}
        tags={
          <>
            <Pill tone="info">{range === "24h" ? "近 24 小时" : range}</Pill>
            {agent ? <Pill tone="mute">{t('agentsLive.filter.agent', { id: agent })}</Pill> : null}
            {theme ? <Pill tone="mute">主题: {theme}</Pill> : null}
          </>
        }
      />
      <ViewSwitch view={view} onChange={onChange} />
      <CollaborationView />
    </>
  );
}
