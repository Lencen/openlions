import { createHash } from "crypto";
import { createTodo, type TodoInput } from "./todo-store";
import { todoRepo } from "@/server/lib/todo-repo";

/**
 * 2026-09-15 [机制修复] agent 巡检发现 -> 待办 的结构化入口 (server 侧)
 *
 * 背景(实测断裂, 见待办 todo_0d03a211800248b29143):
 *   agent 的巡检发现此前只能以**对话消息**发给某个 agent, 没有"变成待办"的通道 —— 要么靠 leader
 *   人肉转写(2026-09-14 一次转写了 4 条), 要么就停在会话里。后果: 一线 agent 看得见的问题, 进入平台
 *   队列的路径依赖某个人的注意力。
 *
 * 本模块把"巡检发现"定义成**有四要素的结构化对象**, 缺任何一个就拒收:
 *   现象 symptom / 证据 evidence / 建议动作 suggestedAction / 来源 agent sourceAgent。
 * 按平台既有边界(routes/../tasks/route.ts POSITION_VIOLATION): agent 反馈一律先落**待办**,
 *   由 todo_worker 按 needsTools 决定是否升级为执行任务(带 fromTodo 标记交给有工具能力的执行体)。
 *
 * needsTools 判定口径与 scripts/macs-responder/todo_worker.py 的 `needs_tools_todo()` 保持一致:
 *   ① 提交方显式给 boolean -> 以提交方为准(建单方最清楚要不要工具);
 *   ② 未给 -> 平台按关键词+否定句剔除兜底推断, 并把结果**写进 meta.needsTools**, 作为升级通道的权威标记。
 */

export const FINDING_SOURCE_SUFFIX = " 巡检反馈";

export type AgentFindingInput = {
  symptom?: unknown;
  evidence?: unknown;
  suggestedAction?: unknown;
  sourceAgent?: unknown;
  /** 显式声明是否需要工具能力; 不传/非 boolean -> 平台推断 */
  needsTools?: unknown;
  /** 是否必须由人类决策(授权/采购/签字); true 时不进 agent 可领队列 */
  needsHuman?: unknown;
  priority?: unknown;
  title?: unknown;
  detail?: unknown;
  sourceRefId?: unknown;
  /** 幂等键: 同一 agent 对同一现象重复上报时复用; 不传则按 现象+建议动作 生成 */
  dedupKey?: unknown;
  /** 只做校验+路由预览, 不落库(供 agent 上报前自检) */
  dryRun?: unknown;
  meta?: unknown;
};

export type AgentFinding = {
  symptom: string;
  evidence: string;
  suggestedAction: string;
  sourceAgent: string;
  needsTools?: boolean;
  needsHuman?: boolean;
  priority?: string;
  title?: string;
  detail?: string;
  sourceRefId?: string;
  dedupKey?: string;
  meta?: Record<string, any>;
};

export const REQUIRED_FINDING_FIELDS: { key: keyof AgentFindingInput; label: string; alias?: string }[] = [
  { key: "symptom", label: "现象" },
  { key: "evidence", label: "证据" },
  { key: "suggestedAction", label: "建议动作", alias: "action" },
  { key: "sourceAgent", label: "来源 agent", alias: "agentId" },
];

function pick(body: any, key: string, alias?: string): string {
  const raw = body?.[key] ?? (alias ? body?.[alias] : undefined);
  return raw == null ? "" : String(raw).trim();
}

