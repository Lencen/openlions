"use client";
// 2026-09-10 追加需求: 任务详情独立页
// 从 /flywheel/tasks 列表点进来, 一页看全: 契约(描述/背景/要求/验收/质量底线/结构化上下文) +
// 状态流转 + agent 执行记录(全文) + 关联产物 + 平台裁定 + 通用讨论模块(时间线/发言/@agent 提问)
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useParams } from "next/navigation";
import { Alert, Button, Empty, Skeleton } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { PanelCard } from "@/components/ui";
import DiscussionPanel from "@/components/DiscussionPanel";
import TaskHero from "./_components/TaskHero";
import TaskHumanAlert from "./_components/TaskHumanAlert";
import TaskMetrics from "./_components/TaskMetrics";
import TaskContractPanel from "./_components/TaskContractPanel";
import TaskTimelinePanels from "./_components/TaskTimelinePanels";
import TaskExecutionsPanel from "./_components/TaskExecutionsPanel";
import TaskProductsPanel from "./_components/TaskProductsPanel";
import TaskTodosPanel from "./_components/TaskTodosPanel";

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id as string) || "";
  const { data, loading, error, mutate } = useApi<any>(`/api/task-detail?id=${encodeURIComponent(id)}`);

  const t = data?.task;
  const stats = data?.stats;
  // 2026-09-10: 任务里出现"需要人类决策"标记时, 提示把它转成人的待办 (TODO 一等实体)
  const needHuman = (() => {
    if (!t) return false;
    const hay = [t.description, t.requirements, t.acceptanceCriteria, t.background, t.structuredContext]
      .concat((data?.executions ?? []).map((e: any) => e.output))
      .filter(Boolean)
      .join("\n");
    return hay.includes("[需要人类决策]") || hay.includes("需要人类决策") || hay.includes("需人类拍板");
  })();

  return (
    <main className="page">
      <TaskHero id={id} task={t} onRefresh={mutate} />

      {error ? <Alert type="error" showIcon style={{ marginBottom: "var(--sp-4)" }} title="任务加载失败" description={String(error?.message || "")} /> : null}
      {data && !loading && !data.found ? (
        <PanelCard title="任务不存在">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`没有找到任务 ${id}`} />
          <div style={{ textAlign: "center" }}>
            <Button size="small" href="/flywheel/tasks">返回任务列表</Button>
          </div>
        </PanelCard>
      ) : null}

      {loading && !data ? (
        <PanelCard title="加载中"><Skeleton active paragraph={{ rows: 6 }} /></PanelCard>
      ) : null}

      {t ? (
        <>
          <TaskHumanAlert id={id} task={t} needHuman={needHuman} />

          <TaskMetrics task={t} stats={stats} loading={loading} />

          <div className="card-grid cols-2">
            <TaskContractPanel id={id} task={t} />
            <TaskTimelinePanels data={data} />
          </div>

          <TaskExecutionsPanel data={data} id={id} />

          <TaskProductsPanel data={data} />

          {/* ---------- 相关待办 (反向关联: 这条任务引发了哪些待办) ---------- */}
          <TaskTodosPanel data={data} />

          {/* ---------- 通用讨论模块 ---------- */}
          <DiscussionPanel entityType="task" entityId={id} title="任务讨论与协作" />
        </>
      ) : null}
    </main>
  );
}
