/**
 * V1.6+ 改进任务生成 (方案A: 主题级合并)
 * 
 * 变更: 一次反思 -> 1 个结构化 THEME_IMPROVE task (不是 6 个零散 task)
 * 
 * task 结构化字段全部填充:
 *   background:       主题 coverage + 遗漏/冲突/改进 概况
 *   requirements:     需要做的事 (合并N条冲突 + 重新提取N个遗漏 + 应用N条改进)
 *   materials:        完整的 missedTopics + conflicts + improvements JSON
 *   acceptanceCriteria: coverage 提升 + 冲突清零 + 无数据丢失
 *   qualityStandards:  白名单保护 + 审计链 + 幂等
 * 
 * improvementPayload 结构:
 *   { actions: [{type, ...data}], summary: {coverageScore, missedCount, ...} }
 * 
 * 幂等: 同 reflectionId 已生成 THEME_IMPROVE -> 跳过
 * 向后兼容: 旧 4 type (FIX_CONFLICT/MIGRATE_DATA/FIX_THEME/RE_RUN) 仍可执行
 */

import { extractLlmText } from "@/server/llm/extract-text";
import { prisma } from "@/lib/prisma";
import type { FlywheelReflectionResult, StructuredFinding } from "./reflect";
import { createHash } from "crypto";
// P1-A 2026-08-31: 统一 fetch 封装 (原本地重复实现移除)
import { fetchWithTimeout, withLlmConcurrency } from "./with-retry";
import { parseStructuredFindings } from "./findings-parse";
// P1-C 2026-08-31: LLM 调用观测
import { recordLlmCall } from "./llm-observability";

export type ImprovementType = "FIX_THEME" | "FIX_CONFLICT" | "MIGRATE_DATA" | "RE_RUN" | "THEME_IMPROVE" | "BRIDGE";

export interface GeneratedImprovingTask {
  taskId: string;
  type: ImprovementType;
  title: string;
  reason: string;
}

interface ImprovementAction {
  type: "MERGE_CONFLICT" | "RE_EXTRACT" | "MIGRATE_DATA" | "APPLY_IMPROVEMENT";
  [key: string]: any;
}

interface LLMAction {
  type: "MERGE_CONFLICT" | "RE_EXTRACT" | "APPLY_IMPROVEMENT";
  priority: "P0" | "P1" | "P2";
  description: string;
  expectedImpact: string;
  autoExecute: boolean;
  targetMemoryIds?: string[];
  missedTopics?: string[];
}

interface LLMAnalysisResult {
  actions: LLMAction[];
  reasoning: string;
}

/**
 * 方案C: LLM 分析反思产物 -> 0-3 个结构化 action
 * 
 * LLM 决定:
 *   - 生成几个 action (0-3, 不是固定 6 个)
 *   - 每个 action 的类型/优先级/描述/预期效果
 *   - 是否可自动执行 (autoExecute)
 *   - coverage > 0.7 且无冲突 -> 可不生成任何 action
 */
