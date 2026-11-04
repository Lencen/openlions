"use client";
// agents-live 页 · 看板页头 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { PageHero, Pill } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum } from "@/lib/format";

export default function AgentsLiveHero({ data, s, agent }: { data: any; s: any; agent?: string | null }) {
  return (
    <PageHero
      title={t('agentsLive.title')}
      subtitle={t('agentsLive.board.source')}
      tags={
        <>
          <Pill tone="ok">在线 {fmtNum(s.online)}</Pill>
          <Pill tone="info">执行中 {fmtNum(s.busy)}</Pill>
          <Pill tone="crit">疑似卡住 {fmtNum(s.stuck)}</Pill>
          <Pill tone="mute">离线 {fmtNum(s.offline)}</Pill>
          {agent ? <Pill tone="mute">{t('agentsLive.onlyAgent', { id: agent })}</Pill> : null}
        </>
      }
      meta={
        <>
          {t('common.dataTime')} {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
          <br />
          窗口 {data?.range?.label || "近 24 小时"}
          <br />
          每 10 秒自动刷新
        </>
      }
    />
  );
}
