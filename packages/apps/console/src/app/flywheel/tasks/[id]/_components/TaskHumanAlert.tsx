"use client";
// 任务详情页 · 「需要人类决策」提示条 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 批12 呈现层：唯一内联 style（警示条下外边距）下沉到 ./TaskHumanAlert.module.css。
//   文案、「转成人的待办」跳转与取数未动。
import { Alert } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t as tr } from "@/i18n";
import ConvertToTodoButton from "@/components/ConvertToTodoButton";
import { stripTypePrefix } from "@/config/taskScopes";
import styles from "./TaskHumanAlert.module.css";

export default function TaskHumanAlert({
  id,
  task,
  needHuman,
}: {
  id: string;
  task: any;
  needHuman: boolean;
}) {
  if (!needHuman || !task) return null;
  return (
    <Alert
      type="warning"
      showIcon
      className={styles.alertGap}
      title="这条任务包含「需要人类决策」的内容"
      description={
        <span>
          任务的描述 / 产出里出现了人类决策标记（授权、采购、拍板、签字这类只有人能做的事）。
          {tr('taskDetail.humanNote')}{" "}
          <ConvertToTodoButton
            title={`[需要人类决策] ${stripTypePrefix(task.title, task.improvementType).slice(0, 60)}`}
            detail={`来自任务 ${id}\n类型: ${task.improvementType || "-"} · 状态: ${task.status}\n\n${String(task.description || "").slice(0, 1500)}`}
            source="goal_gap"
            sourceRefId={id}
            priority="P1"
            label="转成人的待办"
          />
        </span>
      }
    />
  );
}
