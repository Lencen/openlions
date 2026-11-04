"use client";
// 2026-10-20 R7（B9-3）：改进任务的"卡住"提示条。
// 数据：/api/task-stuck（未完成 2,072，其中 389 个超 7 天未动，最久 24 天）。
// 位置：KPI 网格下方一条窄提示，不抢 hero；无数据/失败时不显示（不画假的 0）。
import { useApi } from "@/lib/api";
import { fmtNum } from "@/lib/format";

export default function StuckTasksStrip() {
  const { data } = useApi<any>("/api/task-stuck");
  if (!data || data.ok === false || !data.openTotal) return null;
  const stuck = Number(data.stuck7) || 0;
  return (
    <div className={"stuck-strip" + (stuck > 0 ? " warn" : "")}>
      <span className="stuck-main">
        {stuck > 0 ? "🔴 " : "🟢 "}
        未完成 <b>{fmtNum(data.openTotal)}</b> 个任务
        {stuck > 0 ? <>，其中 <b>{fmtNum(stuck)}</b> 个超过 7 天没有任何动作（最久 {data.oldestDays} 天）</> : "，没有卡住的"}
      </span>
      <span className="stuck-basis">{data.basis}</span>
    </div>
  );
}
