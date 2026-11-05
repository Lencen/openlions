"use client";
// 2026-09-10 追加需求: 任务详情独立页
// 从 /flywheel/tasks 列表点进来, 一页看全: 契约(描述/背景/要求/验收/质量底线/结构化上下文) +
// 状态流转 + agent 执行记录(全文) + 关联产物 + 平台裁定 + 通用讨论模块(时间线/发言/@agent 提问)
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
//
// 2026-11-05（数据卡 7 · data-cards/card-7-flywheel-tasks.md · 行级下钻）—— 只改呈现层与字段展示：
//   · 指标带改成 4 张 KpiCard（白名单件），不再用旧的非白名单指标卡；
//   · 卡片 7 §8「任务级耗时」：Task 表没有 startedAt（information_schema 已核），接口只给
//     createdAt/completedAt —— 因此任务级耗时显示「不可得」+ 原因，保留原「全流程耗时（创建→完成）」原值；
//   · 取数端点/参数、路由语义、字段口径一行未改。
import { useParams } from "next/navigation";
import { Alert, Button, Empty, Skeleton } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { KpiCard, PanelCard } from "@/components/ui";
import { fmtNum, fmtTime } from "@/lib/format";
import DiscussionPanel from "@/components/DiscussionPanel";
import TaskHero from "./_components/TaskHero";
import TaskHumanAlert from "./_components/TaskHumanAlert";
import TaskContractPanel from "./_components/TaskContractPanel";
import TaskTimelinePanels from "./_components/TaskTimelinePanels";
import TaskExecutionsPanel from "./_components/TaskExecutionsPanel";
import TaskProductsPanel from "./_components/TaskProductsPanel";
import TaskTodosPanel from "./_components/TaskTodosPanel";
import { STATUS_TAG } from "./_components/constants";
import styles from "./page.module.css";

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

  // 全流程耗时（创建 -> 完成）：改前指标卡的既有口径，原值保留。
  const flowSec = t?.createdAt && t?.completedAt
    ? Math.max(0, Math.round((Number(t.completedAt) - Number(t.createdAt)) / 1000))
    : null;
  // 任务级耗时（开始 -> 完成）：卡片 7 §8 声明的字段。接口若返回 startedAt 就是真实值；
  // 当前 Task 表无该列 -> 不可得（不写 0，也不拿全流程耗时冒充任务级耗时）。
  const taskSec = t?.startedAt && t?.completedAt
    ? Math.max(0, Math.round((Number(t.completedAt) - Number(t.startedAt)) / 1000))
    : null;

  return (
    <main className="page">
      <TaskHero id={id} task={t} onRefresh={mutate} />

      {error ? <Alert type="error" showIcon className={styles.alertGap} title="任务加载失败" description={String(error?.message || "")} /> : null}
      {data && !loading && !data.found ? (
        <PanelCard title="任务不存在">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`没有找到任务 ${id}`} />
          <div className={styles.center}>
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

          {/* ---------- 指标带（≤4 KpiCard；卡片 7 §8 行级下钻口径） ---------- */}
          <div className="kpi-grid">
            <KpiCard
              label="状态"
              value={STATUS_TAG[String(t.status || "").toUpperCase()]?.label || String(t.status || "—")}
              delta={t.improvementType || "未分类"}
              hint={"创建 " + fmtTime(t.createdAt) + " · 更新 " + fmtTime(t.updatedAt)}
            />
            <KpiCard
              label="全流程耗时（创建→完成）"
              value={flowSec != null ? flowSec : "—"}
              hint={flowSec != null
                ? "createdAt → completedAt（改前既有口径，原值保留）"
                : "尚未完成（completedAt 为空）—— 不适用，不是取不到"}
            />
            <KpiCard
              label="任务级耗时（开始→完成）"
              value={taskSec != null ? taskSec : "不可得"}
              hint={taskSec != null
                ? "startedAt → completedAt（卡片 7 §8；P95 口径见字典「飞轮任务 P95 耗时」）"
                : '原因：接口未返回 Task.startedAt（lions_mind."Task" 无该列）—— 不写 0，也不拿全流程耗时冒充'}
            />
            <KpiCard
              label="智能体执行"
              value={fmtNum(stats?.executions)}
              hint={"状态流转 " + fmtNum(stats?.transitions) + " 次 · 产出 " + fmtNum(stats?.outputChars) + " 字 · 关联产物 "
                + fmtNum(stats?.products) + " 条 · 平台裁定 " + fmtNum(stats?.verdicts) + " 次 · 注入 "
                + fmtNum(stats?.injections) + " 次 · 相关待办 " + fmtNum(stats?.todos) + " 条"}
            />
          </div>

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

          {/* ---------- 页脚：数据时刻 + 口径（卡片 7 §11：取不到显示不可得，不留空） ---------- */}
          <footer className={styles.foot}>
            <span className="tiny">
              数据时刻：{data?.asOf ? fmtTime(data.asOf) : loading ? "加载中…" : "不可得（接口未返回 asOf）"}
            </span>
            <span className="tiny">
              口径：全流程耗时 = completedAt − createdAt；任务级耗时 = completedAt − startedAt。
              接口未返回 startedAt（当前 Task 表无该列）时任务级耗时显示「不可得」，不写 0；
              数据时刻取不到时显示「不可得」，不借别处时刻。
            </span>
          </footer>
        </>
      ) : null}
    </main>
  );
}
