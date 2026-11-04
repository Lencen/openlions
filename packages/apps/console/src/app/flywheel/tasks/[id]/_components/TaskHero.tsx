"use client";
// 任务详情页 · 页头 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Button, Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t as tr } from "@/i18n";
import { Pill } from "@/components/ui";
import { TASK_SCOPES, scopeDef, scopeOfType } from "@/config/taskScopes";
import { relTime } from "@/lib/format";
import { STATUS_TAG } from "./constants";

export default function TaskHero({
  id,
  task,
  onRefresh,
}: {
  id: string;
  task: any;
  onRefresh: () => void;
}) {
  return (
    <div className="page-hero">
      <div>
        <div className="hero-title">{task?.title || "任务详情"}</div>
        <div className="hero-sub">
          <span className="mono">{id}</span>
          {task ? (
            <>
              {" · 类型 "}<b>{task.improvementType || "未分类"}</b>
              {task.theme ? <> · 主题 <b>{task.theme}</b></> : null}
              {task.priority ? <> · 优先级 <b>{task.priority}</b></> : null}
            </>
          ) : null}
        </div>
        <div className="hero-tags">
          {task ? (() => {
            const sd = scopeDef(scopeOfType(task.improvementType));
            return (
              <Tooltip title={sd.desc}>
                <span className="pill" style={{ background: "color-mix(in srgb, " + sd.color + " 13%, transparent)", color: sd.color, borderColor: "color-mix(in srgb, " + sd.color + " 33%, transparent)", fontWeight: 600 }}>
                  {tr('taskDetail.scope', { label: sd.label })}{sd.inImprovementMetric ? "（计入改进任务）" : "（不计入改进任务）"}
                </span>
              </Tooltip>
            );
          })() : null}
          {task ? <Tag color={STATUS_TAG[task.status]?.color || "default"}>{STATUS_TAG[task.status]?.label || task.status}</Tag> : null}
          {task?.assignedAgent ? <Pill tone="info">{tr('taskDetail.assignee', { id: task.assignedAgent })}</Pill> : null}
          {task?.completedBy ? <Pill tone="ok">完成者 {task.completedBy}</Pill> : null}
          {task?.manualReview ? <Pill tone="warn">需人工复核</Pill> : null}
          {task?.isDayLevel ? <Pill tone="mute">日级任务</Pill> : null}
          {task?.retryCount ? <Pill tone="crit">重试 {task.retryCount} 次</Pill> : null}
        </div>
      </div>
      <div className="hero-meta">
        {task ? (
          <div style={{ marginBottom: "var(--sp-1-5)" }}>
            同类任务：
            {TASK_SCOPES.filter((s) => s.key !== "ALL").map((s) => (
              <a
                key={s.key}
                href={"/flywheel/tasks?scope=" + s.key}
                style={{ marginLeft: "var(--sp-1-5)", fontSize: "var(--fs-sm)", color: s.key === scopeOfType(task.improvementType) ? s.color : "var(--text-dim)", fontWeight: s.key === scopeOfType(task.improvementType) ? 600 : 400 }}
              >
                {s.short}
              </a>
            ))}
          </div>
        ) : null}
        创建 {task ? relTime(task.createdAt) : "-"}
        <br />
        更新 {task ? relTime(task.updatedAt) : "-"}
        {task?.completedAt ? <><br />完成 {relTime(task.completedAt)}</> : null}
        <br />
        <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} style={{ marginTop: "var(--sp-1-5)" }}>刷新</Button>
      </div>
    </div>
  );
}
