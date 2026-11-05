"use client";
// UI-9 (待办 todo_881c5afeaa90460db490 升级任务): 界面上说清「改进任务」与「待办」的区别。
//
// 依据: docs/platform-logic/task-vs-todo-boundary-2026-09-14.md
//   判据是二分、无中间态 —— 最初来源是不是「飞轮自省」:
//     是  -> 改进任务 (飞轮机制修复, 执行体做, 要求复测证据)
//     否  -> 待办 (人的要求 / 智能体反馈 / 平台质检 / 讨论提问 …), 需要工具能力时自动升级为任务
// 本组件是两条队列共用的「从哪来 / 谁做 / 在哪看 / 怎么计数」对照卡, 强调当前所在队列。
// 2026-11-05 P2 呈现层：内联 style 清零。原来用 cardStyle()/nameStyle() 按 current 计算高亮色，
//   改成 details 上的 data-current + 属性选择器（.wrap[data-current="task"] .card[data-q="task"]），
//   文案与结构未动。
import { t } from "@/i18n";
import styles from "./QueueBoundary.module.css";

type Queue = "task" | "todo";

export default function QueueBoundary({ current }: { current?: Queue }) {
  return (
    // 2026-10-13 round 76-DH: 这块对照卡原来**总是展开**(约 380px 高), 把"待办列表"整个推到首屏之外。
    //   lead 一句话已经说清判据, 故改成 <details> **默认折叠** —— 内容仍在 DOM 里(可测), 需要时一点即开。
    <details className={"panel " + styles.wrap} data-testid="queue-boundary" data-current={current || ""}>
      <summary className={"panel-header " + styles.summary}>
        <span className="panel-title">{t("boundary.title")}</span>
        <span className={styles.lead}>{t("boundary.lead")}</span>
        <span className={styles.toggle}>{t("boundary.toggle")}</span>
      </summary>
      <div className={styles.body}>
        <div className={styles.cards}>
          <div className={styles.card} data-q="task" data-testid="queue-boundary-task">
            <div className={styles.cardHead}>
              <span className={styles.cardName}>{t("boundary.task.name")}</span>
              <span className={styles.badge}>
                {t("boundary.task.badge")}
              </span>
            </div>
            <div className={styles.lines}>
              <div data-testid="qb-task-from"><b>{t("boundary.task.from.label")}</b>：{t("boundary.task.from")}</div>
              <div data-testid="qb-task-who"><b>{t("boundary.task.who.label")}</b>：{t("boundary.task.who")}</div>
              <div data-testid="qb-task-where"><b>{t("boundary.task.where.label")}</b>：{t("boundary.task.where")}</div>
              <div className={styles.metric} data-testid="qb-task-metric">{t("boundary.task.metric")}</div>
            </div>
          </div>
          <div className={styles.card} data-q="todo" data-testid="queue-boundary-todo">
            <div className={styles.cardHead}>
              <span className={styles.cardName}>{t("boundary.todo.name")}</span>
              <span className={styles.badge}>
                {t("boundary.todo.badge")}
              </span>
            </div>
            <div className={styles.lines}>
              <div data-testid="qb-todo-from"><b>{t("boundary.todo.from.label")}</b>：{t("boundary.todo.from")}</div>
              <div data-testid="qb-todo-who"><b>{t("boundary.todo.who.label")}</b>：{t("boundary.todo.who")}</div>
              <div data-testid="qb-todo-where"><b>{t("boundary.todo.where.label")}</b>：{t("boundary.todo.where")}</div>
              <div className={styles.metric} data-testid="qb-todo-metric">{t("boundary.todo.metric")}</div>
            </div>
          </div>
        </div>
        <div className={styles.flow} data-testid="queue-boundary-flow">
          <div>{t("boundary.flow.human")}</div>
          <div>{t("boundary.flow.flywheel")}</div>
          <div className={styles.flowTip}>{t("boundary.helpTip")}</div>
        </div>
      </div>
    </details>
  );
}
