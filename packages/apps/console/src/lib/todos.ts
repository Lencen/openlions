"use client";
// 2026-09-10 TODO 独立实体: 前端共用定义与调用封装
// 语义: ownerType=human 是"人的待办"(含只有人能做的事: 授权/采购/决策/签字);
//      ownerType=agent 是 agent 的行动项;
//      TODO 与飞轮"改进任务"(机制修复) 是两个队列, 不互相计入统计。
/** 2026-09-14: 人类操作者身份(用于把"谁做的决定"记清楚; 原来写死 human:operator, 记不出是哪个人)。 */
export const HUMAN_ID = "operator";

export interface Todo {
  id: string;
  title: string;
  detail: string | null;
  source: string;
  sourceRefId: string | null;
  ownerType: string;
  ownerId: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  evidence: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  doneBy: string | null;
  /** 机器可读字段 (2026-09-11 mind 起): sections / taskIds / options / links / generatedBy */
  meta?: Record<string, any> | string | null;
}

export const TODO_STATUS: Record<string, { label: string; color: string; tone: string }> = {
  OPEN: { label: "待办", color: "var(--primary)", tone: "info" },
  DOING: { label: "进行中", color: "var(--status-warn)", tone: "warn" },
  BLOCKED: { label: "受阻", color: "var(--status-crit)", tone: "crit" },
  DONE: { label: "已完成", color: "var(--status-ok)", tone: "ok" },
  DROPPED: { label: "已放弃", color: "var(--text-muted)", tone: "mute" },
};

export const OPEN_STATUSES = ["OPEN", "DOING", "BLOCKED"];

export const TODO_SOURCE: Record<string, { label: string; icon: string; href?: (ref: string | null) => string | null }> = {
  goal_gap: { label: "目标缺口 / 任务", icon: "🎯", href: (ref) => (ref ? "/flywheel/tasks/" + ref : null) },
  review: { label: "审查", icon: "🔎", href: () => "/flywheel/audit" },
  discussion: { label: "讨论发言", icon: "💬", href: () => "/agents-live" },
  agent_proposal: { label: "智能体提案", icon: "🤖", href: () => "/agents-live" },
  verification: { label: "知识验证", icon: "🧪", href: (ref) => (ref ? "/cognitive/knowledge/detail?id=" + ref : null) },
  // 2026-09-23 审核项=待办 (todo_land_jp7xab44pb6g): 知识治理待审项统一进待办中心, 不另造审核 UI
  knowledge_governance_review: { label: "知识治理审核", icon: "🧹", href: () => "/cognitive/knowledge/governance" },
  human: { label: "人工创建", icon: "🧑", href: () => null },
  system: { label: "系统生成", icon: "⚙️", href: () => null },
};

export const TODO_PRIORITY: Record<string, { label: string; color: string }> = {
  P0: { label: "P0", color: "var(--status-crit)" },
  P1: { label: "P1", color: "var(--status-warn)" },
  P2: { label: "P2", color: "var(--text-muted)" },
};

export function dueState(dueAt: string | null | undefined, status?: string): { overdue: boolean; soon: boolean; label: string } {
  if (!dueAt) return { overdue: false, soon: false, label: "-" };
  const t = new Date(dueAt).getTime();
  if (!Number.isFinite(t)) return { overdue: false, soon: false, label: "-" };
  const now = Date.now();
  const closed = status === "DONE" || status === "DROPPED";
  const overdue = !closed && t < now;
  const soon = !closed && !overdue && t - now < 24 * 3600 * 1000;
  const d = new Date(t);
  const label = d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return { overdue, soon, label };
}

export function isToday(v: string | null | undefined): boolean {
  if (!v) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export interface CreateTodoInput {
  title: string;
  detail?: string | null;
  source?: string;
  sourceRefId?: string | null;
  ownerType?: "human" | "agent";
  ownerId?: string | null;
  priority?: string;
  dueAt?: string | null;
  evidence?: string | null;
  /** 2026-09-11: mind POST 现在接受并落库 meta (机器可读字段: sections/taskIds/options/generatedBy) */
  meta?: Record<string, any> | null;
}

export async function createTodo(input: CreateTodoInput): Promise<{ ok: boolean; todo?: Todo; error?: string }> {
  try {
    const res = await fetch("/api/todos", {
      method: "POST",
      // 2026-09-11: 显式声明"这是真人在 UI 上的操作" —— mind 据此才记 HUMAN_INTERVENTION
      headers: { "Content-Type": "application/json", "x-actor-kind": "human", "x-actor-id": HUMAN_ID },
      body: JSON.stringify({ source: "human", ownerType: "human", priority: "P2", authorType: "human", createdBy: "human:" + HUMAN_ID, ...input }),
    });
    const d = await res.json();
    return { ok: !!d?.ok, todo: d?.todo, error: d?.error };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function patchTodo(input: {
  id: string;
  status?: string;
  ownerType?: string;
  ownerId?: string | null;
  priority?: string;
  dueAt?: string | null;
  note?: string | null;
  /** 2026-09-14: 决定/结论的证据留档(人类提交决策时用) */
  evidence?: string | null;
  doneBy?: string;
  /** 2026-09-11: mind PATCH 现在接受 meta (可给历史待办补机器可读字段) */
  meta?: Record<string, any> | null;
}): Promise<{ ok: boolean; todo?: Todo; error?: string }> {
  try {
    const res = await fetch("/api/todos", {
      method: "PATCH",
      // 2026-09-14 归属修正: 原来写死 human:operator —— 记不出"是哪个人", 而平台一直要求"何人"可追。
      //   现在带 x-actor-id, 由 console 代理转成 by=human:<id>。
      headers: { "Content-Type": "application/json", "x-actor-kind": "human", "x-actor-id": HUMAN_ID },
      body: JSON.stringify({ by: "human:" + HUMAN_ID, doneBy: "human:" + HUMAN_ID, ...input }),
    });
    const d = await res.json();
    return { ok: !!d?.ok, todo: d?.todo, error: d?.error };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