export function parseFinding(body: any): { ok: boolean; missing: string[]; finding: AgentFinding } {
  const missing: string[] = [];
  const symptom = pick(body, "symptom");
  const evidence = pick(body, "evidence");
  const suggestedAction = pick(body, "suggestedAction", "action");
  const sourceAgent = pick(body, "sourceAgent", "agentId");
  if (!symptom) missing.push("现象(symptom)");
  if (!evidence) missing.push("证据(evidence)");
  if (!suggestedAction) missing.push("建议动作(suggestedAction)");
  if (!sourceAgent) missing.push("来源 agent(sourceAgent)");
  const finding: AgentFinding = {
    symptom: symptom.slice(0, 600),
    evidence: evidence.slice(0, 2000),
    suggestedAction: suggestedAction.slice(0, 1200),
    sourceAgent: sourceAgent.slice(0, 80),
    needsTools: typeof body?.needsTools === "boolean" ? body.needsTools : undefined,
    needsHuman: typeof body?.needsHuman === "boolean" ? body.needsHuman : undefined,
    priority: ["P0", "P1", "P2"].includes(String(body?.priority)) ? String(body.priority) : undefined,
    title: pick(body, "title").slice(0, 300) || undefined,
    detail: pick(body, "detail").slice(0, 2000) || undefined,
    sourceRefId: pick(body, "sourceRefId").slice(0, 120) || undefined,
    dedupKey: pick(body, "dedupKey").slice(0, 160) || undefined,
    meta: body?.meta && typeof body.meta === "object" ? body.meta : undefined,
  };
  return { ok: missing.length === 0, missing, finding };
}

// 与 scripts/macs-responder/todo_worker.py NEEDS_TOOLS 保持同表(改一处要同步改两处, 已有回归脚本锁行为)
export const NEEDS_TOOLS_KEYWORDS = [
  "改代码", "部署", "重启服务", "迁移数据", "改配置", "上线", "执行命令", "跑脚本",
  "改界面", "改样式", "改交互", "改文案", "前端实现", "写代码", "实现界面", "调整布局",
  "建单", "登记", "落库", "入库", "写入数据库", "查库", "清理数据", "删除数据", "清理掉", "归档清理",
];

const NEGATIONS = ["不要", "不用", "无需", "无权", "禁止", "勿", "别", "不得", "不需要"];

/**
 * 工具需求关键词判定(含否定句剔除)。与 todo_worker.py 的 needs_tools() 语义一致:
 *   "不要把这当作代码/部署任务(你无需也无权改代码)" -> 整句含否定词, 排除 -> false;
 *   "本待办需要工具能力(改代码/查库/部署)"        -> 无否定词 -> true。
 */
export function inferNeedsTools(text: string): boolean {
  const clean: string[] = [];
  for (const raw of String(text || "").replace(/\r/g, "\n").split("\n")) {
    for (const s of raw.replace(/。/g, "\n").replace(/;/g, "\n").replace(/；/g, "\n").split("\n")) {
      if (!s.trim()) continue;
      if (NEGATIONS.some((neg) => s.includes(neg))) continue;
      clean.push(s);
    }
  }
  const joined = clean.join(" ");
  return NEEDS_TOOLS_KEYWORDS.some((k) => joined.includes(k));
}

/** 显式 boolean 优先, 否则平台关键词推断。 */
export function resolveNeedsTools(explicit: unknown, text: string): boolean {
  if (typeof explicit === "boolean") return explicit;
  return inferNeedsTools(text);
}

