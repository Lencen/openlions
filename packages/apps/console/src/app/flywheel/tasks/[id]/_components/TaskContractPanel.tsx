"use client";
// 任务详情页 · 任务契约面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批12 呈现层：3 处内联 style 下沉到 ./TaskContractPanel.module.css
//   （面板 extra 布局 / 改进载荷 pre / 字段表上边距）。字段、文案、跳转与取数未动。
import { Collapse, Descriptions } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard } from "@/components/ui";
import ConvertToTodoButton from "@/components/ConvertToTodoButton";
import { stripTypePrefix } from "@/config/taskScopes";
import { fmtNum } from "@/lib/format";
import Block from "./Block";
import styles from "./TaskContractPanel.module.css";

export default function TaskContractPanel({ id, task }: { id: string; task: any }) {
  return (
    <PanelCard
      title="任务契约（平台发布的内容）"
      extra={
        <span className={"tiny " + styles.contractExtra}>
          智能体就是照这份契约干的活
          <ConvertToTodoButton
            title={`跟进任务: ${stripTypePrefix(task.title, task.improvementType).slice(0, 60)}`}
            detail={`来自任务 ${id} (${task.improvementType || "-"})\n\n${String(task.description || "").slice(0, 1200)}`}
            source="goal_gap"
            sourceRefId={id}
            label="转成待办"
          />
        </span>
      }
    >
      <Block title="描述" text={task.description} />
      <Block title="背景（为什么会有这个任务）" text={task.background} />
      <Block title="要求" text={task.requirements} />
      <Block title="验收标准" text={task.acceptanceCriteria} />
      <Block title="质量底线" text={task.qualityStandards} />
      <Block title="结构化上下文" text={task.structuredContext} mono />
      <Block title="素材" text={task.materials} mono />
      {task.improvementPayload ? (
        <Collapse
          size="small"
          ghost
          items={[{ key: "p", label: "改进载荷（原始数据）", children: <pre className={styles.payloadPre}>{(() => { try { return JSON.stringify(JSON.parse(task.improvementPayload), null, 1); } catch { return String(task.improvementPayload); } })()}</pre> }]}
        />
      ) : null}
      <Descriptions
        size="small"
        column={1}
        bordered
        className={styles.descTop}
        items={[
          { key: "path", label: "项目路径", children: task.projectPath || "-" },
          { key: "stack", label: "技术栈", children: task.techStack || "-" },
          { key: "files", label: "目标文件", children: <span className="tiny">{task.targetFiles || "-"}</span> },
          { key: "pre", label: "前置任务", children: <span className="tiny mono">{task.prerequisiteTaskIds || "-"}</span> },
          { key: "ref", label: "来源反思", children: <span className="tiny mono">{task.sourceReflectionIds || "-"}</span> },
          { key: "effort", label: "实际耗时(ms)", children: task.actualEffortMs ? fmtNum(task.actualEffortMs) : "-" },
          { key: "ctx", label: "上下文版本", children: task.contextVersion || "-" },
        ]}
      />
    </PanelCard>
  );
}
