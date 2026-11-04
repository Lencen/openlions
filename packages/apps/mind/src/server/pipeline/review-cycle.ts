/**
 * review-cycle.ts — 轮值独立审查任务 (2026-09-10 治本层 第2片)
 *
 * 为什么存在: 平台此前"生产者自证 DONE"(任务执行者自己说完成), 缺独立验收; 且多 agent 只当执行手, 无检查职责。
 * 本模块: 每周期生成一条 PLATFORM_REVIEW 任务, 轮值指派给不同 agent, 内容是"本期变更 + 指标快照 + 不变量状态 + 待独立验证项",
 *   要求输出结论 + 证据(commit/DB 查询/接口返回/文件行) + 反例(什么情况下结论不成立) + 建议; 由平台最小校验证据字段。
 */
import { prisma } from "@/lib/prisma";
import { execSync } from "child_process";
import { measureMetrics } from "./goal-gap";

const REPO = "" + (process.env.LIONS_HOME || process.cwd()) + "";

export interface ReviewCycleResult { at: string; cycleKey: string; agent: string | null; taskId: string | null; created: boolean; reason?: string; capabilityNote?: string; evidencePackPreview: string }

function gitLog(sinceHours: number): string {
  try {
    return execSync("git -C " + REPO + " log --since=\"" + sinceHours + " hours ago\" --oneline --no-decorate | head -25", { encoding: "utf-8", timeout: 15000 }).trim();
  } catch { return "(git log 失败)"; }
}

