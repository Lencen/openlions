"use client";
// 任务详情页 · 相关待办 (反向关联) (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批12（呈现层）：本件 9 处内联 style 清零，样式下沉到同目录 TaskTodosPanel.module.css；
//   待办状态左边条与优先级色是动态值，改由 data-status / data-priority 属性选择器承载（分支与改前三元逐支一致）；
//   文案、取数（data.todos）与对外 props（data）一行没动；本件不含表格。
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum, relTime, truncate } from "@/lib/format";
import styles from "./TaskTodosPanel.module.css";

export default function TaskTodosPanel({ data }: { data: any }) {
  return (
    <PanelCard
      title="相关待办"
      tone="var(--status-warn)"
      extra={
        <Tooltip title="来源: 待办 meta.taskIds 里含本任务, 或待办的 sourceRefId = 本任务">
          <span className="tiny">{fmtNum(data?.todos?.length ?? 0)} 条 · 点开可直接在待办中心展开</span>
        </Tooltip>
      }
    >
      {(data?.todos ?? []).length === 0 ? (
        <StateBlock
          title="这条任务还没有引发待办"
          desc={<span className="tiny">如果任务里出现需要人决策/执行的内容（如 [需要人类决策]），可在上方「转成待办」或在待办中心手动建单。</span>}
          rows={2}
        />
      ) : (
        <div className={styles.todoList}>
          {(data.todos ?? []).map((td: any) => (
            <div key={td.id} className={styles.todoCard} data-status={td.status}>
              <div className={styles.todoHead}>
                <Tag color={td.status === "DONE" ? "success" : td.status === "BLOCKED" ? "error" : td.status === "DOING" ? "processing" : "blue"}>
                  {td.status === "OPEN" ? "待办" : td.status === "DOING" ? "进行中" : td.status === "BLOCKED" ? "受阻" : td.status === "DONE" ? "已完成" : td.status}
                </Tag>
                <span className={"mono " + styles.todoPriority} data-priority={td.priority}>{td.priority}</span>
                <Pill tone={td.ownerType === "human" ? "warn" : "info"}>{td.ownerType === "human" ? "🧑 人类" : "🤖 " + (td.ownerId || t('common.agent'))}</Pill>
                {td.viaMeta ? <Pill tone="mute">经 meta.taskIds 关联</Pill> : <Pill tone="mute">sourceRefId 直连</Pill>}
                {td.structured ? <Pill tone="ok">结构化详情</Pill> : <Pill tone="warn">旧格式</Pill>}
                <span className={"tiny " + styles.todoTime}>{relTime(td.updatedAt)}</span>
              </div>
              <div className={styles.todoTitle}>{td.title}</div>
              {td.detailPreview ? <div className={"tiny " + styles.todoDetail}>{truncate(td.detailPreview, 160)}</div> : null}
              <div className={styles.todoFoot}>
                <a href={`/todo?open=${td.id}`} className={styles.todoLink}>在待办中心展开详情 →</a>
                <span className="tiny mono">{td.id}</span>
                {td.doneAt ? <span className="tiny">完成于 {relTime(td.doneAt)}{td.doneBy ? " · " + td.doneBy : ""}</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
}
