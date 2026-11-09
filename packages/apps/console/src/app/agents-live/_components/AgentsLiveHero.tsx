"use client";
// agents-live 页 · 实时状态条 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 页头口径（PAGE-HEADER-31 §2）: 标题/说明/面包屑上移到 page.tsx 的 PageHeader，
//   本组件只保留在线 / 执行中 / 疑似卡住 / 离线的实时计数与数据时刻（取数与文案未动）。
import { Pill } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum } from "@/lib/format";
import styles from "../page.module.css";

export default function AgentsLiveHero({ data, s, agent }: { data: any; s: any; agent?: string | null }) {
  return (
    <div className={styles.liveStrip}>
      <div className="hero-tags">
        <Pill tone="ok">在线 {fmtNum(s.online)}</Pill>
        <Pill tone="info">执行中 {fmtNum(s.busy)}</Pill>
        <Pill tone="crit">疑似卡住 {fmtNum(s.stuck)}</Pill>
        <Pill tone="mute">离线 {fmtNum(s.offline)}</Pill>
        {agent ? <Pill tone="mute">{t('agentsLive.onlyAgent', { id: agent })}</Pill> : null}
      </div>
      <div className={"tiny " + styles.liveMeta}>
        {t('common.dataTime')} {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
        <br />
        窗口 {data?.range?.label || "近 24 小时"}
        <br />
        每 10 秒自动刷新
      </div>
    </div>
  );
}