/** 幂等键: 同 agent 对同现象+同建议动作的重复上报只落一条在办待办。 */
export function findingKey(finding: AgentFinding): string {
  const raw = finding.dedupKey
    ? "dedup|" + finding.sourceAgent + "|" + finding.dedupKey
    : "auto|" + finding.sourceAgent + "|" + finding.symptom.replace(/\s+/g, " ").trim() + "|" + finding.suggestedAction.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** 结构化正文: 四要素显式成段, 便于人和 agent 都能直接读到"现象/证据/建议动作/来源"。 */
export function buildFindingDetail(finding: AgentFinding, extra?: string): string {
  return [
    "【现象】",
    finding.symptom,
    "",
    "【证据】",
    finding.evidence,
    "",
    "【建议动作】",
    finding.suggestedAction,
    "",
    "【来源 agent】",
    finding.sourceAgent + " (经结构化入口 POST /api/v1/flywheel/todos/from-finding 上报)",
    ...(finding.sourceRefId ? ["", "【来源引用】", finding.sourceRefId] : []),
    ...(extra ? ["", "【补充】", extra] : []),
  ].join("\n");
}

export type FindingTodoPlan = {
  finding: AgentFinding;
  key: string;
  needsTools: boolean;
  needsHuman: boolean;
  ownerType: "agent" | "human";
  ownerId: string | null;
  source: string;
  priority: string;
  title: string;
  detail: string;
  evidence: string;
  meta: Record<string, any>;
};

/** 纯函数: 把一条发现算成"要落的待办"(不碰 DB), 便于单测与 dryRun 预览。 */
export function planFindingTodo(finding: AgentFinding, opts?: { humanOperator?: string }): FindingTodoPlan {
  const text = [finding.symptom, finding.evidence, finding.suggestedAction, finding.title, finding.detail]
    .filter(Boolean).join("\n");
  const needsTools = resolveNeedsTools(finding.needsTools, text);
  const needsHuman = finding.needsHuman === true;
  const key = findingKey(finding);
  const source = ("agent:" + finding.sourceAgent + FINDING_SOURCE_SUFFIX).slice(0, 40);
  const title = (finding.title || ("[agent巡检] " + finding.symptom)).slice(0, 300);
  const detail = buildFindingDetail(finding, finding.detail);
  const meta: Record<string, any> = {
    ...(finding.meta || {}),
    fromFinding: true,
    fromAgent: finding.sourceAgent,
    findingKey: key,
    needsTools,
    needsHuman,
    submittedVia: "POST /api/v1/flywheel/todos/from-finding",
    finding: {
      symptom: finding.symptom,
      evidence: finding.evidence,
      suggestedAction: finding.suggestedAction,
    },
  };
  return {
    finding, key, needsTools, needsHuman,
    // needsTools=true 的待办仍是 agent 可领(公开队列) -> todo_worker 认领后按 meta.needsTools 升级给执行体;
    // needsTools=false 的待办也进同一队列, 由文本通道 agent 直接给结论。
    ownerType: needsHuman ? "human" : "agent",
    ownerId: needsHuman ? (opts?.humanOperator || process.env.HUMAN_OPERATOR || "operator") : null,
    source,
    priority: finding.priority || "P2",
    title, detail,
    evidence: finding.evidence,
    meta,
  };
}

/** 查找同 findingKey 且仍在办(OPEN/DOING/BLOCKED)的待办 -> 幂等复用。 */
export async function findOpenTodoByKey(key: string, source: string): Promise<{ id: string; status: string } | null> {
  try {
    const rows: any[] = (await todoRepo.all(
      "SELECT id, status, meta FROM Todo WHERE source = ? AND status IN ('OPEN','DOING','BLOCKED') ORDER BY createdAt DESC", source)) as any[];
    for (const r of rows) {
      try {
        const m = r.meta ? JSON.parse(String(r.meta)) : null;
        if (m && m.findingKey === key) return { id: String(r.id), status: String(r.status) };
      } catch { /* 脏 meta 跳过 */ }
    }
    return null;
  } catch { return null; }
}

export type CreateFindingResult =
  | { ok: true; todoId: string; deduped: boolean; needsTools: boolean; needsHuman: boolean; ownerType: string; source: string; plan: FindingTodoPlan }
  | { ok: false; error: string };

/**
 * 落地一条结构化发现为待办。
 * createTodo 内部吞异常返回 null -> 这里显式暴露落库失败, 不让上报方误以为"已登记"。
 */
export async function createTodoFromFinding(finding: AgentFinding, opts?: { humanOperator?: string }): Promise<CreateFindingResult> {
  const plan = planFindingTodo(finding, opts);
  const existing = await findOpenTodoByKey(plan.key, plan.source);
  if (existing) {
    return { ok: true, todoId: existing.id, deduped: true, needsTools: plan.needsTools, needsHuman: plan.needsHuman, ownerType: plan.ownerType, source: plan.source, plan };
  }
  const input: TodoInput = {
    title: plan.title, detail: plan.detail, source: plan.source, sourceRefId: finding.sourceRefId ?? null,
    ownerType: plan.ownerType, ownerId: plan.ownerId, status: "OPEN", priority: plan.priority,
    evidence: plan.evidence, createdBy: "agent:" + finding.sourceAgent, meta: plan.meta,
  };
  const created = await createTodo(input);
  if (!created) return { ok: false, error: "TODO_INSERT_FAILED" };
  return { ok: true, todoId: created.id, deduped: false, needsTools: plan.needsTools, needsHuman: plan.needsHuman, ownerType: plan.ownerType, source: plan.source, plan };
}
