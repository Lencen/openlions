"use client";
// /flywheel/tasks · 列定义（P1 试点页 ord-20261104-032 · 列表模板 A）
// 从旧 TasksTable.tsx 的表格单元格搬过来：字段与判定逻辑不变，只换成白名单 DataTable 的列定义。
// 颜色不再内联 —— 状态走 StateChip，来源走 Pill，其余用 globals 里已有的 .dt-* 类。
import Link from "next/link";
import { StateChip, Pill } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import { scopeDef, scopeOfType, stripTypePrefix } from "@/config/taskScopes";
import { fmtTs } from "./shared";
import type { Item } from "./shared";
import styles from "../page.module.css";

/** 状态键 → 中文 + StateChip 的 state（文案沿用详情页 STATUS_TAG，界面不出现裸英文状态值）。 */
const STATUS: Record<string, { text: string; state: "ok" | "warn" | "crit" | "idle" }> = {
  DONE: { text: "已完成", state: "ok" },
  FAILED: { text: "失败", state: "crit" },
  IN_PROGRESS: { text: "进行中", state: "warn" },
  PROCESSING: { text: "处理中", state: "warn" },
  PENDING: { text: "待认领", state: "idle" },
  DEPRECATED: { text: "已废弃", state: "idle" },
};

/** 来源 scope → Pill 的口径色（用白名单 Pill 的 tone，不写内联色）。 */
const SCOPE_TONE: Record<string, string> = {
  MECHANISM: "warn",
  VERIFY: "info",
  DISCUSSION: "mute",
  OTHER: "mute",
  ALL: "info",
};

const isSystemActor = (v: string) => v.startsWith("cron:") || v.startsWith("system:");
const actorLabel = (v: string) => (isSystemActor(v) ? "平台定时任务" : v);

// TODO(数据卡 · 改进项)：PILOT §8 的「影响域 / 预期收益」两列在当前 /api/flywheel-tasks 的 item 里
//   没有对应字段（Item 只有 id/type/scope/status/title/theme/priority/assignedAgent/completedBy/时间）。
//   这里不造数字、不占列；数据线补字段后再加两列，并把「来源」标签回溯到反思 / 实践的深链。
export function buildTaskColumns(): DataColumn<Item>[] {
  return [
    {
      key: "status",
      title: "状态",
      width: "96px",
      render: (m) => {
        const st = STATUS[m.status] || { text: m.status || "未知", state: "idle" as const };
        return <StateChip state={st.state} text={st.text} />;
      },
    },
    {
      key: "scope",
      title: "来源",
      width: "150px",
      render: (m) => {
        const sd = scopeDef(m.scope || scopeOfType(m.type));
        return (
          <span>
            <Pill tone={SCOPE_TONE[sd.key] || "mute"} title={sd.desc}>{sd.short}</Pill>
            <span className="dt-who-sub mono">{m.type || "—"}</span>
          </span>
        );
      },
    },
    {
      key: "title",
      title: "改进项",
      render: (m) => (
        <Link className={styles.cellLink} href={"/flywheel/tasks/" + m.id} title={m.title || m.id}>
          {stripTypePrefix(m.title, m.type).slice(0, 110) || m.id}
        </Link>
      ),
    },
    { key: "theme", title: "主题", width: "170px", render: (m) => <span className="nowrap">{m.theme || "—"}</span> },
    { key: "priority", title: "优先级", width: "76px", render: (m) => <span className="nowrap mono">{m.priority || "—"}</span> },
    {
      key: "actor",
      title: "执行体",
      width: "170px",
      render: (m) => {
        const assigned = m.assignedAgent || null;
        const done = m.completedBy || null;
        if (!assigned && !done) return <span className="dt-who-sub" title="没有承接执行体, 留在公开队列等认领">未指派</span>;
        const head = assigned || (done ? actorLabel(done) : "");
        const showDone = !!done && done !== assigned;
        return (
          <span>
            <span className="dt-who-name" title={assigned ? "承接执行体: " + assigned : "无承接执行体, 由平台任务产生"}>
              {done && !assigned && isSystemActor(done) ? "平台定时任务" : head}
            </span>
            {showDone ? <span className="dt-who-sub" title={"完成者: " + done}>完成 {actorLabel(done)}</span> : null}
          </span>
        );
      },
    },
    {
      key: "updated",
      title: "更新时间",
      width: "150px",
      align: "right",
      render: (m) => <span className="mono nowrap">{fmtTs(m.updatedAt ?? m.createdAt)}</span>,
    },
    {
      key: "open",
      title: "",
      width: "64px",
      align: "right",
      render: (m) => (
        <Link className={styles.rowLink} href={"/flywheel/tasks/" + m.id} title="打开改进任务详情">详情 →</Link>
      ),
    },
  ];
}
