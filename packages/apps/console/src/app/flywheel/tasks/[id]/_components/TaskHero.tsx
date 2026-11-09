"use client";
// 任务详情页 · 页头下的标识条
// 2026-11-05 页头口径统一（UIUX PAGE-HEADER-31 §3 #12）：面包屑/标题/一句说明已上移到 page.tsx，
//   原 page-hero 里的 hero-title/hero-sub（任务标题）随之让位给页头 + 面包屑末段；
//   这里只保留任务编号与类型/主题/优先级、状态标签、同类任务入口、时间与刷新。
//   文件名沿用 TaskHero（仅 page.tsx 引用），不改名以免扩大改动面。
// 2026-11-05 P2 批12（呈现层）：本件 4 处内联 style 清零，样式下沉到同目录 TaskHero.module.css；
//   任务范围色（sd.color）是动态值，改由 data-scope + --scope 属性选择器承载（映射同 config/taskScopes.ts）；
//   页头结构、文案、取数与对外 props（id / task / onRefresh）一行没动；本件不含表格。
import { Button, Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t as tr } from "@/i18n";
import { Pill } from "@/components/ui";
import { TASK_SCOPES, scopeDef, scopeOfType } from "@/config/taskScopes";
import { relTime } from "@/lib/format";
import { STATUS_TAG } from "./constants";
import styles from "./TaskHero.module.css";

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
    <div className={styles.taskBar}>
      <div>
        <div className={styles.taskIdLine}>
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
            // 2026-11-05 P2 批12：底色/描边/字色改由 data-scope 交给 CSS，配方仍是 13% 底 / 33% 描边 / 自身色字
            return (
              <Tooltip title={sd.desc}>
                <span className={"pill " + styles.scopePill} data-scope={sd.key}>
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
      <div className={"hero-meta " + styles.taskBarMeta}>
        {task ? (
          <div className={styles.scopeRow}>
            同类任务：
            {TASK_SCOPES.filter((s) => s.key !== "ALL").map((s) => (
              <a
                key={s.key}
                href={"/flywheel/tasks?scope=" + s.key}
                className={styles.scopeLink}
                data-scope={s.key}
                data-active={s.key === scopeOfType(task.improvementType)}
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
        <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} className={styles.refresh}>刷新</Button>
      </div>
    </div>
  );
}
