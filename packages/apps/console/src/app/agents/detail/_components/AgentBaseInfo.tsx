"use client"
// agents/detail 页 · 基础信息面板 (从 page.tsx 抽出)
// 2026-10-26：与其它详情页统一解剖 —— 原先用 table.tbl 当定义表（表头重、首列宽度不可控），
// 改成 DetailFields（label 96px + 值），状态用文字而不是彩色 badge（颜色只表"异常"，这里不等于异常）。
import { t as tr } from "@/i18n";
import { DetailFields } from "@/components/detail";
import { fmtStamp } from "@/lib/format";

/** 状态值业务化（不把英文枚举直接印在界面上） */
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "在线",
  IDLE: "空闲",
  OFFLINE: "离线",
  UNKNOWN: "未知",
  DISABLED: "已停用",
};

export default function AgentBaseInfo({ me, agentId }: { me: any; agentId: string }) {
  const status = String(me.status || "").toUpperCase();
  return (
    <DetailFields
      title="基础信息"
      cols={1}
      items={[
        { label: tr('agentDetail.idLabel'), value: me.agent_id || agentId, kind: "mono" },
        { label: "名称", value: me.display_name },
        { label: "框架", value: me.channel },
        { label: "终端", value: me.host },
        { label: "状态", value: STATUS_LABEL[status] || status },
        { label: "创建时间", value: fmtStamp(me.created_at) },
        { label: "最后活跃", value: fmtStamp(me.last_seen_at) },
      ]}
    />
  );
}