async function callLLMAnalyzeReflection(params: {
  theme: string;
  coverageScore: number;
  missedTopics: string[];
  improvements: string[];
  conflicts: any[];
}): Promise<LLMAnalysisResult | null> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  if (!apiKey) {
    console.log("[generate-improving-tasks:V2-LLM] SKIP: API key 未配置, fallback 到规则");
    return null;
  }
  const MODEL = process.env.ANTHROPIC_MODEL || "MiniMax-M3";

  const { theme, coverageScore, missedTopics, improvements, conflicts } = params;

  const conflictInfo = conflicts.length > 0
    ? conflicts.map((c, i) => `  组${i+1}: ${(c?.memoryIds || []).join(",")} 原因: ${(c?.reason || "").slice(0, 80)}`).join("\n")
    : "无";

  const prompt = `你是 LIONS 知识管理飞轮的问题分析师。请分析以下反思结果, 生成 0-3 个结构化改进任务。

主题: ${theme}
Coverage: ${coverageScore.toFixed(2)}

遗漏主题 (${missedTopics.length} 个):
${missedTopics.map((t, i) => `  ${i+1}. ${t}`).join("\n")}

改进建议 (${improvements.length} 条):
${improvements.map((t, i) => `  ${i+1}. ${t}`).join("\n")}

冲突冗余 (${conflicts.length} 组):
${conflictInfo}

分析规则:
1. 如果 coverage >= 0.7 且无冲突, 不需要生成任何 action (返回空数组)
2. 冲突冗余 -> MERGE_CONFLICT (可自动执行)
3. 遗漏主题 + coverage < 0.5 -> RE_EXTRACT (可自动执行)
4. 改进建议 -> APPLY_IMPROVEMENT (默认需人审, autoExecute=false)
5. 最多 3 个 action, 按优先级排序
6. description 必须是可执行的具体描述, 不是短关键词
   例: ❌ "括号平衡算法"  ✅ "从对话中提取括号平衡JSON解析算法的完整实现, 写入 Knowledge 表, 覆盖 Agent调度 主题"

严格按 JSON 返回:
{
  "actions": [
    {
      "type": "MERGE_CONFLICT" | "RE_EXTRACT" | "APPLY_IMPROVEMENT",
      "priority": "P0" | "P1" | "P2",
      "description": "具体的可执行描述 (50-200字)",
      "expectedImpact": "预期效果 (如 coverage 0.35 -> 0.55)",
      "autoExecute": true | false,
      "targetMemoryIds": ["id1", "id2"]  // MERGE_CONFLICT 必填
    }
  ],
  "reasoning": "分析过程简述 (为什么生成这些 action)"
}`;

  // 2026-09-10 消费侧: 生成改进任务前读平台已有记忆/知识(纯函数调用, 零 HTTP)。
  //   变量只用本函数作用域内确实存在的 prompt — 上一版误用 theme 导致运行期 500, 已回滚并修正。
  let ctxText = "";
  try {
    const cs = await import("./context-seed");
    const hits = await cs.searchContext({ query: String(prompt).slice(0, 120), limit: 5, source: "improving-tasks-gen" });
    if (hits.length) ctxText = "\n\n[平台已有记忆/知识(请参考, 不要与既有认知矛盾或重复)]\n" + cs.renderContextSeed(hits, 4000); // 2026-09-23 uos20 #1: 生成器路径 1000 -> 4000 字符(主注入路径走 50K+ 预算)
  } catch { /* 增强失败不影响生成 */ }

  try {
    const t0 = Date.now();
    // P0-3 (2026-09-01): 全局并发信号量
    const resp = await withLlmConcurrency(() => fetchWithTimeout(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: "你是 LIONS 飞轮引擎的问题分析师。分析反思结果, 生成结构化改进任务。严格按 JSON 返回。",
        messages: [{ role: "user", content: prompt + ctxText }],
      }),
    }, 60000));

    if (!resp.ok) {
      recordLlmCall({ entry: "improving-tasks", ok: false, durationMs: Date.now() - t0, errorType: `HTTP_${resp.status}`, promptLength: prompt.length });
      throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    // 2026-10-26 精确 token: 必须在解析响应后拿 usage（此前先记账、后解析 -> token 永远缺失）。
    const data: any = await resp.json().catch(() => null);
    if (!data) {
      recordLlmCall({ entry: "improving-tasks", ok: false, durationMs: Date.now() - t0, errorType: "PARSE_INVALID_JSON", promptLength: prompt.length, model: MODEL });
      throw new Error("LLM 返回不是合法 JSON");
    }
    const _u = data.usage || {};
    const _tk = Number(_u.input_tokens ?? _u.prompt_tokens ?? 0) + Number(_u.output_tokens ?? _u.completion_tokens ?? 0);
    recordLlmCall({ entry: "improving-tasks", ok: true, durationMs: Date.now() - t0, promptLength: prompt.length, tokenUsed: _tk > 0 ? _tk : undefined, model: MODEL });
    const content = extractLlmText(data);
    if (!content) throw new Error("LLM 无返回内容");

    // 剥离 Markdown 代码块
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    }
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed.actions)) {
      throw new Error(`LLM 输出无 actions[]: keys=${Object.keys(parsed)}`);
    }

    console.log(`[generate-improving-tasks:V2-LLM] LLM 返回 ${parsed.actions.length} actions: ${parsed.reasoning?.slice(0, 100) || "no reasoning"}`);

    return {
      actions: parsed.actions.slice(0, 3).map((a: any) => ({
        type: a.type,
        priority: a.priority || "P2",
        description: String(a.description || "").slice(0, 500),
        expectedImpact: String(a.expectedImpact || "").slice(0, 200),
        autoExecute: !!a.autoExecute,
        targetMemoryIds: Array.isArray(a.targetMemoryIds) ? a.targetMemoryIds : [],
        missedTopics: Array.isArray(a.missedTopics) ? a.missedTopics : [],
      })),
      reasoning: String(parsed.reasoning || "").slice(0, 300),
    };
  } catch (e: any) {
    console.warn(`[generate-improving-tasks:V2-LLM] LLM 调用失败, fallback 到规则: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

/**
 * 2026-09-09 任务合并(非孤立/省调用): 同主题活跃任务吸收本轮反思快照
 * - findings 按 dedupHash 追加去重; cycles[] 记录每轮来源(反思ID/时间/coverage/遗漏/建议)
 * - 不新建任务 → 每主题同一时刻 ≤1 个活跃 THEME_IMPROVE, 执行一次消化全部事项, 不重复调 LLM 分析
 */
async function mergeReflectionIntoActiveTask(
  taskId: string,
  reflectionId: string,
  theme: string,
  coverage: number,
  missedTopics: any[],
  improvements: any[],
  conflicts: any[],
  aliasTheme: string = "",
): Promise<{ addedFindings: number; missedTopics: any[] }> {
  const task: any = await prisma.task.findUnique({
    where: { id: taskId },
    select: { improvementPayload: true },
  });
  let payload: any = {};
  try { payload = task?.improvementPayload ? JSON.parse(task.improvementPayload) : {}; } catch { payload = {}; }
  payload.actions = payload.actions || [];
  payload.findings = payload.findings || [];

  let addedFindings = 0;
  try {
    const recTheme = aliasTheme || theme;
    const reflRecord: any = await prisma.flywheelReflection.findUnique({
      where: { theme: recTheme },
      select: { structuredFindings: true },
    });
    if (reflRecord?.structuredFindings) {
      const all: any[] = parseStructuredFindings(reflRecord.structuredFindings).filter((f: any) => f.status !== "RESOLVED" && f.status !== "NEEDS_REVIEW");
      const have = new Set((payload.findings || []).map((f: any) => f.dedupHash).filter(Boolean));
      const fresh = all.filter((f: any) => !have.has(f.dedupHash));
      if (fresh.length > 0) { payload.findings.push(...fresh); addedFindings = fresh.length; }
    }
  } catch (e: any) {
    console.warn(`[generate-improving-tasks:V2] merge findings fail (非致命): ${(e?.message || "").slice(0, 80)}`);
  }

  // cycles: 来源链审计 (每轮反思进入任务的快照)
  if (aliasTheme) {
    payload.aliasedThemes = payload.aliasedThemes || [];
    if (!payload.aliasedThemes.includes(aliasTheme)) payload.aliasedThemes.push(aliasTheme);
  }
  payload.cycles = payload.cycles || [];
  payload.cycles.push({
    reflectionId,
    theme: aliasTheme || theme,
    at: new Date().toISOString(),
    coverage,
    missedTopics: (missedTopics || []).slice(0, 10),
    improvements: (improvements || []).slice(0, 5),
    conflicts: (conflicts || []).slice(0, 3),
  });
  // 2026-09-10 契约完整性: 合并路径此前不更新 appliedTargets -> 合并任务缺"结果应用到哪里"
  //   现按合并后的 findings + actions 重算, 保证该契约字段始终存在。
  {
    const at: Record<string, number> = {};
    for (const f of payload.findings || []) {
      const t = String(f?.actionType || "");
      if (t === "CREATE_MEMORY") at.Memory = (at.Memory || 0) + 1;
      else if (t === "CREATE_KNOWLEDGE") at.Knowledge = (at.Knowledge || 0) + 1;
      else if (t === "CREATE_PRACTICE") at.Practice = (at.Practice || 0) + 1;
      else if (t === "MERGE_CONFLICT") at["Memory(合并)"] = (at["Memory(合并)"] || 0) + 1;
    }
    for (const a of payload.actions || []) {
      const t = String(a?.type || "");
      if (t === "MERGE_CONFLICT") at["Memory(合并)"] = (at["Memory(合并)"] || 0) + 1;
      else if (t === "RE_EXTRACT") at["Reflection(重提取)"] = (at["Reflection(重提取)"] || 0) + 1;
    }
    payload.appliedTargets = at;
  }
  payload.summary = payload.summary || {};
  payload.summary.coverageScore = coverage;
  payload.summary.cycleCount = payload.cycles.length;
  payload.summary.findingCount = payload.findings.length;

  // sourceReflectionIds 追加(支持跨主题别名合并: 存 JSON 数组文本)
  const curTask: any = await prisma.task.findUnique({ where: { id: taskId }, select: { sourceReflectionIds: true } });
  let idsText: string;
  try {
    const cur = curTask?.sourceReflectionIds ? JSON.parse(curTask.sourceReflectionIds) : null;
    if (Array.isArray(cur)) {
      const set = new Set([...cur, reflectionId]);
      idsText = JSON.stringify(Array.from(set));
    } else {
      idsText = curTask?.sourceReflectionIds === reflectionId ? curTask.sourceReflectionIds : JSON.stringify([curTask?.sourceReflectionIds, reflectionId].filter(Boolean));
    }
  } catch { idsText = JSON.stringify([curTask?.sourceReflectionIds, reflectionId].filter(Boolean)); }
  await prisma.$executeRawUnsafe(
    "UPDATE Task SET improvementPayload=?, sourceReflectionIds=?, updatedAt=? WHERE id=?",
    JSON.stringify(payload), idsText, new Date(), taskId
  );
  return { addedFindings, missedTopics: missedTopics || [] };
}


// ===== 跨主题相似合并 (2026-09-09): 相似主题名(前缀包含/高 Dice)的活跃任务别名并入 =====
function _normTheme(s: string): string {
  return String(s || "").toLowerCase().replace(/[^0-9a-z一-鿿]/g, "");
}
export function themeSimilar(a: string, b: string): { similar: boolean; score: number; reason: string } {
  const na = _normTheme(a), nb = _normTheme(b);
  if (!na || !nb) return { similar: false, score: 0, reason: "empty" };
  if (na === nb) return { similar: true, score: 1, reason: "exact" };
  const min = Math.min(na.length, nb.length);
  const contain = min >= 2 && (na.includes(nb) || nb.includes(na));
  const big = (s: string) => { const set = new Set<string>(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); if (set.size === 0) set.add(s); return set; };
  const A = big(na), B = big(nb);
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  const dice = (2 * inter) / (A.size + B.size);
  const similar = contain || dice >= 0.5;
  return { similar, score: Math.max(dice, contain ? 1 : 0), reason: contain ? "containment" : dice >= 0.5 ? "dice>=0.5" : "no" };
}
async function findSimilarActiveTask(theme: string, selfReflectionId: string): Promise<{ id: string; theme: string } | null> {
  const actives: any[] = await prisma.task.findMany({
    where: { improvementType: "THEME_IMPROVE", status: { in: ["PENDING", "PROCESSING", "IN_PROGRESS"] }, theme: { not: null } },
    select: { id: true, theme: true, sourceReflectionIds: true },
    orderBy: { updatedAt: "desc" },
    take: 300,
  }).catch(() => []);
  let best: { id: string; theme: string } | null = null;
  let bestScore = 0;
  for (const t of actives || []) {
    if (t.theme === theme) continue;
    if (t.sourceReflectionIds && String(t.sourceReflectionIds).includes(selfReflectionId)) continue;
    const r = themeSimilar(t.theme || "", theme);
    if (r.similar && r.score > bestScore) { bestScore = r.score; best = { id: t.id, theme: t.theme }; }
  }
  return best;
}

export async function generateImprovingTasks(

  reflection: FlywheelReflectionResult | {
    id: string;
    theme: string;
    missedTopics: string[] | string;
    improvements: string[] | string;
    conflicts?: any[] | string | null;
    coverageScore: number;
  },
): Promise<GeneratedImprovingTask[]> {
  const t1 = Date.now();
  const reflectionId = reflection.id;
  const theme = reflection.theme;
  const coverage = reflection.coverageScore;
  console.log(`[generate-improving-tasks:V2] START reflection="${reflectionId}" theme="${theme}" coverage=${coverage}`);

  // 解析 JSON 字段
  const missedTopics = Array.isArray(reflection.missedTopics)
    ? reflection.missedTopics
    : JSON.parse(reflection.missedTopics || "[]");
  const improvements = Array.isArray(reflection.improvements)
    ? reflection.improvements
    : JSON.parse(reflection.improvements || "[]");
  const conflicts = reflection.conflicts == null
    ? []
    : Array.isArray(reflection.conflicts)
      ? reflection.conflicts
      : JSON.parse(reflection.conflicts || "[]");

// 幂等 + 生命周期 (2026-09-09 任务非孤立/上下文版本):
  //   同 reflectionId = 同主题唯一反思行, 周期内可能反复调用:
  //   - 已有活跃任务(PENDING/PROCESSING) → 合并本轮快照(不新建、不重复调 LLM 分析)
  //   - 已有 DONE/FAILED(已消费) → 反思 updatedAt 新于任务才开新一轮
  // 0) 2026-09-15 P0 机制修复: 同一主题 48h 内已有 DONE/FAILED 任务 → 禁止重复建单
  //   根因: 历史数据显示「数据管理」主题 9 条同标题任务反复创建, 「飞轮闭环」9 条, 「会话管理」8 条
  //   (sql 复算: SELECT theme, count(*) FROM Task WHERE improvementType='THEME_IMPROVE' GROUP BY theme)
  //   → 反思只要更新(updatedAt 晚于最近消费任务)就触发新建, 即使上一轮 30 分钟前刚做完。
  //   闸门: 同 theme 在 48h 内已有 DONE/FAILED → SKIP, 强制进 48h 冷静期(防止空转)。
  //   例外: coverage < 0.3 且 missedTopics.length > 5(确为"主题仍未稳定")才允许新建。
  const THEME_DEDUP_WINDOW_MS = 48 * 3600 * 1000;
  const recentSameTheme: any = await prisma.task.findFirst({
    where: {
      improvementType: "THEME_IMPROVE",
      theme,
      status: { in: ["DONE", "FAILED"] },
      completedAt: { gte: new Date(Date.now() - THEME_DEDUP_WINDOW_MS) },
    },
    select: { id: true, status: true, completedAt: true, improvementPayload: true },
    orderBy: { completedAt: "desc" },
  });
  if (recentSameTheme) {
    const trulyNeeded = coverage < 0.3 && missedTopics.length > 5;
    if (!trulyNeeded) {
      console.log(`[generate-improving-tasks:V2] SKIP theme="${theme}" 48h 冷静期: 最近任务=${recentSameTheme.id} status=${recentSameTheme.status} completedAt=${recentSameTheme.completedAt?.toISOString?.() || recentSameTheme.completedAt} (coverage=${coverage}, missed=${missedTopics.length})`);
      return [];
    }
    console.log(`[generate-improving-tasks:V2] EXCEPTION theme="${theme}" 覆盖 48h 闸门: coverage=${coverage}<0.3 且 missed=${missedTopics.length}>5`);
  }
  // 1) 同源反思已存在活跃任务 → 合并本轮快照(不新建、不重复调 LLM 分析)
  const activeTask: any = await prisma.task.findFirst({
    where: {
      sourceReflectionIds: { contains: reflectionId },
      improvementType: "THEME_IMPROVE",
      status: { in: ["PENDING", "PROCESSING", "IN_PROGRESS"] },
    },
    select: { id: true },
  });
  if (activeTask) {
    const merged = await mergeReflectionIntoActiveTask(activeTask.id, reflectionId, theme, coverage, missedTopics, improvements, conflicts);
    console.log(`[generate-improving-tasks:V2] MERGE theme="${theme}" into active task=${activeTask.id} findings+${merged.addedFindings} missed=${merged.missedTopics.length}`);
    return [];
  }
  // 2) 已消费任务(DONE/FAILED): 仅当反思更新(updatedAt 晚于最近消费任务)才开新一轮
  const consumedTask: any = await prisma.task.findFirst({
    where: {
      sourceReflectionIds: { contains: reflectionId },
      improvementType: "THEME_IMPROVE",
      status: { in: ["DONE", "FAILED"] },
    },
    select: { updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  if (consumedTask) {
    const reflRow: any = await prisma.flywheelReflection.findUnique({
      where: { id: reflectionId }, select: { updatedAt: true },
    }).catch(() => null);
    const reflAt = reflRow?.updatedAt ? new Date(reflRow.updatedAt).getTime() : Date.now();
    const taskAt = consumedTask.updatedAt ? new Date(consumedTask.updatedAt).getTime() : 0;
    if (reflAt <= taskAt) {
      console.log(`[generate-improving-tasks:V2] SKIP reflection="${reflectionId}" 最近任务已消费且反思未更新 (refl=${reflAt}<=task=${taskAt})`);
      return [];
    }
    console.log(`[generate-improving-tasks:V2] 反思已更新 (refl=${reflAt} > task=${taskAt}) → 开新一轮 THEME_IMPROVE theme="${theme}"`);
  }

  // 3) 同主题 48h 冷却 (2026-09-16 f-006 / THEME_IMPROVE 空转修复)
  //   实测: 同主题 (如 "数据管理"/"环境配置") 7d 内反复建单 2-3 次, 每次都消化不完全 -> 队列空转 + 重复 LLM 分析浪费。
  //   即使反思已更新, 若该主题 48h 内已有任何状态的 THEME_IMPROVE, 跳过本轮建单 (反思增量并入最近一次任务的 findings 即可)。
  //   这是结构性修复, 任何生成器都不得绕过 (防止同类 bug 复发)。
  // P0-2 修复 (2026-09-16): 原 commit 725b660 用 recentSameTheme (上面 DONE/FAILED 块变量) 判断,
  //   当 0) 块已 SKIP 返回则代码不可达; 当 0) 块命中 coverage 例外放行, 此处也因变量被覆盖误跳。
  //   改为本块独立声明 recentSameThemeAny, 本块管"任意状态"更严, 与 0) 块互补不互斥。
  const COOLDOWN_MS = 48 * 60 * 60 * 1000;
  const recentSameThemeAny: any = await prisma.task.findFirst({
    where: {
      theme,
      improvementType: "THEME_IMPROVE",
      createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) },
    },
    select: { id: true, status: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (recentSameThemeAny) {
    // 把本轮新增的 findings 增量并入最近任务(同主题 48h 内), 而不是建新任务
    try {
      const merged = await mergeReflectionIntoActiveTask(
        recentSameThemeAny.id,
        reflectionId,
        theme,
        coverage,
        missedTopics,
        improvements,
        conflicts,
      );
      console.log(
        `[generate-improving-tasks:V2] COOLDOWN theme="${theme}" -> 合并到 task=${recentSameThemeAny.id} ` +
        `(status=${recentSameThemeAny.status}, age=${Math.round((Date.now() - new Date(recentSameThemeAny.createdAt).getTime()) / 3600000)}h, +${merged.addedFindings} findings)`,
      );
    } catch (e: any) {
      console.warn(`[generate-improving-tasks:V2] COOLDOWN 合并失败 (非致命, 继续): ${String(e?.message || "").slice(0, 120)}`);
    }
    return [];
  }

  // 4) 跨主题相似合并: 相似主题已有活跃任务 → 别名并入(收敛碎片主题, 不重复分析/执行)
  const similarActive = await findSimilarActiveTask(theme, reflectionId);
  if (similarActive) {
    const merged = await mergeReflectionIntoActiveTask(similarActive.id, reflectionId, similarActive.theme, coverage, missedTopics, improvements, conflicts, theme);
    console.log(`[generate-improving-tasks:V2] ALIAS-MERGE theme="${theme}" → task=${similarActive.id} (主主题 "${similarActive.theme}") findings+${merged.addedFindings}`);
    return [];
  }

  // V1.8: 加载 structuredFindings, 过滤 RESOLVED
  let structuredFindings: StructuredFinding[] = [];
  try {
    const reflRecord = await prisma.flywheelReflection.findUnique({
      where: { theme },
      select: { structuredFindings: true, id: true },
    });
    if (reflRecord?.structuredFindings) {
      const allFindings: StructuredFinding[] = parseStructuredFindings(reflRecord.structuredFindings) as StructuredFinding[];
      // F3 去重收敛: 只保留 NEW + RECURRING (跳过 RESOLVED / NEEDS_REVIEW)
      //   2026-09-10: NEEDS_REVIEW = 低置信待人工复核, 不重复建任务(否则每轮都会建任务->执行->再被拦)
      structuredFindings = allFindings.filter(f => f.status !== "RESOLVED" && f.status !== "NEEDS_REVIEW");
      console.log(`[generate-improving-tasks:V2] theme="${theme}" findings: ${allFindings.length} total, ${structuredFindings.length} active (RESOLVED=${allFindings.length - structuredFindings.length})`);
    }
  } catch (e: any) {
    console.warn(`[generate-improving-tasks:V2] 加载 structuredFindings 失败 (非致命): ${e.message?.slice(0, 100)}`);
  }

  // V1.8 F3: dedupHash 去重 - 检查是否已有 PENDING task 包含相同 dedupHash
  if (structuredFindings.length > 0) {
    const pendingTasks = await prisma.task.findMany({
      where: { theme, status: "PENDING", improvementType: "THEME_IMPROVE" },
      select: { improvementPayload: true },
    });
    const existingHashes = new Set<string>();
    for (const pt of pendingTasks) {
      try {
        const p = JSON.parse(pt.improvementPayload || "{}");
        if (p.findings) {
          for (const f of p.findings) {
            if (f.dedupHash) existingHashes.add(f.dedupHash);
          }
        }
      } catch {}
    }
    if (existingHashes.size > 0) {
      const before = structuredFindings.length;
      structuredFindings = structuredFindings.filter(f => !existingHashes.has(f.dedupHash));
      console.log(`[generate-improving-tasks:V2] dedupHash 去重: ${before} -> ${structuredFindings.length} (已存在 ${existingHashes.size} 个 hash)`);
    }
  }

  // ===== 方案C: 先 LLM 分析, 失败 fallback 到规则 =====
  let actions: ImprovementAction[] = [];
  let llmReasoning = "";

  // 尝试 LLM 分析
  const llmResult = await callLLMAnalyzeReflection({
    theme, coverageScore: coverage, missedTopics, improvements, conflicts,
  });

  if (llmResult && llmResult.actions.length > 0) {
    // LLM 路径: 转换 LLM actions -> ImprovementAction
    llmReasoning = llmResult.reasoning;
    for (const la of llmResult.actions) {
      switch (la.type) {
        case "MERGE_CONFLICT":
          // 用 LLM 指定的 targetMemoryIds, 或回退到 conflicts 的 memoryIds
          const memoryIds = la.targetMemoryIds?.length
            ? la.targetMemoryIds
            : (conflicts[0]?.memoryIds || []);
          if (memoryIds.length > 0) {
            actions.push({
              type: "MERGE_CONFLICT",
              memoryIds,
              reason: la.description.slice(0, 500),
              priority: la.priority,
              expectedImpact: la.expectedImpact,
            });
          }
          break;
        case "RE_EXTRACT":
          actions.push({
            type: "RE_EXTRACT",
            missedTopics: la.missedTopics?.length ? la.missedTopics : missedTopics.slice(0, 10),
            coverageScore: coverage,
            reason: la.description.slice(0, 500),
            priority: la.priority,
            expectedImpact: la.expectedImpact,
          });
          break;
        case "APPLY_IMPROVEMENT":
          actions.push({
            type: "APPLY_IMPROVEMENT",
            improvement: la.description.slice(0, 500),
            manualReview: !la.autoExecute,
            priority: la.priority,
            expectedImpact: la.expectedImpact,
          });
          break;
      }
    }
    console.log(`[generate-improving-tasks:V2-LLM] 使用 LLM actions: ${actions.length} 个`);
  } else if (llmResult && llmResult.actions.length === 0) {
    // LLM 明确判断不需要 action
    console.log(`[generate-improving-tasks:V2-LLM] LLM 判断无需 action: ${llmResult.reasoning.slice(0, 100)}`);
    return [];
  } else {
    // Fallback: 规则化 (方案A)
    console.log(`[generate-improving-tasks:V2] Fallback 到规则化生成`);

    // 规则 1: 冲突合并
    for (let i = 0; i < conflicts.length; i++) {
      const c = conflicts[i];
      const memoryIds: string[] = c?.memoryIds || c?.memory_id_list || [];
      if (memoryIds.length === 0) continue;
      const reason = c?.reason || `conflict group ${i + 1}`;
      actions.push({
        type: "MERGE_CONFLICT",
        memoryIds,
        reason: reason.slice(0, 500),
        conflictIndex: i + 1,
      });
    }

    // 规则 2: 重新提取 (coverage < 0.5 且有遗漏)
    if (coverage < 0.5 && missedTopics.length > 0) {
      actions.push({
        type: "RE_EXTRACT",
        missedTopics: missedTopics.slice(0, 10).map((mt: any) => String(mt).slice(0, 200)),
        coverageScore: coverage,
        reason: `coverage=${coverage.toFixed(2)} < 0.5, missed=${missedTopics.length}`,
      });
    }

    // 规则 3: 改进建议
    for (const imp of improvements) {
      if (typeof imp !== "string") continue;
      actions.push({
        type: "APPLY_IMPROVEMENT",
        improvement: imp.slice(0, 500),
        manualReview: true,
      });
    }
  }

  // 如果没有任何 action, 不生成 task
  if (actions.length === 0) {
    console.log(`[generate-improving-tasks:V2] SKIP reflection="${reflectionId}" no actions needed (coverage=${coverage}, no conflicts/improvements)`);
    return [];
  }

  // ===== 分类统计 (守卫可能丢弃幻觉动作, 见下方重算) =====
  let actionCounts = {
    MERGE_CONFLICT: actions.filter(a => a.type === "MERGE_CONFLICT").length,
    RE_EXTRACT: actions.filter(a => a.type === "RE_EXTRACT").length,
    MIGRATE_DATA: actions.filter(a => a.type === "MIGRATE_DATA").length,
    APPLY_IMPROVEMENT: actions.filter(a => a.type === "APPLY_IMPROVEMENT").length,
  };

  // ===== 填充结构化字段 =====
  // 2026-09-09 上下文增强: 拉取主题真实活跃记忆(证据/来源) + 反思更新时间
  let relatedMems: any[] = [];
  try {
    relatedMems = await prisma.memory.findMany({
      where: { theme, supersededBy: null },
      select: { id: true, title: true, content: true },
      orderBy: { valueScore: "desc" },
      take: 10,
    });
  } catch {}
  let reflRow2: any = null;
  try {
    reflRow2 = await prisma.flywheelReflection.findUnique({ where: { id: reflectionId }, select: { updatedAt: true, coverageScore: true } });
  } catch {}
  const relatedMemIds = (relatedMems || []).map((m: any) => m.id);
  const reflUpdatedAt = reflRow2?.updatedAt ? new Date(reflRow2.updatedAt).toISOString() : "";
  const background = [
    `主题: ${theme}`,
    `Coverage: ${coverage.toFixed(4)} (${coverage < 0.3 ? "低" : coverage < 0.5 ? "中低" : coverage < 0.7 ? "中" : "良好"})`,
    `遗漏主题: ${missedTopics.length} 个`,
    `冲突冗余: ${conflicts.length} 组`,
    `改进建议: ${improvements.length} 条`,
    `反思ID: ${reflectionId}${reflUpdatedAt ? ` (反思更新: ${reflUpdatedAt})` : ""}`,
    `关联活跃记忆 ${relatedMems.length} 条: ${relatedMemIds.map((i: string) => i.slice(-6)).join(", ") || "无"}`,
  ].join("\n");

  const requirements = [
    actions.filter(a => a.type === "MERGE_CONFLICT").length > 0
      ? `合并 ${actionCounts.MERGE_CONFLICT} 组冲突 Memory (自动执行)`
      : null,
    actions.filter(a => a.type === "RE_EXTRACT").length > 0
      ? `重新提取 ${missedTopics.length} 个遗漏主题 (增量检查, 有新对话才执行)`
      : null,
    actions.filter(a => a.type === "MIGRATE_DATA").length > 0
      ? `处理 ${actionCounts.MIGRATE_DATA} 条数据迁移建议 (需人工审核)`
      : null,
    actions.filter(a => a.type === "APPLY_IMPROVEMENT").length > 0
      ? `应用 ${actionCounts.APPLY_IMPROVEMENT} 条改进建议 (需人工审核)`
      : null,
  ].filter(Boolean).join("\n");

  const materials = JSON.stringify({
    missedTopics: missedTopics.slice(0, 10),
    conflicts: conflicts.map((c: any) => ({
      memoryIds: c?.memoryIds || c?.memory_id_list || [],
      reason: (c?.reason || "").slice(0, 200),
    })),
    improvements: improvements.map((i: any) => String(i).slice(0, 300)),
    // 2026-09-09 上下文增强: 真实关联记忆 + 反思来源更新时间 (任务不孤立)
    relatedMemoryIds: relatedMemIds,
    reflectionUpdatedAt: reflUpdatedAt,
    reflectionId,
  }, null, 2);

  // 2026-09-18 修(生成侧缺口, 实测): 原验收是四句**散文**, 没有任何可复算锚点 —— 于是自动生成的任务
  //   在粒度体检里恒判 V1(无验收锚点), 执行体拿到的是"看起来有意义但无法证伪"的要求, 验收也只能靠读产出。
  //   平台已经有现成的复算命令(task-metrics / data-quality-audit)与审计表, 直接写进验收, 让"做没做到"可机检。
  const acceptanceCriteria = [
    `冲突 Memory 合并后 supersededBy 链完整 (无孤儿)`,
    coverage < 0.5 ? `Coverage 从 ${coverage.toFixed(2)} 提升 (有新对话时)` : `Coverage 保持 >= 0.5`,
    `MIGRATE_DATA/APPLY_IMPROVEMENT 标记 manualReview=true, 不自动执行`,
    `TaskStateTransition 审计链完整 (PROCESSING -> DONE/SKIPPED)`,
    // —— 可复算锚点(粒度规范 G2) ——
    `【复算】① cmd: node scripts/task-metrics.cjs --json 中本主题 coverage 读数不低于 ${coverage.toFixed(2)} 或给出反例;` +
      ` ② cmd: node scripts/data-quality-audit.cjs --json 中『可处置: 幽灵引用』与孤儿 Memory 相关项**不新增**;` +
      ` ③ sql: SELECT COUNT(*) FROM TaskStateTransition WHERE taskId='<本任务id>' 应 >= 2(PROCESSING 与终态各一)。`,
  ].join("\n");

  const qualityStandards = [
    `白名单保护: domain=flywheel-reflect 的 Memory 不被自动修改`,
    `幂等: 同 reflectionId 不重复生成 THEME_IMPROVE task`,
    `审计: 每个 action 执行结果记入 improvementPayload.consumedResults`,
    `安全: MIGRATE_DATA SQL 必须人工审核 (manualReview=true)`,
  ].join("\n");

  // ===== 2026-09-09 诚实性修复: MERGE_CONFLICT 必须引用真实 Memory ID (LLM 常输出幻觉短 ID) =====
  // ===== 2026-09-14 修正: "短 ID" 未必是幻觉 —— reflect 提示(见 reflect.ts:631-640)只把
  //   `id.slice(-6)` 交给 LLM, LLM 据此回填的 6 位后缀**确实是真实行的主键后 6 位**。
  //   原实现只用完整 ID 精确匹配, 于是把真实行全部 DROP 成"幻觉 ID"(实测 f-002 的
  //   4x11za/ro3wwa/lu90ve 分别解析到 cmtu8peac0czcicltkk4x11za / cmtz1ud9y018ro3wwa /
  //   cmtz1ud9y0191lu90ve, 均为真实行)。这里保留"防幻觉"闸门的同时, 先用**唯一后缀**回解真实主键:
  //   仅当后缀在 Memory 表中**恰好命中 1 行**时才解析, 命中 0 行或 >1 行仍按无法证实处理并 DROP。
  const mergeActions = actions.filter(a => a.type === "MERGE_CONFLICT");
  if (mergeActions.length > 0) {
    const allIds: string[] = Array.from(new Set(mergeActions.flatMap((a: any) => (a.memoryIds || []).filter((id: string) => !!id))));
    let realIds = new Set<string>();
    if (allIds.length > 0) {
      const rows = await prisma.memory.findMany({ where: { id: { in: allIds } }, select: { id: true } });
      realIds = new Set(rows.map(r => r.id));
    }
    // 后缀 -> 真实主键 的唯一解析表 (未解析成功的短 ID 保持 null, 后续按"不存在"处理)
    const resolved = new Map<string, string | null>();
    for (const raw of allIds) {
      if (realIds.has(raw)) { resolved.set(raw, raw); continue; }
      if (raw.length <= 8) {
        const hits = await prisma.memory.findMany({ where: { id: { endsWith: raw } }, select: { id: true } });
        let only = hits.length === 1 ? hits[0].id : null;
        let crossHits: string[] = [];
        if (only) {
          // ===== 2026-09-15 独立复核反例(唯一 ≠ 意图): 6 位后缀空间**跨实体共享** =====
          //   实测 Knowledge/Practice/Reflection 与 Memory 存在同后缀但不同主键的行
          //   (如 nzm6hq: Knowledge cmr9ozxth… 与 Memory cmt3jc369…)。
          //   仅按 Memory 唯一命中, 会把"其实指向别的实体"的短串解析成**另一条真实 Memory**,
          //   随后 MERGE_CONFLICT 会 supersede 错误行 = 静默数据损坏, 且"命中数!=1"判据无法察觉。
          //   故解析成功后必须再查其它实体表: 只要同后缀在别的实体里存在**不同的行**, 即判跨实体歧义 -> 拒绝解析(仍 DROP)。
          //   (复算: scripts/probes/probe-reflect-suffix-id-resolution.cjs C6 会打印碰撞清单)
          const cross = await Promise.all([
            prisma.knowledge.findMany({ where: { id: { endsWith: raw } }, select: { id: true } }).catch(() => [] as any[]),
            prisma.practice.findMany({ where: { id: { endsWith: raw } }, select: { id: true } }).catch(() => [] as any[]),
            prisma.reflection.findMany({ where: { id: { endsWith: raw } }, select: { id: true } }).catch(() => [] as any[]),
          ]);
          crossHits = cross.flat().map((r: any) => String(r.id)).filter((id: string) => id !== only);
          if (crossHits.length > 0) only = null;
        }
        resolved.set(raw, only);
        if (only) { realIds.add(only); console.log(`[generate-improving-tasks:V2] 后缀解析 [${raw}] -> ${only}`); }
        else if (crossHits.length > 0) console.log(`[generate-improving-tasks:V2] 后缀 [${raw}] 跨实体歧义(Memory 唯一命中 ${hits[0].id}, 但同后缀另命中 ${crossHits.slice(0, 3).join(",")}), 拒绝解析, 保持 DROP`);
        else console.log(`[generate-improving-tasks:V2] 后缀 [${raw}] 命中 ${hits.length} 行, 无法唯一解析, 保持 DROP`);
      } else {
        resolved.set(raw, null);
      }
    }
    const before = actions.length;
    actions = actions.filter((a: any) => {
      if (a.type !== "MERGE_CONFLICT") return true;
      const ids = (a.memoryIds || [])
        .map((id: string) => resolved.get(id) ?? id)
        .filter((id: string) => realIds.has(id));
      if (ids.length === 0) {
        console.log(`[generate-improving-tasks:V2] DROP MERGE_CONFLICT (建议 ID 无法解析为真实 Memory: ${JSON.stringify((a.memoryIds || []).slice(0, 3))})`);
        return false;
      }
      a.memoryIds = Array.from(new Set(ids));
      return true;
    });
    if (actions.length !== before) {
      console.log(`[generate-improving-tasks:V2] actions 真实 ID 校验 ${before} -> ${actions.length}`);
    }
  }
  // 重新统计: 以守卫后真实动作为准 (描述/标题计数诚实)
  actionCounts = {
    MERGE_CONFLICT: actions.filter(a => a.type === "MERGE_CONFLICT").length,
    RE_EXTRACT: actions.filter(a => a.type === "RE_EXTRACT").length,
    MIGRATE_DATA: actions.filter(a => a.type === "MIGRATE_DATA").length,
    APPLY_IMPROVEMENT: actions.filter(a => a.type === "APPLY_IMPROVEMENT").length,
  };

  // 过滤后为空且无 findings → 不生成空壳 task (避免 FAILED 墙)
  if (actions.length === 0 && structuredFindings.length === 0) {
    console.log(`[generate-improving-tasks:V2] SKIP reflection="${reflectionId}" 校验后无真实可执行动作`);
    return [];
  }

  // ===== 创建 task =====
  const title = `[THEME_IMPROVE] ${theme} 综合改进 (cov=${coverage.toFixed(2)} missed=${missedTopics.length} conflict=${conflicts.length})`;
  const descriptionBase = [
    `主题 "${theme}" 反思发现 ${actions.length} 个改进项:`,
    `  - 冲突合并: ${actionCounts.MERGE_CONFLICT} 组`,
    `  - 重新提取: ${actionCounts.RE_EXTRACT} (${missedTopics.length} 个遗漏主题)`,
    `  - 数据迁移: ${actionCounts.MIGRATE_DATA} 条 (需人审)`,
    `  - 改进建议: ${actionCounts.APPLY_IMPROVEMENT} 条 (需人审)`,
  ];
  // 2026-09-09 上下文增强: 事项明细清单 — 任务进入即可知道要做什么、为什么(来源在 materials/背景)
  const detailLines: string[] = [];
  for (const mt of (missedTopics || []).slice(0, 10)) detailLines.push(`遗漏: ${String(mt).slice(0, 150)}`);
  for (const imp of (improvements || []).slice(0, 8)) detailLines.push(`建议: ${String(imp).slice(0, 180)}`);
  for (const cf of (conflicts || []).slice(0, 4)) detailLines.push(`冲突: ${String((cf as any)?.reason || "").slice(0, 150)}`);
  for (const ac of (actions || []).slice(0, 6)) {
    const ai = (ac as any).expectedImpact ? " → " + String((ac as any).expectedImpact).slice(0, 90) : "";
    detailLines.push(`动作[${(ac as any).type || ""}]: ${String((ac as any).reason || (ac as any).improvement || "").slice(0, 90)}${ai}`);
  }
  for (const sf of (structuredFindings || []).slice(0, 12)) {
    const ev = (sf as any).evidenceSnippet ? " — 证据: " + String((sf as any).evidenceSnippet).slice(0, 70) : "";
    detailLines.push(`发现[${(sf as any).priority || "P2"}|${(sf as any).actionType || ""}]: ${String((sf as any).what || "").slice(0, 90)}${ev}`);
  }
  // ===== P1 信息契约 (2026-09-09) =====
  const appliedTargets: Record<string, number> = {};
  for (const sf of structuredFindings || []) {
    const at = String((sf as any).actionType || "");
    if (at === "CREATE_MEMORY") appliedTargets.Memory = (appliedTargets.Memory || 0) + 1;
    else if (at === "CREATE_KNOWLEDGE") appliedTargets.Knowledge = (appliedTargets.Knowledge || 0) + 1;
    else if (at === "CREATE_PRACTICE") appliedTargets.Practice = (appliedTargets.Practice || 0) + 1;
    else if (at === "MERGE_CONFLICT") appliedTargets["Memory(合并)"] = (appliedTargets["Memory(合并)"] || 0) + 1;
  }
  const appTargetText = Object.entries(appliedTargets).map(([k, v]) => k + "×" + v).join(", ") || "结论/建议型(存结论, 需人工应用)";
  const whyLines = (structuredFindings || []).slice(0, 2).map((sf) => String((sf as any).why || "").slice(0, 110));
  const contractLines: string[] = [
    "", "=== 任务契约 ===",
    "【为什么】 主题 " + theme + " 反思 coverage=" + coverage.toFixed(2) + " 暴露改进缺口: " + ((whyLines.length ? whyLines.join(" ; ") : (improvements || []).slice(0, 1).map((i: any) => String(i)).join(" ; ")) || "见事项明细")
    , "【来源】 反思ID " + reflectionId + (reflUpdatedAt ? " (更新 " + reflUpdatedAt + ")" : "") + "; 关联活跃记忆 " + relatedMems.length + " 条; materials 含完整源数据",
    "【目标】 " + actions.length + " 个动作 + " + (structuredFindings || []).length + " 条发现(见事项明细)",
    "【应用去向】 " + appTargetText + "; 目标主题 " + theme,
    "【预期效果】 各项 expectedImpact 见 payload; 总目标: 提升主题覆盖与产物质量(见验收)",
    "【影响范围】 仅主题 " + theme + " 内数据; 受白名单/容量(≤200/主题)/幂等保护; " + (actionCounts.MIGRATE_DATA + actionCounts.APPLY_IMPROVEMENT > 0 ? "含需人审项 " + (actionCounts.MIGRATE_DATA + actionCounts.APPLY_IMPROVEMENT) + " 条" : "无人工项")
    , "【验证/测试要求】 见验收标准与 qualityStandards; findings 逐条 acceptance 在 payload",
  ];
  const description = [...descriptionBase, ...(detailLines.length > 0 ? ["", "=== 事项明细 ===", ...detailLines] : []), ...contractLines].join("\n").slice(0, 4500);

  const payload = {
    actions,
    // V1.8: 结构化发现传入 task (execute 时按 actionType 执行 + measuredDelta 回写)
    findings: structuredFindings.length > 0 ? structuredFindings : undefined,
    findingReflectionId: reflectionId,
    appliedTargets,
    contract: { version: 1, hasWhy: true, hasSource: true, hasHow: true, hasTarget: true, hasEffect: true, hasScope: true, hasVerify: true },
    summary: {
      coverageScore: coverage,
      missedCount: missedTopics.length,
      conflictCount: conflicts.length,
      improvementCount: improvements.length,
      actionCount: actions.length,
      findingCount: structuredFindings.length,
    },
  };

  const task = await prisma.task.create({
    data: {
      title,
      description,
      background,
      requirements,
      materials,
      acceptanceCriteria,
      qualityStandards,
      status: "PENDING",
      priority: coverage < 0.3 ? "P1" : "P2",
      theme,
      improvementType: "THEME_IMPROVE",
      improvementPayload: JSON.stringify(payload),
      sourceReflectionIds: reflectionId,
      manualReview: false, // THEME_IMPROVE 本身可自动执行 (内部 action 各自有 manualReview 控制)
      structuredContext: JSON.stringify({
        reflectionId,
        reflectionUpdatedAt: reflUpdatedAt,
        coverageScore: coverage,
        actionSummary: actionCounts,
        findingCount: structuredFindings.length,
        recurringCount: structuredFindings.filter(f => f.status === "RECURRING").length,
        llmGenerated: !!llmReasoning,
        llmReasoning: llmReasoning.slice(0, 200),
        relatedMemoryIds: relatedMemIds,
        relatedMemoryCount: relatedMems.length,
        sourceChain: { type: "FlywheelReflection", id: reflectionId, theme },
      }),
    },
    select: { id: true },
  });

  console.log(`[generate-improving-tasks:V2] END reflection="${reflectionId}" theme="${theme}" -> 1 THEME_IMPROVE task (${actions.length} actions, ${structuredFindings.length} findings, ${Date.now() - t1}ms)`);

  return [{
    taskId: task.id,
    type: "THEME_IMPROVE" as ImprovementType,
    title,
    reason: description.slice(0, 100),
  }];
}
