"use client";
// lineage 页 · 页头 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { PageHero, Pill } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum } from "@/lib/format";

export default function LineageHero({
  data,
  agent,
  theme,
  minimal,
}: {
  data: any;
  agent?: string | null;
  theme?: string | null;
  minimal?: boolean;
}) {
  if (minimal) {
    return <PageHero title="数据血脉" subtitle="数据怎么入的 · 怎么变的 · 怎么存的 · 怎么被用的" />;
  }
  return (
    <PageHero
      title="数据血脉"
      subtitle="从会话到认知产物的完整链路: 会话/消息如何入湖 → 提炼与结构化 → 四类产物落库 → 被哪些任务认领注入使用。点开任意一条产物即可回溯它的来源、质量、验证状态与使用记录。"
      tags={
        <>
          <Pill tone="info">{data?.range?.label || "近 24 小时"}</Pill>
          {agent ? <Pill tone="mute">{t('lineage.filterAgent', { id: agent })}</Pill> : null}
          {theme ? <Pill tone="mute">主题: {theme}</Pill> : null}
        </>
      }
      meta={
        <>
          数据时间 {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
          <br />
          窗口内新增产物 {fmtNum(data?.products?.total)}
        </>
      }
    />
  );
}
