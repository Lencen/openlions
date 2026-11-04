"use client";
// 概览首页 · 页头 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Button } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t } from "@/i18n";
import { PageHero, Pill } from "@/components/ui";

/** 错误态下的极简页头 (与抽取前 error 分支逐字一致) */
export function OverviewHeroPlain() {
  return <PageHero title="平台总览" subtitle={t('overview.hero.subtitle')} />;
}

export default function OverviewHero({
  data,
  agent,
  theme,
  onRefresh,
}: {
  data: any;
  agent?: string | null;
  theme?: string | null;
  onRefresh: () => void;
}) {
  const agents = data?.agents;
  return (
    <PageHero
      title="平台总览"
      subtitle={t('overview.subtitle')}
      tags={
        <>
          <Pill tone="info">{data?.range?.label || "近 24 小时"}</Pill>
          {agent ? <Pill tone="mute">{t('overview.filter.agent', { id: agent })}</Pill> : null}
          {theme ? <Pill tone="mute">主题: {theme}</Pill> : null}
          {agents?.macsOnline >= 0 ? <Pill tone="ok">{t('overview.macsOnline', { n: agents.macsOnline })}</Pill> : null}
        </>
      }
      meta={
        <>
          数据时间 {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
          <br />
          每 10 秒自动刷新
          <br />
          <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} style={{ marginTop: "var(--sp-1-5)" }}>刷新</Button>
        </>
      }
    />
  );
}
