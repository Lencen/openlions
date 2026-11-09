"use client"
// agents/detail 页 · 标题旁的状态 chip (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-06 页头口径统一（UIUX PAGE-HEADER-31 §3 #8）：面包屑 / 标题 / 一句说明已上移到 page.tsx，
//   本组件只剩标题旁的状态 chip；取数 / 字段 / 状态取值未动。文件名沿用 AgentHeader（仅 page.tsx 引用），
//   不改名以免扩大改动面。
import { StateChip } from "@/components/DataTable";

const STATUS_LABEL: Record<string, string> = { ACTIVE: "在线", IDLE: "空闲", OFFLINE: "离线", UNKNOWN: "未知", DISABLED: "已停用" };

export default function AgentHeader({ me }: { me: any }) {
  const state = String(me.status || "").toUpperCase();
  return (
    <StateChip
      state={state === "ACTIVE" ? "ok" : "idle"}
      text={STATUS_LABEL[state] || String(me.status || "未知")}
    />
  );
}
