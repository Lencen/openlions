import { todoRepo } from "@/server/lib/todo-repo";
import { prisma } from "@/lib/prisma";
import path from "path";

/**
 * discussion-context.ts — 2026-09-14
 *
 * 用户实测(任务讨论区): 在"@agent 提问"里选了 agent-d, 结果 **agent-e 抢答**, 而且答复看不懂:
 *   通篇是"必查接口: GET /api/v1/flywheel/todos/... 拿标题/描述/状态", 也就是**让提问人自己去查**。
 *
 * 两个根因:
 *   A. 提问任务没有 assignedAgent -> 落进公开队列, 谁先轮询谁抢答(与"问谁"无关);
 *   B. 提问任务的材料里只有 {entityType, entityId, discussion url} —— **没有任何被问对象的上下文**,
 *      而文本通道 agent 又拿不到数据, 于是它只能回答"你应该去查这些接口"。
 *
 * 本模块负责 B: 在开提问任务的**那一刻**把对象上下文(git 说: 平台本来就握在手里)打包进任务,
 *   让被问的 agent 不用自己去查也能回答。
 */
export async function buildEntityContext(entityType: string, entityId: string): Promise<{ text: string; facts: Record<string, any> }> {
  const t = String(entityType || "").trim();
  const id = String(entityId || "").trim();
  const lines: string[] = [];
  const facts: Record<string, any> = { entityType: t, entityId: id };

  try {
    if (t === "todo") {
      // 2026-10-23 P1: 读走 todo-repo（sqlite/dual 读 SQLite；pg 模式读 PG）
      const row: any = await todoRepo.get("SELECT * FROM Todo WHERE id = ?", id);
      if (!row) { lines.push("(未找到该待办)"); return { text: lines.join("\n"), facts }; }
      Object.assign(facts, {
        title: row.title, status: row.status, priority: row.priority,
        owner: row.ownerType + ":" + (row.ownerId || "未指派"), source: row.source,
        sourceRefId: row.sourceRefId || null, createdBy: row.createdBy || null,
        doneBy: row.doneBy || null, note: row.note || null, evidence: row.evidence || null,
      });
      lines.push("【待办】" + String(row.title || ""));
      lines.push("· 状态 " + row.status + " | 优先级 " + row.priority + " | 负责人 " + row.ownerType + ":" + (row.ownerId || "未指派"));
      lines.push("· 来源 " + (row.source || "-") + (row.sourceRefId ? " (" + row.sourceRefId + ")" : "") + " | 创建者 " + (row.createdBy || "-"));
      if (row.detail) lines.push("· 详情: " + String(row.detail).slice(0, 1500));
      if (row.evidence) lines.push("· 已有证据: " + String(row.evidence).slice(0, 400));
      if (row.note) lines.push("· 备注: " + String(row.note).slice(0, 400));
      // 来源任务(如果是任务产出转来的待办) -> 带上任务上下文, 这才是"背景"
      if (row.sourceRefId && /^cm[a-z0-9]{10,}$/i.test(String(row.sourceRefId))) {
        const tk: any = await prisma.task.findUnique({ where: { id: String(row.sourceRefId) },
          select: { id: true, title: true, description: true, status: true, improvementType: true, theme: true, completedBy: true } }).catch(() => null);
        if (tk) {
          facts.sourceTask = { id: tk.id, title: tk.title, status: tk.status, improvementType: tk.improvementType, completedBy: tk.completedBy };
          lines.push("【它的来源任务】" + tk.title + " (status=" + tk.status + (tk.completedBy ? ", by " + tk.completedBy : "") + ")");
          if (tk.description) lines.push("· 来源任务描述: " + String(tk.description).slice(0, 1500));
          const exs = await prisma.taskExecution.findMany({ where: { taskId: tk.id }, orderBy: { createdAt: "desc" }, take: 1, select: { agentId: true, output: true } }).catch(() => []);
          if (exs.length) lines.push("· 该任务的执行结论(节选): " + String(exs[0].output || "").slice(0, 1200));
        }
      }
      // 待办里常见的 options 结构 -> 直接摆出来, 这正是人类要选的
      try {
        const meta = row.meta ? JSON.parse(String(row.meta)) : null;
        const opts = meta?.options || meta?.decision?.options;
        if (Array.isArray(opts) && opts.length) {
          facts.options = opts;
          lines.push("【可选项(平台已备好)】");
          opts.slice(0, 6).forEach((o: any, i: number) => lines.push("  " + (i + 1) + ") " + (typeof o === "string" ? o : JSON.stringify(o).slice(0, 300))));
        }
        if (meta && typeof meta === "object") facts.metaKeys = Object.keys(meta);
      } catch { /* meta 非 JSON 则忽略 */ }
      return { text: lines.join("\n"), facts };
    }

    if (t === "task") {
      const tk: any = await prisma.task.findUnique({ where: { id }, select: { id: true, title: true, description: true, requirements: true, acceptanceCriteria: true, status: true, priority: true, improvementType: true, theme: true, assignedAgent: true, completedBy: true } }).catch(() => null);
      if (!tk) { lines.push("(未找到该任务)"); return { text: lines.join("\n"), facts }; }
      Object.assign(facts, { title: tk.title, status: tk.status, priority: tk.priority, improvementType: tk.improvementType, assignedAgent: tk.assignedAgent, completedBy: tk.completedBy });
      lines.push("【任务】" + tk.title);
      lines.push("· 状态 " + tk.status + " | 优先级 " + tk.priority + " | 类型 " + (tk.improvementType || "-") + " | 指派 " + (tk.assignedAgent || "公开") );
      if (tk.description) lines.push("· 描述: " + String(tk.description).slice(0, 1500));
      if (tk.requirements) lines.push("· 要求: " + String(tk.requirements).slice(0, 800));
      const exs = await prisma.taskExecution.findMany({ where: { taskId: id }, orderBy: { createdAt: "desc" }, take: 2, select: { agentId: true, output: true, completedAt: true } }).catch(() => []);
      if (exs.length) { facts.executions = exs.length; lines.push("· 最近的执行结论(节选): " + String(exs[0].output || "").slice(0, 1200)); }
      return { text: lines.join("\n"), facts };
    }

    // 其它实体: 给最基础的可读上下文, 至少不让 agent"完全不知道在说谁"
    lines.push("【对象】" + t + " " + id);
    if (t === "agent") {
      const a: any = await prisma.agentRegistry.findUnique({ where: { agent_id: id }, select: { display_name: true, channel: true, host: true, status: true, profile: true, last_seen_at: true } }).catch(() => null);
      if (a) { Object.assign(facts, a); lines.push("· " + (a.display_name || id) + " | " + a.channel + " | " + a.host + " | " + a.status); }
    }
    return { text: lines.join("\n"), facts };
  } catch (e: any) {
    return { text: "【对象】" + t + " " + id + "\n(上下文构建失败: " + String(e?.message || e).slice(0, 80) + ")", facts };
  }
}
