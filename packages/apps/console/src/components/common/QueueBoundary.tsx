"use client";
// UI-9 (待办 todo_881c5afeaa90460db490 升级任务): 界面上说清「改进任务」与「待办」的区别。
//
// 依据: docs/platform-logic/task-vs-todo-boundary-2026-09-14.md
//   判据是二分、无中间态 —— 最初来源是不是「飞轮自省」:
//     是  -> 改进任务 (飞轮机制修复, 执行体做, 要求复测证据)
//     否  -> 待办 (人的要求 / 智能体反馈 / 平台质检 / 讨论提问 …), 需要工具能力时自动升级为任务
// 本组件是两条队列共用的「从哪来 / 谁做 / 在哪看 / 怎么计数」对照卡, 强调当前所在队列。
import { t } from "@/i18n";

type Queue = "task" | "todo";

export default function QueueBoundary({ current }: { current?: Queue }) {
  const cardStyle = (key: Queue) => ({
    flex: "1 1 300px",
    minWidth: 280,
    borderRadius: "var(--radius-lg)",
    border: "1px solid " + (current === key ? "var(--primary)" : "var(--border)"),
    background: current === key ? "color-mix(in srgb, var(--primary) 8%, transparent)" : "transparent",
    padding: "var(--sp-3) var(--sp-3-5)",
  });
  const nameStyle = (key: Queue) => ({
    fontWeight: 700,
    fontSize: "var(--fs-lg)",
    color: current === key ? "var(--primary)" : "inherit",
  });

  return (
    // 2026-10-13 round 76-DH: 这块对照卡原来**总是展开**(约 380px 高), 把"待办列表"整个推到首屏之外。
    //   lead 一句话已经说清判据, 故改成 <details> **默认折叠** —— 内容仍在 DOM 里(可测), 需要时一点即开。
    <details className="panel" data-testid="queue-boundary" data-current={current || ""} style={{ marginBottom: "var(--sp-3)" }}>
      <summary className="panel-header" style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap", cursor: "pointer" }}>
        <span className="panel-title">{t("boundary.title")}</span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>{t("boundary.lead")}</span>
        <span style={{ marginLeft: "auto", fontSize: "var(--fs-sm)", color: "var(--primary)", whiteSpace: "nowrap" }}>{t("boundary.toggle")}</span>
      </summary>
      <div style={{ padding: "var(--sp-2-5) var(--sp-3-5)" }}>
        <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", alignItems: "stretch" }}>
          <div style={cardStyle("task")} data-testid="queue-boundary-task">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", marginBottom: "var(--sp-1-5)" }}>
              <span style={nameStyle("task")}>{t("boundary.task.name")}</span>
              <span style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-0-5) var(--sp-2)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                {t("boundary.task.badge")}
              </span>
            </div>
            <div style={{ fontSize: "var(--fs-base)", lineHeight: 1.9 }}>
              <div data-testid="qb-task-from"><b>{t("boundary.task.from.label")}</b>：{t("boundary.task.from")}</div>
              <div data-testid="qb-task-who"><b>{t("boundary.task.who.label")}</b>：{t("boundary.task.who")}</div>
              <div data-testid="qb-task-where"><b>{t("boundary.task.where.label")}</b>：{t("boundary.task.where")}</div>
              <div style={{ color: "var(--text-muted)" }} data-testid="qb-task-metric">{t("boundary.task.metric")}</div>
            </div>
          </div>
          <div style={cardStyle("todo")} data-testid="queue-boundary-todo">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", marginBottom: "var(--sp-1-5)" }}>
              <span style={nameStyle("todo")}>{t("boundary.todo.name")}</span>
              <span style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-0-5) var(--sp-2)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                {t("boundary.todo.badge")}
              </span>
            </div>
            <div style={{ fontSize: "var(--fs-base)", lineHeight: 1.9 }}>
              <div data-testid="qb-todo-from"><b>{t("boundary.todo.from.label")}</b>：{t("boundary.todo.from")}</div>
              <div data-testid="qb-todo-who"><b>{t("boundary.todo.who.label")}</b>：{t("boundary.todo.who")}</div>
              <div data-testid="qb-todo-where"><b>{t("boundary.todo.where.label")}</b>：{t("boundary.todo.where")}</div>
              <div style={{ color: "var(--text-muted)" }} data-testid="qb-todo-metric">{t("boundary.todo.metric")}</div>
            </div>
          </div>
        </div>
        <div style={{ marginTop: "var(--sp-2-5)", fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.9 }} data-testid="queue-boundary-flow">
          <div>{t("boundary.flow.human")}</div>
          <div>{t("boundary.flow.flywheel")}</div>
          <div style={{ marginTop: "var(--sp-1)" }}>{t("boundary.helpTip")}</div>
        </div>
      </div>
    </details>
  );
}