export async function runReviewCycle(opts: { create?: boolean; forceAgent?: string } = {}): Promise<ReviewCycleResult> {
  const now = new Date();
  const cycleKey = now.toISOString().slice(0, 10); // 每日一次
  const theme = "平台审查·" + cycleKey;
  const metrics = await measureMetrics();
  const lastAudit = await prisma.flywheelEvent.findFirst({ where: { stage: "QUALITY_AUDIT" }, orderBy: { createdAt: "desc" }, select: { sourceTitle: true, createdAt: true } });
  let auditInfo: any = null;
  try { auditInfo = JSON.parse(lastAudit?.sourceTitle || "null"); } catch {}
  const pendingGoal = await prisma.task.findMany({ where: { improvementType: { in: ["GOAL_GAP", "THEME_IMPROVE"] }, status: { in: ["PENDING", "IN_PROGRESS"] } }, select: { id: true, theme: true, title: true, acceptanceCriteria: true }, take: 8, orderBy: { createdAt: "desc" } });

  // 轮值(2026-09-10 修复): 必须选"有执行能力证据"的 agent —— 仅靠 AgentRegistry 在线状态会指派给未开 TASK_WORKER 的实例(实测 10 分钟无人认领)。
  //   能力证据 = 近 14 天真实认领过任务(Task.assignedAgent), 按认领次数排序; 无证据者不指派(诚实标注)。
  const agents = await prisma.$queryRawUnsafe<any[]>("SELECT agent_id FROM AgentRegistry WHERE status='ACTIVE' ORDER BY last_seen_at DESC LIMIT 10").catch(() => [] as any[]);
  const claimEvidence = await prisma.$queryRawUnsafe<any[]>("SELECT assignedAgent a, COUNT(*) c, MAX(updatedAt) mx FROM Task WHERE assignedAgent IS NOT NULL AND updatedAt >= ? GROUP BY assignedAgent ORDER BY c DESC", Date.now() - 14 * 24 * 3600 * 1000).catch(() => [] as any[]);
  const capable = (claimEvidence || []).map((r) => String(r.a));
  const prev = await prisma.task.findFirst({ where: { improvementType: "PLATFORM_REVIEW" }, orderBy: { createdAt: "desc" }, select: { assignedAgent: true } });
  const onlineSet = new Set((agents || []).map((a) => String(a.agent_id)));
  const prevReviewer = prev?.assignedAgent || "";
  const capablePool = capable.filter((a) => a !== prevReviewer); // 有认领证据(不要求此刻在线: TASK_WORKER 轮询即会认领)
  const onlinePool = (agents || []).map((a) => String(a.agent_id)).filter((a) => a && a !== prevReviewer);
  const fallbackPool = onlinePool.filter((a) => !capable.includes(a));
  const agent = opts.forceAgent || capablePool[0] || fallbackPool[0] || onlinePool[0] || null;
  const capabilityNote = capablePool.length > 0
    ? "reviewer 有认领能力证据 (近14天完成过任务)"
    : (agent ? "无认领能力证据: 由在线 agent 兜底, 若无人认领需人工指派或为其开启 TASK_WORKER" : "无可用 agent");

  const evidencePack = [
    "本轮审查周期: " + cycleKey,
    "",
    "## 1. 指标快照 (与体检 scorecard 同口径)",
    ...Object.entries(metrics).map(([k, v]) => "- " + k + " = " + (v == null ? "无数据" : v)),
    "",
    "## 2. 最近一次质量体检",
    "- " + (auditInfo ? JSON.stringify(auditInfo).slice(0, 600) : "无"),
    "",
    "## 3. 本期代码变更 (48h)",
    "```",
    gitLog(48),
    "```",
    "",
    "## 4. 待独立验证项 (在途任务, 任选最有价值的核对)",
    ...pendingGoal.map((t) => "- [" + t.id + "] " + String(t.title).slice(0, 90) + " | 验收: " + String(t.acceptanceCriteria || "").slice(0, 80)),
    "",
    "## 5. 你的输出要求 (必须逐项给出)",
    "1) 结论: 平台本周期的健康判断(指标是否真的达标/恶化, 证据是什么);",
    "2) 证据: 每条结论必须给出可复核引用(commit hash / DB 查询 SQL + 结果 / 接口返回 / 文件与行号); 严禁只给描述;",
    "3) 反例: 你的结论在什么情况下不成立(至少 1 条);",
    "4) 建议: 下一周期最该修的一件事(治本优先, 不要只加特判)。",
    "",
    "【诚实底线】本通道无 DB/文件工具时, 只能基于上述证据包做推理判断, 不得声称已执行变更。",
  ].join("\n");

  const existing = await prisma.task.findFirst({ where: { theme, improvementType: "PLATFORM_REVIEW" }, select: { id: true } });
  if (existing) return { at: now.toISOString(), cycleKey, agent, taskId: existing.id, created: false, reason: "本周期审查任务已存在", evidencePackPreview: evidencePack.slice(0, 400) };
  if (!opts.create) return { at: now.toISOString(), cycleKey, agent, taskId: null, created: false, reason: "dry(未创建)", evidencePackPreview: evidencePack.slice(0, 400) };

  const task = await prisma.task.create({
    data: {
      title: "[PLATFORM_REVIEW] " + cycleKey + " 平台独立审查 (审查员: " + (agent || "未指定") + ")",
      description: "【目标】独立审查平台本周期健康状况, 校验在途任务的验收声明是否成立, 给出证据与反例。\n【为什么】当前任务的完成由生产者自证, 缺少独立复核(goals.md §5)。\n【要做什么】按证据包第 5 节输出四段: 结论/证据/反例/建议。\n\n=== 证据包 ===\n" + evidencePack,
      background: "由 review-cycle 自动生成的轮值审查任务; 证据包含指标快照/体检结果/48h 变更/在途验收项",
      requirements: "输出四段(结论/证据/反例/建议); 证据须可复核; 至少 1 条反例; 禁止声称已执行未做的变更。",
      acceptanceCriteria: "四段齐全 + 每条结论附可复核证据引用 + 至少 1 条反例 + 指出一项最该修的治本事项",
      qualityStandards: "独立于执行者 / 证据优先 / 诚实标注通道能力边界",
      materials: JSON.stringify({ cycleKey, metrics, audit: auditInfo, pendingVerification: pendingGoal.map((t) => t.id), howToVerify: "GET /api/v1/flywheel/review-cycle" }),
      structuredContext: JSON.stringify({ sourceChain: { type: "ReviewCycle", id: cycleKey, file: "docs/platform-logic/goals.md" }, rotation: { previousReviewer: prev?.assignedAgent || null, currentReviewer: agent, capabilityNote, capableAgents: capable.slice(0, 8), onlineAgents: Array.from(onlineSet).slice(0, 8) } }),
      status: "PENDING",
      priority: "P1",
      theme,
      improvementType: "PLATFORM_REVIEW",
      manualReview: false,
      assignedAgent: agent,
      sourceReflectionIds: "review:" + cycleKey,
    },
    select: { id: true },
  });
  console.log("[review-cycle] created " + task.id + " for " + cycleKey + " reviewer=" + (agent || "none"));
  return { at: now.toISOString(), cycleKey, agent, taskId: task.id, created: true, capabilityNote, evidencePackPreview: evidencePack.slice(0, 400) };
}
