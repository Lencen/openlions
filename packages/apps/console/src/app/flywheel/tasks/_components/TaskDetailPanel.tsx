"use client";
// /flywheel/tasks · 详情面板（P1 试点页 ord-20261104-032）
// 改前：详情行是表格里再插一个 <tr>（白名单 DataTable 不支持插行）。
// 改后：点行把详情渲染到表格下方的 PanelCard 里 —— 结构化详情 / 执行链 / 数据流向一个不少。
import { PanelCard, StateBlock } from "@/components/ui";
import DetailView from "./TaskDetailView";
import { fmtTs } from "./shared";
import type { Detail } from "./shared";

export default function TaskDetailPanel({
  id,
  detail,
  loading,
}: {
  id: string | null;
  detail: Detail | undefined;
  loading: boolean;
}) {
  if (!id) return null;
  return (
    <PanelCard title={"任务详情 · " + id} extra={<span className="tiny">点同一行可收起</span>}>
      {loading && !detail ? (
        <StateBlock loading rows={6} />
      ) : detail ? (
        <DetailView d={detail} fmtTs={fmtTs} />
      ) : (
        <StateBlock title="详情加载失败" desc="详情接口（/api/flywheel-tasks?detail=）没有返回内容；请重试，或直接打开任务详情页。" />
      )}
    </PanelCard>
  );
}
