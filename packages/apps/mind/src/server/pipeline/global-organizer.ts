/**
 * Global Organizer — 飞轮全局整理核心模块
 * 设计文档: docs/GLOBAL-ORGANIZER-DESIGN.md
 *
 * 5 步流水线:
 * 1. loadGroupMessages — 从 session DB 拉取跨 session 有序 messages
 * 2. chunkIfNeeded — 按 session 边界分批 (≤12K tokens/batch)
 * 3. llmSynthesize — LLM 全局整理, 产出 4 类认知 JSON
 * 4. writeProductsToDB — 4 类产物入库 + contentHash 去重
 * 5. calibrateMemory — 参照校准 (一次 LLM 批量判定)
 */

import { skillNameFields, upsertPublicSkill } from "./skill-naming";
import { sessionApiKey } from "@/lib/secret";
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
import { triggerVersionLinkage } from "@lions/modules-pipeline";
import { parseContent, calcMemoryQuality, calcKnowledgeQuality, qualityToTier } from "@/lib/content-parser";
import { calcQualityScore, resolveSkillNameForWrite } from "./db-writer";
import { SKILL_NAME_MAX } from "./skill-dedup"; // 2026-10-10 round 74: Skill 名上限(单一来源)
import { projectPracticeOutcome, normalizeEnumToken, projectCategory } from "./enum-projection"; // 2026-10-07 P4 / 2026-10-08 round 54
import { safeCreateKnowledge, safeCreatePractice, safeCreateReflection, safeCreateMemory } from "./safe-create"; // round 57 G3/G4
// 2026-10-25 撤回流程补漏: 去重/存在性判定统一走"活行口径"(未撤回 + 未被取代)
import { liveRowWhere } from "./stale-aware-dedup";
// 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套硬约束 (global-organizer 也产 4 类产物
//   globalMemory + knowledge + practice + reflection), 同样适用 V3_FIVE_PIECE_HARD_RULES
import { V3_FIVE_PIECE_HARD_RULES, validateFlywheelProduct } from "./flywheel-prompt-constraints";

// ===== fetch timeout 辅助 =====

/** fetch 带 AbortController timeout, 防止 LLM 限流时无限等待 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`fetch timeout after ${timeoutMs}ms: ${url.slice(0, 80)}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ===== 类型定义 =====

interface GroupMessage {
  id: string;
  role: string;       // user / assistant / tool
  content: string;
  timestamp: Date;
  sessionSeq: number; // 在 group 中的 session 序号
  sessionTitle: string;
}

interface SynthesisProduct {
  globalMemory: string | Record<string, any>;  // 旧: 自由文本; 新: 结构化 JSON 对象
  theme: string;
  knowledge: { content: string | Record<string, any>; theme: string; title: string }[];
  practice: { content: string | Record<string, any>; theme: string; title: string }[];
  reflection: { title: string; description: string; lesson: string }[];
}

interface OrganizeResult {
  groupKey: string;
  duration: number;
  products: { memory: number; knowledge: number; practice: number; reflection: number };
  calibration: { super: number; stale: number; create: number; merge: number };
  skills: number;
  stalePropagated: number;
}

// ===== 占位: 函数实现见后续 patch =====

const SESSION_API_BASE = "http://localhost:3002/api/v1";
const SESSION_API_KEY = sessionApiKey(/* LIONS_SESSION_API_KEY */);
const FRAMEWORK_PATTERNS = [
  "[CONTEXT COMPACTION",
  "You just executed tool calls",
  "<!-- [PERSONA]",
  "<!-- [SHARED]",
  "<!-- [LOCAL]",
  "Conversation started:",
];

function isFrameworkInjection(content: string): boolean {
  return FRAMEWORK_PATTERNS.some((p) => content.startsWith(p));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 估算 token 数 (粗略: 1 中文字 ≈ 2 token, 1 英文词 ≈ 1.3 token) */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk * 2 + ascii / 4);
}

/**
 * 找最接近的已有 theme (避免 global-organizer 产出新 theme 导致校准不匹配)
 * 策略: 精确匹配 > 子串匹配 > 字符 Jaccard 相似度 > 原值
 */
function findClosestTheme(target: string, existing: string[]): string {
  if (!target || existing.length === 0) return target;
  if (existing.includes(target)) return target;

  // 子串匹配 (一方包含另一方)
  for (const t of existing) {
    if (t.length >= 2 && (t.includes(target) || target.includes(t))) return t;
  }

  // 字符集 Jaccard 相似度
  const targetChars = new Set(target.split(""));
  let bestMatch = "";
  let bestScore = 0;
  for (const t of existing) {
    const tChars = new Set(t.split(""));
    let intersection = 0;
    for (const ch of Array.from(targetChars)) {
      if (tChars.has(ch)) intersection++;
    }
    const union = new Set(Array.from(targetChars).concat(Array.from(tChars))).size;
    const score = intersection / union;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = t;
    }
  }

  // 相似度 ≥ 0.3 才用已有 theme, 否则保留原值 (允许新 theme)
  return bestScore >= 0.3 ? bestMatch : target;
}

/**
 * 1. loadGroupMessages — 从 session API 拉取跨 session 有序 messages
 * 输入: groupKey
 * 输出: 有序 GroupMessage[] (已过滤框架注入)
 */
async function loadGroupMessages(groupKey: string): Promise<GroupMessage[]> {
  // 单次请求拉取全部消息 (API 按 maxMessages 截断, 不支持 offset 分页)
  // 超大 group (>50K msgs) 会被 API 截断, 但当前最大 group 37K 在范围内
  const maxMessages = 50000;
  const url = `${SESSION_API_BASE}/session-groups/${encodeURIComponent(groupKey)}?view=messages&maxMessages=${maxMessages}`;
  // P4-5 (2026-07-12): 加 cache: 'no-store' 避免 Next.js fetch 默认缓存
  const res = await fetchWithTimeout(url, {
    headers: { "X-API-Key": SESSION_API_KEY },
    cache: "no-store",
  }, 30000);
  if (!res.ok) throw new Error(`session API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const all: GroupMessage[] = [];
  for (const m of data.messages ?? []) {
    const content = m.content || "";
    if (isFrameworkInjection(content)) continue;
    all.push({
      id: m.id,
      role: m.role,
      content,
      timestamp: new Date(m.timestamp),
      sessionSeq: m.sessionSeq ?? 0,
      sessionTitle: m.sessionTitle ?? "",
    });
  }

  return all;
}

/**
 * 2. chunkIfNeeded — 按 session 边界分批
 * 输入: GroupMessage[], maxTokens
 * 输出: GroupMessage[][] (每个 chunk ≤ maxTokens, 不跨 session 切割)
 */
function chunkIfNeeded(messages: GroupMessage[], maxTokens = 12000): GroupMessage[][] {
  const chunks: GroupMessage[][] = [];
  let current: GroupMessage[] = [];
  let currentTokens = 0;
  let lastSeq = -1;

  for (const msg of messages) {
    const msgTokens = estimateTokens(msg.content) + 10; // +10 for role/timestamp overhead
    if (currentTokens + msgTokens > maxTokens && current.length > 0) {
      // 如果即将超限且当前 chunk 非空, 先保存
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
    lastSeq = msg.sessionSeq;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

// 5 步流水线均已实现 (D-03 2026-09-07 清理历史脚手架注释, 详见下方各函数):
//   1. loadGroupMessages(L138) 2. chunkIfNeeded(L173) 3. llmSynthesize(L1436)
//   4. writeProductsToDB(L1189) 5. calibrateMemory(L942)
//   主入口: runGlobalOrganizer(L612) / startOrganizeTask(L884) / runGlobalOrganizerByTheme(L1577)

// ===== 任务存储 (内存 Map, 重启丢失) =====
interface TaskState {
  taskId: string;
  groupKey: string;
  status: "STARTED" | "RUNNING" | "DONE" | "FAILED";
  startedAt: number;
  duration?: number;
  products?: { memory: number; knowledge: number; practice: number; reflection: number };
  calibration?: { super: number; stale: number; create: number; merge: number };
  skills?: number;
  stalePropagated?: number;
  error?: string;
}

// 内存缓存 (热数据) + SQLite 持久化 (防 hot-reload 丢失)
const taskCache = new Map<string, TaskState>();

// Prisma SQLite $queryRaw/$executeRaw 参数绑定有 bug (P2010 "Raw query failed. N/A"),
// 无参数 raw query 正常, 带参数 (?或${}) 的全挂. 改用字符串拼接 + 手动转义.
function sqlStr(v: string | null | undefined): string {
  if (v == null) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS _global_organizer_task (
    taskId TEXT PRIMARY KEY,
    groupKey TEXT NOT NULL,
    status TEXT NOT NULL,
    startedAt INTEGER NOT NULL,
    duration REAL,
    products TEXT,
    calibration TEXT,
    error TEXT,
    skills INTEGER,
    stalePropagated INTEGER
  )`);
  // 迁移: 给旧表加列 (ALTER TABLE ADD COLUMN 幂等 — 列已存在时忽略错误)
  await prisma.$executeRawUnsafe(`ALTER TABLE _global_organizer_task ADD COLUMN skills INTEGER`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE _global_organizer_task ADD COLUMN stalePropagated INTEGER`).catch(() => {});
  tableEnsured = true;
}

async function saveTaskToDB(state: TaskState) {
  taskCache.set(state.taskId, state);
  await ensureTable();
  const sql = `INSERT OR REPLACE INTO _global_organizer_task
    (taskId, groupKey, status, startedAt, duration, products, calibration, error, skills, stalePropagated)
    VALUES (${sqlStr(state.taskId)}, ${sqlStr(state.groupKey)}, ${sqlStr(state.status)}, ${state.startedAt},
      ${state.duration != null ? state.duration : "NULL"},
      ${sqlStr(state.products ? JSON.stringify(state.products) : null)},
      ${sqlStr(state.calibration ? JSON.stringify(state.calibration) : null)},
      ${sqlStr(state.error ?? null)},
      ${state.skills != null ? state.skills : "NULL"},
      ${state.stalePropagated != null ? state.stalePropagated : "NULL"})`;
  await prisma.$executeRawUnsafe(sql);
}

async function getTaskFromDB(taskId: string): Promise<TaskState | undefined> {
  if (taskCache.has(taskId)) return taskCache.get(taskId);
  await ensureTable();
  // Prisma SQLite $queryRaw 对大 INTEGER (ms 时间戳) 有 bug, 必须 CAST AS REAL
  const rows = await prisma.$queryRawUnsafe(
    `SELECT taskId, groupKey, status, CAST(startedAt AS REAL) as startedAt, duration, products, calibration, error, skills, stalePropagated FROM _global_organizer_task WHERE taskId = ${sqlStr(taskId)}`
  ) as any[];
  if (!rows.length) return undefined;
  const r = rows[0];
  return {
    taskId: r.taskId,
    groupKey: r.groupKey,
    status: r.status,
    startedAt: r.startedAt,
    duration: r.duration ?? undefined,
    products: r.products ? JSON.parse(r.products) : undefined,
    calibration: r.calibration ? JSON.parse(r.calibration) : undefined,
    error: r.error ?? undefined,
    skills: r.skills ?? undefined,
    stalePropagated: r.stalePropagated ?? undefined,
  };
}

export async function getTask(taskId: string): Promise<TaskState | undefined> {
  return getTaskFromDB(taskId);
}

export async function getPendingTasks(): Promise<TaskState[]> {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT taskId, groupKey, status, CAST(startedAt AS REAL) as startedAt, duration, products, calibration, error
     FROM _global_organizer_task
     WHERE status IN ('DONE', 'FAILED') ORDER BY startedAt DESC LIMIT 20`
  ) as any[];
  return rows.map((r: any) => ({
    taskId: r.taskId,
    groupKey: r.groupKey,
    status: r.status,
    startedAt: r.startedAt,
    duration: r.duration ?? undefined,
    products: r.products ? JSON.parse(r.products) : undefined,
    calibration: r.calibration ? JSON.parse(r.calibration) : undefined,
    error: r.error ?? undefined,
  }));
}

// ===== F3: updateExtractStatus — 调 session API PATCH 更新 SessionGroup.extractStatus =====

export async function updateExtractStatus(
  groupKey: string,
  status: "PROCESSING" | "DONE" | "FAILED",
  error?: string,
): Promise<void> {
  try {
    const url = `${SESSION_API_BASE}/session-groups/${encodeURIComponent(groupKey)}/status`;
    await fetchWithTimeout(url, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "X-API-Key": SESSION_API_KEY,
      },
      body: JSON.stringify({ extractStatus: status, extractError: error }),
    }, 10000);
  } catch (e) {
    console.error(`[updateExtractStatus] failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ===== F2: propagateStale — 旧 GLOBAL_ORGANIZER 产物标记 stale =====
// 当同一 theme 的旧产物 (来自不同 groupKey) 存在时, 标记 supersededBy
// 这样 synthesizeSkill 只会用最新一轮的 Knowledge

async function propagateStale(
  theme: string,
  currentGroupKey: string,
): Promise<number> {
  let count = 0;
  const staleMark = `STALE_REORGANIZED_${Date.now()}`;
  const now = new Date();

  // Knowledge
  const oldKnowledge = await prisma.knowledge.findMany({
    where: {
      theme,
      sourceType: "GLOBAL_ORGANIZER",
      sourceId: { not: currentGroupKey },
      supersededBy: null,
    },
    select: { id: true },
  });
  for (const k of oldKnowledge) {
    await prisma.knowledge.update({
      where: { id: k.id },
      data: { supersededBy: staleMark, supersededAt: now },
    }).catch(() => {});
    count++;
  }

  // Practice
  const oldPractice = await prisma.practice.findMany({
    where: {
      theme,
      sourceType: "GLOBAL_ORGANIZER",
      sourceId: { not: currentGroupKey },
      supersededBy: null,
    },
    select: { id: true },
  });
  for (const p of oldPractice) {
    await prisma.practice.update({
      where: { id: p.id },
      data: { supersededBy: staleMark, supersededAt: now },
    }).catch(() => {});
    count++;
  }

  // Reflection
  const oldReflection = await prisma.reflection.findMany({
    where: {
      theme,
      sourceType: "GLOBAL_ORGANIZER",
      sourceId: { not: currentGroupKey },
      supersededBy: null,
    },
    select: { id: true },
  });
  for (const r of oldReflection) {
    await prisma.reflection.update({
      where: { id: r.id },
      data: { supersededBy: staleMark, supersededAt: now },
    }).catch(() => {});
    count++;
  }

  // Memory (旧全局记忆)
  const oldMemory = await prisma.memory.findMany({
    where: {
      theme,
      sourceType: "GLOBAL_ORGANIZER",
      sourceId: { not: currentGroupKey },
      supersededBy: null,
    },
    select: { id: true },
  });
  for (const m of oldMemory) {
    await prisma.memory.update({
      where: { id: m.id },
      data: { supersededBy: staleMark, supersededAt: now },
    }).catch(() => {});
    count++;
  }

  if (count > 0) {
    console.log(`[propagateStale] theme="${theme}" marked ${count} old products stale`);

    // 2026-07-12 PHASE-B: 标 stale 后立即触发版本联动, 让 SynthesisJob 入队
    // 这样下游 (Re-synthesis worker) 可自动重合成, 不需要人工
    try {
      const totalLinkage = await Promise.all([
        ...oldKnowledge.map((k) =>
          triggerVersionLinkage(prisma as any, {
            sourceType: "knowledge",
            sourceId: k.id,
            reason: `propagateStale theme="${theme}"`,
            priority: 3,
          }).catch((err) => {
            console.warn(`[propagateStale] linkage fail for knowledge/${k.id}:`, (err as Error).message);
            return null;
          })
        ),
        ...oldPractice.map((p) =>
          triggerVersionLinkage(prisma as any, {
            sourceType: "practice",
            sourceId: p.id,
            reason: `propagateStale theme="${theme}"`,
            priority: 3,
          }).catch((err) => {
            console.warn(`[propagateStale] linkage fail for practice/${p.id}:`, (err as Error).message);
            return null;
          })
        ),
        // reflection 不在 version-linkage 的支持范围内 (LinkageEvent.sourceType 仅 3 种)
        ...oldMemory.map((m) =>
          triggerVersionLinkage(prisma as any, {
            sourceType: "memory",
            sourceId: m.id,
            reason: `propagateStale theme="${theme}"`,
            priority: 3,
          }).catch((err) => {
            console.warn(`[propagateStale] linkage fail for memory/${m.id}:`, (err as Error).message);
            return null;
          })
        ),
      ]);
      const successCount = totalLinkage.filter(Boolean).length;
      console.log(`[propagateStale] version linkage enqueued: ${successCount}/${count}`);
    } catch (linkageErr) {
      // 版本联动失败不影响 stale 标记主流程
      console.warn(`[propagateStale] version linkage batch failed:`, (linkageErr as Error).message);
    }
  }
  return count;
}

// ===== F1: synthesizeSkill — 同 theme Knowledge>=3 → LLM 打包 → Skill upsert =====

async function synthesizeSkill(theme: string): Promise<number> {
  // 查非 stale 的同 theme Knowledge
  // 2026-09-15 撤回流程补漏(待办 todo_c4869259208d4a748fb9): 注释说"非 stale", 但 where 里**没有**
  //   stale:false, 只挡了 supersededBy —— 而撤回写的是 stale=1 + supersededBy 保持 NULL,
  //   于是被撤回的结论仍会被喂给 LLM 合成 Skill(本仓实测 5741 条 stale=1 行 supersededBy 全为 NULL)。
  const knowledgeEntries = await prisma.knowledge.findMany({
    where: {
      theme,
      supersededBy: null,
      stale: false,
    },
    select: { id: true, title: true, content: true },
    take: 20,
    orderBy: { createdAt: "desc" },
  });

  if (knowledgeEntries.length < 3) {
    console.log(`[synthesizeSkill] theme="${theme}" has ${knowledgeEntries.length} Knowledge (< 3), skipping`);
    return 0;
  }

  console.log(`[synthesizeSkill] theme="${theme}" has ${knowledgeEntries.length} Knowledge, synthesizing Skill`);

  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  const model = process.env.ANTHROPIC_MODEL || "MiniMax-M2.7";

  if (!apiKey) {
    console.error("[synthesizeSkill] LLM API key 未配置, 跳过");
    return 0;
  }

  const knowledgeText = knowledgeEntries
    .map((k, i) => `[${i + 1}] ${k.title || "无标题"}\n${k.content}`)
    .join("\n\n");

  const synthPrompt = `你是一个技能打包引擎。以下是关于主题"${theme}"的 ${knowledgeEntries.length} 条 Knowledge。请将它们综合打包为一个可命名调用的 Skill。

Knowledge 列表:
${knowledgeText}

输出严格 JSON:
{
  "name": "kebab-case技能名 (英文, 必须 ≤20 字符, 如 task-schedule-cfg)",
  "category": "${theme}",
  "level": "WORKING" | "PROFICIENT",
  "description": "一句话描述这个技能做什么 (≤100字)",
  "content": "完整的技能内容 (markdown格式, 包含步骤/要点/注意事项)",
  "usageMethod": "如何使用这个技能 (≤200字)"
}

规则:
- name: 必须是 kebab-case 英文, 从 Knowledge 内容提炼核心能力, **总长不得超过 20 个字符(超过会被拒收)**
- content: 整合所有 Knowledge 的要点, 去重去噪, 形成结构化文档
- 严格 JSON, 不要 markdown 代码块`;

  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: synthPrompt }],
      }),
    }, 90000);

    if (!res.ok) {
      console.error(`[synthesizeSkill] LLM ${res.status}, 跳过`);
      return 0;
    }

    const data = await res.json();
    const rawText: string = data.content?.[0]?.text || "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[synthesizeSkill] LLM 返回非 JSON, 跳过");
      return 0;
    }

    let parsed: { name: string; category: string; level: string; description: string; content: string; usageMethod: string };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      const cleaned = repairJson(jsonMatch[0]);
      parsed = JSON.parse(cleaned);
    }

    if (!parsed.name) {
      console.error("[synthesizeSkill] LLM 返回缺少 name, 跳过");
      return 0;
    }

    // 2026-10-10 round 74 (agent-d, todo_47f179370e66425dbc8f): 写侧长度收口 —— 复用 db-writer
    //   已单测的 `resolveSkillNameForWrite`(单一来源), **绝不**写超长 Skill, 也**绝不**确定性截断
    //   (round 70 裁决: 头部截断会把 'Prisma schema设计与migration' 与 'Prisma ORM与DateTime处理'
    //   一起塌成 "Prisma" -> 不同技能被同名校验假合并)。历史泄漏率实测 160/176=91%
    //   (sourceLayer=GLOBAL_ORGANIZER 且 LENGTH(name)>20); 本路径的源 Knowledge 已在库, 跳过不丢内容。
    const resolved = resolveSkillNameForWrite(parsed.name);
    if (resolved.tooLong) {
      console.error(`[synthesizeSkill] theme="${theme}" 技能名超限(>${SKILL_NAME_MAX} 字符), 跳过写 Skill(不写超长名/不做确定性截断): ${JSON.stringify(parsed.name)}`);
      return 0;
    }
    const skillName = resolved.name;

    // upsert by name (Skill 旁路 Resolver, name unique)
    // P5 修 B1 (2026-07-12): 之前 create 只写 source/name/category, 没写 theme/sourceLayer/sourceIds
    // Skill 表 6460 条全 theme=NULL, 无法溯源 (§4.4 验收要求每条可溯源)
    const now = new Date();
    const sourceIds = JSON.stringify([`GLOBAL_ORGANIZER:${theme}`]);
    const sourceHash = `sha256:${Buffer.from(`${theme}:${skillName}`).toString("hex").slice(0, 16)}`;
    // 2026-10-26: 改为 upsertPublicSkill（先按 technicalName 查公共技能，有则更新、无则创建）。
    //   不用 prisma.upsert 的原因：upsert 需要唯一键，technicalName 的唯一性是部分唯一索引（Prisma 不能声明）。
    await upsertPublicSkill(prisma, skillName, {
        ...skillNameFields(skillName),
        // 2026-10-08 round 54: 原来 `parsed.category || theme` 把 **theme 当 category 写**(语义劫持,
        //   与当年 domain 写 ref.category 同一类问题) —— 改为过受控投影, 不命中落 OTHER; theme 仍写 theme 字段。
        category: projectCategory(parsed.category, "skill") ?? "OTHER",
        level: parsed.level || "WORKING",
        description: parsed.description || "",
        content: parsed.content || "",
        usageMethod: parsed.usageMethod || "",
        source: "LEARNED",
        theme: theme,
        sourceLayer: "GLOBAL_ORGANIZER",
        sourceIds: sourceIds,
        sourceHash: sourceHash,
        updatedAt: now,
      }, {
        name: skillName,
        ...skillNameFields(skillName),
        // 2026-10-08 round 54: 原来 `parsed.category || theme` 把 **theme 当 category 写**(语义劫持,
        //   与当年 domain 写 ref.category 同一类问题) —— 改为过受控投影, 不命中落 OTHER; theme 仍写 theme 字段。
        category: projectCategory(parsed.category, "skill") ?? "OTHER",
        level: parsed.level || "WORKING",
        description: parsed.description || "",
        content: parsed.content || "",
        usageMethod: parsed.usageMethod || "",
        source: "LEARNED",
        theme: theme,
        sourceLayer: "GLOBAL_ORGANIZER",
        sourceIds: sourceIds,
        sourceHash: sourceHash,
        qualityScore: calcQualityScore({ type: "skill", content: parsed.content || parsed.description || "", name: skillName, level: parsed.level || "WORKING", category: parsed.category || theme }),  // 2026-08-27 补齐 5 表覆盖
        createdAt: now,
        updatedAt: now,
      }
    );

    console.log(`[synthesizeSkill] Skill "${skillName}" upserted for theme="${theme}"`);
    return 1;
  } catch (e) {
    console.error(`[synthesizeSkill] failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

/**
 * runGlobalOrganizer — 主入口, 5 步流水线
 * @param groupKey group key (V1 入口) 或虚拟 key "__theme__:<theme>" (V1.6 runGlobalOrganizerByTheme 入口)
 * @param presetMessages V1.6 新增: 外部传入的 messages (反射引擎/重跑复用, 避免重复 fetch)
 */
export async function runGlobalOrganizer(
  groupKey: string,
  presetMessages?: GroupMessage[],
): Promise<OrganizeResult> {
  const startTime = Date.now();
  console.log(`[global-organizer] START groupKey=${groupKey}${presetMessages ? " (presetMessages)" : ""}`);

  // 1. 拉取消息 (V1.6: presetMessages 优先, 跳过 loadGroupMessages)
  const t1Start = Date.now();
  const messages = presetMessages ?? await loadGroupMessages(groupKey);
  const t1Duration = (Date.now() - t1Start) / 1000;
  console.log(`[global-organizer] STEP1 loadMessages: ${messages.length} msgs in ${t1Duration.toFixed(1)}s`);

  if (messages.length === 0) {
    throw new Error(`group "${groupKey}" 无有效消息`);
  }

  // 2. 分批
  const t2Start = Date.now();
  const chunks = chunkIfNeeded(messages);
  const t2Duration = (Date.now() - t2Start) / 1000;
  console.log(`[global-organizer] STEP2 chunk: ${chunks.length} chunk(s) in ${t2Duration.toFixed(1)}s`);

  // 2.5 查已有 theme 列表 (让 LLM 复用, 保证校准能匹配)
  const t25Start = Date.now();
  const existingThemes = await prisma.memory.findMany({
    where: { sourceType: { not: "GLOBAL_ORGANIZER" }, theme: { not: null } },
    distinct: ["theme"],
    select: { theme: true },
    take: 50,
  }).then((rows: { theme: string | null }[]) => rows.map((r) => r.theme).filter((t): t is string => !!t));
  const t25Duration = (Date.now() - t25Start) / 1000;
  console.log(`[global-organizer] STEP2.5 existingThemes: ${existingThemes.length} in ${t25Duration.toFixed(1)}s`);

  // 3. 逐批 LLM 整理 (B5: 时效分档 — 小≤120s, 中≤300s, 大≤600s)
  // P4-2 优化: 串行变并行 — 除最后一批外, chunks 0..N-2 并行调用
  const allKnowledge: SynthesisProduct["knowledge"] = [];
  const allPractice: SynthesisProduct["practice"] = [];
  const allReflection: SynthesisProduct["reflection"] = [];
  let globalMemory: string | Record<string, any> = "";
  let llmTheme = "";
  // 大 chunks (>10) 给更多 deadline — 10min/100 chunks
  const deadlineMs = Date.now() + (chunks.length <= 3 ? 120 : chunks.length <= 10 ? 300 : Math.max(600, Math.ceil(chunks.length / 10) * 60)) * 1000;
  console.log(`[global-organizer] STEP3 llmSynthesize: ${chunks.length} chunks, deadline=${Math.round((deadlineMs - Date.now()) / 1000)}s`);

  // P4-2 并行优化: 中间 chunks 并行, 最后一批串行 (因为要 globalMemory)
  const t3Start = Date.now();
  let chunksProcessed = 0;

  if (chunks.length === 1) {
    // 单 chunk: 直接跑
    try {
      const product = await llmSynthesize(chunks[0], true, "", existingThemes);
      allKnowledge.push(...product.knowledge);
      allPractice.push(...product.practice);
      allReflection.push(...product.reflection);
      globalMemory = product.globalMemory;
      llmTheme = product.theme;
      chunksProcessed = 1;
    } catch (e) {
      console.error(`[global-organizer] chunk 1 failed: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    // 多 chunk: 中间 (0..N-2) 并行, 最后一批串行
    // P4-2 并发限制: 用 p-limit 模式 (Promise.all 没限流会打爆 LLM 端点)
    const middleChunks = chunks.slice(0, -1);
    const lastChunk = chunks[chunks.length - 1];

    // 简单并发限流 — 一次最多 12 个 LLM 调用同时 (P4-3c: 8→12 提速, MiniMax-M3 支持)
    const concurrency = Math.min(12, middleChunks.length);
    const results: Array<Awaited<ReturnType<typeof llmSynthesize>> | null> = new Array(middleChunks.length).fill(null);
    let cursor = 0;

    async function worker(workerId: number): Promise<void> {
      while (cursor < middleChunks.length) {
        const idx = cursor++;
        if (idx >= middleChunks.length) return;
        const chunkStart = Date.now();
        try {
          const product = await llmSynthesize(middleChunks[idx], false, "", existingThemes);
          const dur = (Date.now() - chunkStart) / 1000;
          console.log(`[global-organizer] chunk ${idx + 1}/${chunks.length} done in ${dur.toFixed(1)}s (${product.knowledge.length}K ${product.practice.length}P ${product.reflection.length}R)`);
          results[idx] = product;
        } catch (e) {
          console.error(`[global-organizer] chunk ${idx + 1} failed: ${e instanceof Error ? e.message : e}`);
          results[idx] = null;
        }
      }
    }

    // 启动 concurrency 个 worker
    const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
    await Promise.all(workers);

    for (const r of results) {
      if (r) {
        allKnowledge.push(...r.knowledge);
        allPractice.push(...r.practice);
        allReflection.push(...r.reflection);
        chunksProcessed++;
      }
    }

    // 最后一批串行: 需要 globalMemory
    try {
      const prevSummary = allKnowledge.slice(-5).map((k) => {
        const kc = typeof k.content === "string" ? k.content : JSON.stringify(k.content ?? "");
        return k.title + ": " + kc.slice(0, 80);
      }).join("\n");
      const lastStart = Date.now();
      const product = await llmSynthesize(lastChunk, true, prevSummary, existingThemes);
      const dur = (Date.now() - lastStart) / 1000;
      console.log(`[global-organizer] chunk ${chunks.length}/${chunks.length} (last) done in ${dur.toFixed(1)}s (${product.knowledge.length}K ${product.practice.length}P ${product.reflection.length}R)`);
      allKnowledge.push(...product.knowledge);
      allPractice.push(...product.practice);
      allReflection.push(...product.reflection);
      globalMemory = product.globalMemory;
      llmTheme = product.theme;
      chunksProcessed++;
    } catch (e) {
      console.error(`[global-organizer] last chunk failed: ${e instanceof Error ? e.message : e}`);
      if (!llmTheme && allKnowledge.length > 0) {
        llmTheme = allKnowledge[0].theme || groupKey.slice(0, 20);
      }
    }
  }
  const t3Duration = (Date.now() - t3Start) / 1000;
  console.log(`[global-organizer] STEP3 DONE: ${chunksProcessed}/${chunks.length} chunks OK in ${t3Duration.toFixed(1)}s`);

  // 后处理: 将 LLM 产出的 theme 映射到已有 theme (保证校准能匹配, 坑17)
  if (llmTheme && existingThemes.length > 0) {
    const mapped = findClosestTheme(llmTheme, existingThemes);
    if (mapped !== llmTheme) {
      console.log(`[global-organizer] theme mapped: "${llmTheme}" → "${mapped}"`);
      llmTheme = mapped;
    }
  }

  // 4. 合并去重 + 入库
  const t4Start = Date.now();
  const theme = llmTheme
    || (existingThemes.length > 0 ? findClosestTheme(groupKey.slice(0, 20), existingThemes) : groupKey.slice(0, 20));
  const merged: SynthesisProduct = {
    theme,
    globalMemory,
    knowledge: dedupByContent(allKnowledge),
    practice: dedupByContent(allPractice),
    reflection: dedupByTitle(allReflection),
  };

  const productCounts = await writeProductsToDB(merged, groupKey, theme);
  const t4Duration = (Date.now() - t4Start) / 1000;
  console.log(`[global-organizer] STEP4 writeProducts: ${JSON.stringify(productCounts)} in ${t4Duration.toFixed(1)}s`);

  // 记录飞轮事件 — 产物入库
  await prisma.flywheelEvent.create({
    data: {
      stage: "GLOBAL_ORGANIZER",
      sourceType: "SessionGroup",
      sourceId: groupKey,
      sourceTitle: groupKey.slice(0, 60),
      targetStage: "COGNITIVE_PRODUCTS",
      targetType: "WRITE",
    },
  }).catch(() => {}); // 不阻塞流程

  // 5/6/7 并行优化 (P4-2): calibration + propagateStale + synthesizeSkill 互不依赖, 可并发
  const t5Start = Date.now();
  const t6Start = Date.now();
  const t7Start = Date.now();

  const [calibrationResult, staleResult, skillsResult] = await Promise.all([
    calibrateMemory(theme, globalMemory, groupKey)
      .then((cal) => {
        const dur = (Date.now() - t5Start) / 1000;
        console.log(`[global-organizer] STEP5 calibration: ${JSON.stringify(cal)} in ${dur.toFixed(1)}s`);
        return cal;
      })
      .catch((e) => {
        console.error(`[global-organizer] STEP5 calibration failed: ${e instanceof Error ? e.message : e}`);
        return { super: 0, stale: 0, create: 0, merge: 0 };
      }),
    propagateStale(theme, groupKey)
      .then((stale) => {
        const dur = (Date.now() - t6Start) / 1000;
        console.log(`[global-organizer] STEP6 propagateStale: ${stale} in ${dur.toFixed(1)}s`);
        return stale;
      })
      .catch((e) => {
        console.error(`[global-organizer] STEP6 propagateStale failed: ${e instanceof Error ? e.message : e}`);
        return 0;
      }),
    synthesizeSkill(theme)
      .then((sk) => {
        const dur = (Date.now() - t7Start) / 1000;
        console.log(`[global-organizer] STEP7 synthesizeSkill: ${sk} skills in ${dur.toFixed(1)}s`);
        return sk;
      })
      .catch((e) => {
        console.error(`[global-organizer] STEP7 synthesizeSkill failed: ${e instanceof Error ? e.message : e}`);
        return 0;
      }),
  ]);

  const calibration = calibrationResult;
  const stalePropagated = staleResult;
  const skills = skillsResult;

  // 记录飞轮事件 — 校准 (P4-2 移到并行块外, 但用 fire-and-forget 不阻塞)
  prisma.flywheelEvent.create({
    data: {
      stage: "GLOBAL_ORGANIZER",
      sourceType: "SessionGroup",
      sourceId: groupKey,
      sourceTitle: groupKey.slice(0, 60),
      targetStage: "MEMORY_CALIBRATION",
      targetType: "CALIBRATE",
    },
  }).catch(() => {});

  // 记录飞轮事件 — Skill 打包
  if (skills > 0) {
    await prisma.flywheelEvent.create({
      data: {
        stage: "GLOBAL_ORGANIZER",
        sourceType: "SessionGroup",
        sourceId: groupKey,
        sourceTitle: groupKey.slice(0, 60),
        targetStage: "SKILL_SYNTHESIS",
        targetType: "SKILL",
      },
    }).catch(() => {});
  }

  const duration = (Date.now() - startTime) / 1000;
  console.log(`[global-organizer] DONE in ${duration.toFixed(1)}s`);

  return {
    groupKey,
    duration,
    products: productCounts,
    calibration,
    skills,
    stalePropagated,
  };
}

// 去重工具
function dedupByContent<T extends { content: string | Record<string, any> | undefined }>(arr: T[]): T[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    const raw = item.content;
    const c = typeof raw === "string" ? raw : (raw ? JSON.stringify(raw) : "");
    const key = c.slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupByTitle<T extends { title: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });
}

/**
 * 异步启动 (用于 API Route)
 */
export function startOrganizeTask(groupKey: string): string {
  // P4-5 (2026-07-12): 去重 — 跳过已经在 RUNNING 的 group
  // 之前 cron 每 10min 触发, 同一 group 会重复跑 (浪费 LLM 算力 + 写重复产物)
  // taskCache key=taskId, 需要遍历找 groupKey 匹配
  for (const [tid, st] of taskCache.entries()) {
    if (st.groupKey === groupKey && (st.status === "STARTED" || st.status === "RUNNING")) {
      console.log(`[global-organizer] SKIP ${groupKey}: already ${st.status} (taskId=${tid})`);
      return tid;
    }
  }

  const taskId = `go-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state: TaskState = {
    taskId,
    groupKey,
    status: "STARTED",
    startedAt: Date.now(),
  };
  saveTaskToDB(state).catch(() => {});

  // 异步执行, 不阻塞 API 响应
  (async () => {
    state.status = "RUNNING";
    saveTaskToDB(state).catch(() => {});
    updateExtractStatus(groupKey, "PROCESSING").catch(() => {});
    try {
      const result = await runGlobalOrganizer(groupKey);
      state.status = "DONE";
      state.duration = result.duration;
      state.products = result.products;
      state.calibration = result.calibration;
      state.skills = result.skills;
      state.stalePropagated = result.stalePropagated;
      updateExtractStatus(groupKey, "DONE").catch(() => {});
    } catch (err) {
      state.status = "FAILED";
      state.error = err instanceof Error ? err.message : String(err);
      console.error(`[global-organizer] FAILED: ${state.error}`);
      updateExtractStatus(groupKey, "FAILED", state.error).catch(() => {});
    }
    saveTaskToDB(state).catch(() => {});
  })();

  return taskId;
}

/**
 * 5. calibrateMemory — 参照校准 (一次 LLM 批量判定)
 * 输入: theme, globalMemory, groupKey
 * 动作: 查同 theme 的 Memory 碎片 → 一次 LLM 判定 → 更新 supersededBy 链
 * 输出: { super, stale, create, merge }
 *
 * V1.6 扩展 (lions-flywheel-v16-implementation-design.md §2.2):
 * - export (原私有)
 * - payload 扩展: conflicts[] + mergeTargets[] (来自 FlywheelReflection.conflicts)
 * - 白名单保护: FIX_CONFLICT 排除 sourceType='FLYWHEEL_REFLECTION', FIX_THEME 排除 domain='flywheel-reflect'
 *   (V1.6 §C-V1.6-2/C-V1.6-3 内部一致性审视)
 */
export async function calibrateMemory(
  theme: string | undefined,
  globalMemory: string | Record<string, any> | undefined,
  groupKey: string | undefined,
  payload?: {
    conflicts?: Array<{ memoryIds: string[]; reason: string }>;
    mergeTargets?: Array<{ sourceIds: string[]; targetId: string }>;
  },
): Promise<{ super: number; stale: number; create: number; merge: number; payloadApplied?: { merged: number; updated: number } }> {
  // V1.6 fix: payload 处理即使 globalMemory 为空也执行 (FIX_THEME/FIX_CONFLICT 是确定性 SQL, 不依赖 LLM)
  // 原 V1 行为: if (!globalMemory) return 提前退出, 跳过 payload → FIX_CONFLICT 永不生效
  // 拆解: payload 处理移到全局 early return 之前

  // ===== 2026-07-17 V1.6 payload 应用 (lions-flywheel-v16-implementation-design.md §2.2) =====
  // FIX_CONFLICT: 合并冲突 memoryIds → 老的标 supersededAt = now() (审计可追溯)
  // FIX_THEME: 改 Memory.theme (白名单排除 domain='flywheel-reflect')
  const payloadApplied = { merged: 0, updated: 0 };
  const now2 = new Date();

  if (payload?.conflicts && payload.conflicts.length > 0) {
    // FIX_CONFLICT: 合并冲突 (V1.6 §C-V1.6-2 白名单: 排除 sourceType='FLYWHEEL_REFLECTION')
    for (const c of payload.conflicts) {
      const conflictIds = (c.memoryIds || []).filter((id: string) => !!id);
      if (conflictIds.length === 0) continue;
      try {
        // V1.6 §6.5 数据准确: 必须设 supersededBy (谁取代) + supersededAt (何时取代)
        // 原 V1.6 A 路径 bug: 只设 supersededAt 没设 supersededBy, 审计链断
        // 修复: 把冲突组第 1 条当 "winner", 其他老的 supersededBy=winner.id
        const winnerId = conflictIds[0];
        const loserIds = conflictIds.slice(1);
        if (loserIds.length > 0) {
          // V1.6 §6.5 数据准确修复: 白名单必须包含 sourceType IS NULL
          // Prisma 的 `not: 'X'` 在 SQLite 中展开为 `sourceType != 'X'`, 不匹配 null
          // 这导致 sourceType=null 的 memory (默认) 全部被白名单错误排除
          // 修复: 用 OR 显式包含 null
          const res = await prisma.memory.updateMany({
            where: {
              AND: [
                { id: { in: loserIds } },
                {
                  OR: [
                    { sourceType: { not: "FLYWHEEL_REFLECTION" } },
                    { sourceType: null },
                  ],
                },
              ],
            },
            data: { supersededBy: winnerId, supersededAt: now2, updatedAt: now2 },
          });
          payloadApplied.merged += res.count;
          console.log(`[calibrateMemory:V1.6] conflict group ${conflictIds.length} ids → ${loserIds.length} superseded by winner="${winnerId}", updated ${res.count} (reason: ${c.reason?.slice(0, 60)})`);
        } else {
          console.log(`[calibrateMemory:V1.6] conflict group ${conflictIds.length} ids → 只有 winner, 无可取代`);
        }
      } catch (e: any) {
        console.error(`[calibrateMemory:V1.6] conflict failed: ${e.message}`);
      }
    }
  }

  if (payload?.mergeTargets && payload.mergeTargets.length > 0) {
    // FIX_THEME: 改 Memory.theme (V1.6 §C-V1.6-3 白名单: 排除 domain='flywheel-reflect')
    // V1.6 §6.5 数据准确修复: domain 白名单同样要包含 null (Prisma `not: 'X'` 不匹配 null)
    for (const m of payload.mergeTargets) {
      const sourceIds = (m.sourceIds || []).filter((id: string) => !!id);
      if (sourceIds.length === 0 || !m.targetId) continue;
      try {
        const res = await prisma.memory.updateMany({
          where: {
            AND: [
              { id: { in: sourceIds } },
              {
                OR: [
                  { domain: { not: "flywheel-reflect" } },
                  { domain: null },
                ],
              },
            ],
          },
          data: { theme: m.targetId, updatedAt: now2 },
        });
        payloadApplied.updated += res.count;
        console.log(`[calibrateMemory:V1.6] theme merge: ${sourceIds.length} ids → theme="${m.targetId}", updated ${res.count}`);
      } catch (e: any) {
        console.error(`[calibrateMemory:V1.6] theme merge failed: ${e.message}`);
      }
    }
  }

  // 如果 payload 有内容, 提前 return (跳过原 V1 LLM 校准, 因为 V1.6 payload 是确定 SQL)
  if ((payload?.conflicts?.length || 0) > 0 || (payload?.mergeTargets?.length || 0) > 0) {
    return { super: 0, stale: 0, create: 0, merge: 0, payloadApplied };
  }

  if (!globalMemory) return { super: 0, stale: 0, create: 0, merge: 0, payloadApplied: undefined };

  // 查同 theme 的碎片 Memory (排除已 GLOBAL_ORGANIZER 来源, 排除已 superseded)
  let fragments = await prisma.memory.findMany({
    where: {
      theme,
      sourceType: { not: "GLOBAL_ORGANIZER" },
      supersededBy: null,
    },
    select: { id: true, content: true },
    take: 30,
  });

  // 坑17: theme 精确匹配可能为 0 (LLM 产出 theme 与 extractor 不完全一致)
  // fallback: 查全部碎片, 让 LLM 自行判定相关性
  if (fragments.length === 0) {
    console.log(`[calibrateMemory] exact theme="${theme}" → 0 fragments, trying broader query`);
    fragments = await prisma.memory.findMany({
      where: {
        sourceType: { not: "GLOBAL_ORGANIZER" },
        supersededBy: null,
      },
      select: { id: true, content: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  }

  if (fragments.length === 0) return { super: 0, stale: 0, create: 0, merge: 0 };

  // 统一转为 string (新格式是 JSON 对象)
  const globalMemStr = typeof globalMemory === "string"
    ? globalMemory
    : JSON.stringify(globalMemory);
  // 用于 LLM prompt 的可读摘要
  const globalMemReadable = parseContent(globalMemStr).summary;

  // 查刚入库的全局记忆 id
  const globalMemHash = sha256(globalMemStr);
  // 2026-10-25 撤回流程补漏: 校准 prompt 要引用"本次真正落库的那条", 活行口径排除已被取代的行,
  //   否则会引用到上一轮被 supersede 的旧全局记忆(内容不同 -> prompt 与实际写入不一致)。
  const globalRecord = await prisma.memory.findFirst({
    where: liveRowWhere("memory", { contentHash: globalMemHash, sourceType: "GLOBAL_ORGANIZER" }),
    select: { id: true },
  });

  // 构建校准 prompt
  const fragmentsText = fragments
    .map((f, i) => `[${i + 1}] id=${f.id} content=${f.content.slice(0, 200)}`)
    .join("\n");

  const calibPrompt = `全局记忆: ${globalMemReadable}

以下是与该主题相关的 ${fragments.length} 条 Memory 碎片。请逐条判定与全局记忆的关系:

${fragmentsText}

判定规则:
- SUPER: 碎片内容已被全局记忆完全包含 (碎片过时)
- STALE: 碎片内容与全局记忆矛盾 (碎片有误)
- CREATE: 全局记忆有但碎片未覆盖的重要点 (需新建)
- MERGE: 碎片内容与全局记忆重复 (跳过)

输出严格 JSON:
{
  "judgments": [
    { "id": "碎片id", "action": "SUPER|STALE|CREATE|MERGE" }
  ]
}`;

  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  const model = process.env.ANTHROPIC_MODEL || "MiniMax-M2.7";

  const res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: calibPrompt }],
    }),
  }, 90000);

  if (!res.ok) {
    console.error(`[calibrateMemory] LLM ${res.status}, 跳过校准`);
    return { super: 0, stale: 0, create: 0, merge: 0 };
  }

  const data = await res.json();
  const rawText: string = data.content?.[0]?.text || "";
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("[calibrateMemory] LLM 返回非 JSON, 跳过校准");
    return { super: 0, stale: 0, create: 0, merge: 0 };
  }

  let judgments: { id: string; action: string }[];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    judgments = parsed.judgments || [];
  } catch {
    const cleaned = repairJson(jsonMatch[0]);
    try {
      judgments = JSON.parse(cleaned).judgments || [];
    } catch (e2) {
      console.error(`[calibrateMemory] JSON parse failed twice. Raw (300ch): ${rawText.slice(0, 300)}`);
      return { super: 0, stale: 0, create: 0, merge: 0 };
    }
  }

  const counts = { super: 0, stale: 0, create: 0, merge: 0 };
  const now = new Date();
  const globalId = globalRecord?.id;

  for (const j of judgments) {
    if (j.action === "SUPER" || j.action === "STALE") {
      if (globalId) {
        await prisma.memory.update({
          where: { id: j.id },
          data: { supersededBy: globalId, supersededAt: now },
        });
      }
      if (j.action === "SUPER") counts.super++;
      else counts.stale++;
    } else if (j.action === "CREATE") {
      // 全局记忆有但碎片未覆盖 → globalMemory 已在 step 4 入库 (type=GLOBAL)
      // 碎片有独特价值, 不标 superseded, 保留原样
      counts.create++;
    } else if (j.action === "MERGE") {
      // 重复碎片: 标记 supersededBy (同 SUPER, 因为被全局记忆覆盖)
      if (globalId) {
        await prisma.memory.update({
          where: { id: j.id },
          data: { supersededBy: globalId, supersededAt: now },
        }).catch(() => {}); // 碎片可能已被删
      }
      counts.merge++;
    }
  }

  // 注意: V1.6 payload 处理已移到 calibrateMemory 函数开头 (line 950-997),
  // 这里不再重复. payloadApplied 是 V1.6 在函数开头初始化的变量, 这里复用.
  return { ...counts, payloadApplied };
}

/**
 * 4. writeProductsToDB — 4 类产物入库 + contentHash 去重
 * 输入: SynthesisProduct (合并后), groupKey, theme
 * 输出: 各表插入条数
 */
async function writeProductsToDB(
  product: SynthesisProduct,
  groupKey: string,
  theme: string,
): Promise<{ memory: number; knowledge: number; practice: number; reflection: number }> {
  const counts = { memory: 0, knowledge: 0, practice: 0, reflection: 0 };
  // 2026-10-10 (practice cmv23vi4m00b1j6h59s 遗留): 格式闸拒绝数必须可观测。
  //   此前只 `continue` 不统计, 导致 291 条反思全被丢但 STEP4 只报 0, 无法区分
  //   "LLM 没产出" 与 "产出被闸丢弃" (go-1791042673890-eapfxy 的根因盲区)。
  const rejected = { knowledge: 0, practice: 0, reflection: 0 };

  // --- Memory (全局记忆) - 结构化 + 质量门控 ---
  if (product.globalMemory) {
    // 统一转为 string (新格式是 JSON 对象, 旧格式是 string)
    const memStr = typeof product.globalMemory === "string"
      ? product.globalMemory
      : JSON.stringify(product.globalMemory);
    const parsed = parseContent(memStr);

    // 质量门控: 只对结构化数据计算质量分; 旧格式自由文本直接入库 (兼容)
    let qualityScore = 0;
    let confidence = 0.4;
    let summary: string | null = null;
    if (!parsed.legacy && parsed.structured) {
      const q = calcMemoryQuality(parsed.structured, groupKey);
      qualityScore = q.qualityScore;
      confidence = q.confidence;
      summary = parsed.summary;
      // 质量门控: < 0.3 不入库
      if (qualityScore < 0.3) {
        console.log(`[global-organizer] Memory 质量分 ${qualityScore.toFixed(2)} < 0.3, 跳过入库: ${summary.slice(0, 60)}`);
        // 记录到 Reflection 而非直接丢弃
        await safeCreateReflection(prisma, {
          data: {
            title: `低质量记忆被拦截: ${summary.slice(0, 40)}`,
            description: `质量分 ${qualityScore.toFixed(2)}, 缺少证据/推理/范围. 原始内容: ${memStr.slice(0, 200)}`,
            category: "QUALITY_GATE",
            status: "OPEN",
            priority: "P3",
            lesson: "飞轮产出需包含 evidence 和 reasoning 才能入库",
            score: calcQualityScore({ type: "reflection", content: `质量分 ${qualityScore.toFixed(2)}, 缺少证据/推理/范围. 原始内容: ${memStr.slice(0, 200)}`, title: `低质量记忆被拦截: ${summary.slice(0, 40)}`, priority: "P3", lesson: "飞轮产出需包含 evidence 和 reasoning 才能入库" }),  // 2026-08-27 补齐
            contentHash: sha256("gate_" + memStr),
          },
        }).catch(() => {});
      }
    }

    if (parsed.legacy || qualityScore >= 0.3) {
      const hash = sha256(memStr);
      // 2026-10-25 撤回流程补漏: 去重判定必须只看**活行**(未被取代)。Memory 表没有 stale 列
      //   (只有 supersededBy), 口径 = supersededBy IS NULL。原实现只按 contentHash 查,
      //   已被取代的旧全局记忆仍会挡住新记忆落库。
      const existing = await prisma.memory.findFirst({ where: liveRowWhere("memory", { contentHash: hash }) });
      if (!existing) {
        const importance = parsed.legacy ? 0.5 : qualityScore; // 旧数据保持中等, 新数据按质量
        const tier = parsed.legacy ? "WARM" : qualityToTier(qualityScore);
        // round 57 G4(2026-10-10): title 语义已由 round58 裁决为归一; 内容闸仍可能 null -> 显式记日志, 不静默丢.
        const _mem = await safeCreateMemory(prisma, {
          data: {
            content: memStr,
            summary: summary || (parsed.legacy ? parsed.summary.slice(0, 200) : null),
            theme,
            contentHash: hash,
            sourceType: "GLOBAL_ORGANIZER",
            sourceId: groupKey,
            tier,
            type: "GLOBAL",
            agentSource: "PIPELINE_HERMES",
            importance,
            qualityScore,
          },
        });
        if (!_mem) console.warn("[global-organizer] Memory 被 store 内容闸拒绝(不合规), 未落库");
        counts.memory = _mem ? 1 : 0;
      }
    }
  }

  // --- Knowledge - 结构化 + 质量门控 ---
  for (const k of product.knowledge) {
    // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证 (轻量, 不重试 LLM)
    //   不合规 -> 静默 drop, 由 prompt 注入硬约束 + scripts/check-product-format.cjs 守门共同降量
    const kAny = k as any;
    const kv = validateFlywheelProduct(
      { title: k.title, content: typeof k.content === "string" ? k.content : (kAny.summary || kAny.statement || JSON.stringify(k.content)) },
      { kind: "knowledge", maxTitle: 30 }
    );
    if (!kv.ok) {
      rejected.knowledge++;
      console.log(`[global-organizer] format-rejected knowledge: title="${(k.title || "").slice(0, 30)}" reasons=${JSON.stringify(kv.reasons)}`);
      continue;
    }
    // LLM 可能不产出 content 字段 (只有 summary/statement 等), 用整个对象做 fallback
    const kStr = typeof k.content === "string" ? k.content : JSON.stringify(k.content ?? k);
    const parsed = parseContent(kStr);
    let qualityScore = 0;
    let summary: string | null = null;
    if (!parsed.legacy && parsed.structured) {
      qualityScore = calcKnowledgeQuality(parsed.structured);
      summary = parsed.summary;
      if (qualityScore < 0.3) continue; // 跳过低质量
    }
    const kTitle = k.title || summary?.slice(0, 30) || kStr.slice(0, 30);
    const hash = sha256(kTitle + kStr);
    // 2026-10-25 撤回流程补漏: 只按 contentHash 查 -> 被撤回(stale=1)的知识行会挡住同内容新知识落库。
    //   活行口径 = 未撤回 + 未被取代(见 stale-aware-dedup.ts)。
    const existing = await prisma.knowledge.findFirst({ where: liveRowWhere("knowledge", { contentHash: hash }) });
    if (!existing) {
      await safeCreateKnowledge(prisma, {
        data: {
          title: kTitle,
          content: kStr,
          theme: k.theme || theme,
          contentHash: hash,
          sourceType: "GLOBAL_ORGANIZER",
          sourceId: groupKey,
          agentSource: "PIPELINE_HERMES",
          confidence: parsed.legacy ? 0.5 : qualityScore,
        },
      });
      counts.knowledge++;
    }
  }

  // --- Practice - 结构化 ---
  for (const p of product.practice) {
    // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证
    const pAny = p as any;
    const pv = validateFlywheelProduct(
      { title: p.title, content: typeof p.content === "string" ? p.content : (pAny.summary || pAny.description || JSON.stringify(p.content)) },
      { kind: "practice", maxTitle: 30 }
    );
    if (!pv.ok) {
      rejected.practice++;
      console.log(`[global-organizer] format-rejected practice: title="${(p.title || "").slice(0, 30)}" reasons=${JSON.stringify(pv.reasons)}`);
      continue;
    }
    // LLM 可能不产出 content 字段, 用整个对象做 fallback
    const pStr = typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? p);
    const parsed = parseContent(pStr);
    const pTitle = p.title || parsed.summary?.slice(0, 30) || pStr.slice(0, 30);
    const hash = sha256(pTitle + pStr);
    // 2026-10-25 撤回流程补漏: 同上, 被撤回的 Practice 行不得挡住同内容新实践落库。
    const existing = await prisma.practice.findFirst({ where: liveRowWhere("practice", { contentHash: hash }) });
    if (!existing) {
      // 从结构化数据提取 outcome
      // 2026-10-07 P4: LLM 直出 outcome 走写入侧投影(此前 1,060 种自由文本取值由此路径混入)
      const outcome = projectPracticeOutcome(!parsed.legacy && parsed.structured?.outcome ? parsed.structured.outcome : "SUCCESS");
      await safeCreatePractice(prisma, {
        data: {
          title: pTitle,
          description: pStr,
          type: normalizeEnumToken("WORKFLOW"),
          outcome,
          theme: p.theme || theme,
          contentHash: hash,
          sourceType: "GLOBAL_ORGANIZER",
          sourceId: groupKey,
          agentSource: "PIPELINE_HERMES",
          startedAt: new Date(),
          completedAt: new Date(),
          // 2026-10-07 修(实测 bug): 这条 create **没写 qualityScore** —— 全库 Practice 有 16,862 行(30%)
          //   qualityScore IS NULL, 抽样全部来自本路径(sourceType=GLOBAL_ORGANIZER)。后果:
          //   ① FW-QUALITY 的 AVG(qualityScore) 跳过 NULL -> 这批产物不进质量读数(等于隐形);
          //   ② 按质量分的闸门/排序对它们是"未知"(或当 0); ③ 与 db-writer:823 / agent 路由同表不同口径,
          //   无法跨期比较。与 db-writer 同法: 用 calcQualityScore 兜底(本文件第 18 行已 import)。
          qualityScore: calcQualityScore({ type: "practice", content: pStr, title: pTitle, theme: p.theme || theme, type2: "WORKFLOW", outcome }),
        },
      });
      counts.practice++;
    }
  }

  // --- Reflection ---
  for (const r of product.reflection) {
    // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证
    // 2026-10-10 (遗留修复): reflection 的产物是 description(发生了什么) + lesson(学到什么) 两段,
    //   两段都是产物本体, 校验必须看合并文本, 不能只看 description (lesson 里常有 "必须/建议/因为" 等
    //   V3 三选一信号)。markdown 硬闸已在 validateFlywheelProduct 内对 reflection 降级 (契约无 content 字段)。
    const rText = [r.description, r.lesson].filter(Boolean).join("\n");
    const rv = validateFlywheelProduct(
      { title: r.title, content: rText },
      { kind: "reflection", maxTitle: 30 }
    );
    if (!rv.ok) {
      rejected.reflection++;
      console.log(`[global-organizer] format-rejected reflection: title="${(r.title || "").slice(0, 30)}" reasons=${JSON.stringify(rv.reasons)}`);
      continue;
    }
    const rTitle = r.title || r.description?.slice(0, 30) || r.lesson?.slice(0, 30) || "Untitled Reflection";
    const hash = sha256(rTitle + (r.description || "") + (r.lesson || ""));
    // 2026-10-25 撤回流程补漏: Reflection 无 stale 列, 但同样要排除已被取代的行。
    const existing = await prisma.reflection.findFirst({ where: liveRowWhere("reflection", { contentHash: hash }) });
    if (!existing) {
      await safeCreateReflection(prisma, {
        data: {
          title: rTitle,
          description: r.description || "",
          lesson: r.lesson || "",
          theme,
          score: calcQualityScore({ type: "reflection", content: r.description || rTitle, title: rTitle, theme, priority: "P2", lesson: r.lesson || "" }),  // 2026-08-27 补齐: 原 19,562 条 NULL score 根因
          contentHash: hash,
          sourceType: "GLOBAL_ORGANIZER",
          sourceId: groupKey,
          agentSource: "PIPELINE_HERMES",
          relatedSessionIds: groupKey.startsWith("agent-h:") ? groupKey : `agent-h:hermes:${groupKey}`,
          status: "OPEN",
          priority: "P2",
        },
      });
      counts.reflection++;
    }
  }

  // 2026-10-10 (遗留修复): 拒绝明细必须落日志, 否则 "产出全被闸丢" 会伪装成 "LLM 没产出"。
  if (rejected.knowledge || rejected.practice || rejected.reflection) {
    console.log(`[global-organizer] format-rejected summary: ${JSON.stringify(rejected)}`);
  }
  return counts;
}

/**
 * repairJson — 状态机修复 LLM 产出的常见 JSON 错误
 * 修复: 未转义换行/Tab、智能引号、尾逗号
 */
function repairJson(raw: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }

    if (inStr) {
      // 字符串内: 替换未转义控制字符
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      // 智能引号 → 直引号
      if (ch === "\u201c" || ch === "\u201d") { out += '"'; continue; }
      out += ch;
    } else {
      // 字符串外: 智能引号 → 直引号, 尾逗号处理
      if (ch === "\u201c" || ch === "\u201d") { out += '"'; continue; }
      if (ch === "\u2018" || ch === "\u2019") { out += "'"; continue; }
      // 尾逗号: ,} 或 ,] → } 或 ]
      if (ch === ",") {
        // 向前看跳过空白
        let j = i + 1;
        while (j < raw.length && /\s/.test(raw[j])) j++;
        if (raw[j] === "}" || raw[j] === "]") continue; // 跳过尾逗号
      }
      out += ch;
    }
  }

  // 截断修复: 如果还在字符串内, 关闭字符串
  if (inStr) {
    out += '"';
  }

  // 自动补全未关闭的括号 (从后往前)
  let openBrackets = 0;
  let openBraces = 0;
  let inStr2 = false;
  let escaped2 = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (escaped2) { escaped2 = false; continue; }
    if (ch === '\\') { escaped2 = true; continue; }
    if (ch === '"') { inStr2 = !inStr2; continue; }
    if (inStr2) continue;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
  }
  // 移除尾部可能的尾逗号
  out = out.replace(/,\s*$/, '');
  for (let i = 0; i < openBrackets; i++) out += ']';
  for (let i = 0; i < openBraces; i++) out += '}';

  return out;
}

/**
 * 3. llmSynthesize — LLM 全局整理, 产出 4 类认知 JSON
 * 输入: GroupMessage[] (一个 chunk), isLastChunk (是否最后一批)
 * 输出: SynthesisProduct (最后一批含 globalMemory, 非最后一批 globalMemory 为空)
 */
async function llmSynthesize(
  chunk: GroupMessage[],
  isLastChunk: boolean,
  prevKnowledgeSummary: string,
  existingThemes: string[],
): Promise<SynthesisProduct> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  const model = process.env.ANTHROPIC_MODEL || "MiniMax-M2.7";

  if (!apiKey) throw new Error("LLM API key 未配置 (ANTHROPIC_AUTH_TOKEN)");

  // 格式化 messages 为文本
  const messagesText = chunk
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");

  const systemPrompt = `你是一个认知整理引擎。给定一段 AI agent 与用户的完整对话,请从全局视角整理出以下 4 类认知产物。

输出严格 JSON 格式:
{
  "theme": "主题标签 (从已有列表选最匹配的, 无匹配时用4字以内新标签)",
  "globalMemory": {
    "summary": "一句话总结核心事实 (≤200字, 人类可读)",
    "claim": "核心论断 (一句话)",
    "reasoning": "推理过程/为什么成立",
    "evidence": [{"type": "对话", "excerpt": "对话中的原文摘录"}],
    "scope": "适用范围/场景",
    "verifiable": true,
    "verifiedAt": null
  },
  "knowledge": [
    {
      "summary": "一句话总结 (人类可读)",
      "statement": "知识陈述 (核心结论)",
      "prerequisites": "前置条件",
      "applicability": "适用范围",
      "counterexample": "反例/对比 (可选)",
      "verification": "验证方法",
      "staleCheck": "何时需复核 (可选)",
      "theme": "主题标签",
      "title": "短标题"
    }
  ],
  "practice": [
    {
      "summary": "一句话总结",
      "situation": "场景",
      "actions": ["步骤1", "步骤2"],
      "result": "结果",
      "outcome": "SUCCESS 或 FAILED",
      "lessons": "学到了什么 (失败时必填)",
      "reusable": true,
      "theme": "主题标签",
      "title": "短标题"
    }
  ],
  "reflection": [
    {
      "title": "踩坑标题",
      "description": "发生了什么",
      "lesson": "学到了什么"
    }
  ]
}

已有主题列表 (优先从中选择):
${existingThemes.map((t, i) => `${i + 1}. ${t}`).join("\n") || "(无)"}

规则:
- theme: 必须从已有列表选最匹配的; 仅当确实无匹配时才创建新标签 (4字以内)
- globalMemory: ${isLastChunk ? "本次是最后一批, 请结合前序摘要产出最终全局记忆" : "本次不是最后一批, globalMemory 留空字符串"}
- knowledge/practice/reflection: 只提取真正有价值的, 不凑数
- 严格 JSON, 不要 markdown 代码块

${V3_FIVE_PIECE_HARD_RULES}`;

  const userPrompt = isLastChunk && prevKnowledgeSummary
    ? `前序批次已提取的知识摘要:\n${prevKnowledgeSummary}\n\n=== 本批对话 ===\n${messagesText}`
    : `=== 对话内容 ===\n${messagesText}`;

  const res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  }, 120000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawText: string = data.content?.[0]?.text || "";

  // 从可能包含 markdown 代码块的响应中提取 JSON
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("LLM 返回非 JSON: " + rawText.slice(0, 200));

  let parsed: SynthesisProduct;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e1) {
    // 宽松解析: 状态机修复 (未转义换行/引号/尾逗号/智能引号)
    const cleaned = repairJson(jsonMatch[0]);
    try {
      parsed = JSON.parse(cleaned);
    } catch (e2) {
      console.error(`[global-organizer] JSON parse failed twice. Raw (300ch): ${rawText.slice(0, 300)}`);
      throw new Error(`JSON 解析失败: ${(e2 as Error).message}`);
    }
  }

  // 保底: 确保字段存在
  return {
    theme: parsed.theme || parsed.knowledge?.[0]?.theme || chunk[0]?.content?.slice(0, 8) || "未知",
    globalMemory: parsed.globalMemory || "",
    knowledge: parsed.knowledge || [],
    practice: parsed.practice || [],
    reflection: parsed.reflection || [],
  };
}

// ===== 2026-07-17 V1.6 新增: 主题粒度入口 + 验证再跑 =====
// 设计: docs/lions-flywheel-v16-implementation-design.md §2.1, §2.3

/**
 * V1.6 runGlobalOrganizerByTheme — 主题粒度入口
 * 复用 V1.5 loadThemeFullMessages (loadGroupMessages 不需要)
 * 走 runGlobalOrganizer 5 步流水线, groupKey 用虚拟 "__theme__:<theme>" 标识
 *
 * 注意: V1.5 loadThemeFullMessages 在 reflect.ts 中是 export, 这里需要 import
 * 如果未来 reflect.ts 重构, 此函数需同步更新
 */
export async function runGlobalOrganizerByTheme(
  theme: string,
  presetMessages?: GroupMessage[],
): Promise<OrganizeResult> {
  console.log(`[global-organizer:V1.6] runByTheme START theme="${theme}"${presetMessages ? " (presetMessages)" : ""}`);
  // 加载主题全文 (走 V1.5 loadThemeFullMessages, session_uid 直查)
  // 动态 import 避免循环依赖 (rerunTheme 也会用 reflect.ts, 双向引用风险)
  let allMessages = presetMessages;
  if (!allMessages || allMessages.length === 0) {
    const { loadThemeFullMessages } = await import("./reflect");
    allMessages = await loadThemeFullMessages(theme);
  }
  if (allMessages.length === 0) {
    throw new Error(`theme "${theme}" 无有效消息 (空主题或 session API 不可达)`);
  }
  // 虚拟 groupKey (V1 runGlobalOrganizer 需要 groupKey, 用 __theme__: 前缀避免污染)
  const virtualGroupKey = `__theme__:${theme}`;
  const result = await runGlobalOrganizer(virtualGroupKey, allMessages);
  console.log(`[global-organizer:V1.6] runByTheme END theme="${theme}" products=${JSON.stringify(result.products)}`);
  return result;
}

/**
 * V1.6 rerunTheme — 主题重跑 (反射 → 组织 → 再反射), 验证 ImprovingTask 效果
 *
 * 流程:
 * 1. 取重跑前 FlywheelReflection.coverageScore → beforeCoverage
 * 2. 调 runGlobalOrganizerByTheme(theme) 重跑 5 步流水线
 * 3. 调 V1.5 reflectWorker(theme) 重反思
 * 4. 取重跑后 FlywheelReflection.coverageScore → afterCoverage
 * 5. 算 delta, 写 Task.rerunResult (如 sourceReflectionId 传入)
 *
 * 限制: 24h 内同主题只允许 1 次 rerun (避免 token 滥用)
 */
export async function rerunTheme(
  theme: string,
  sourceTaskId?: string,
): Promise<{ beforeCoverage: number; afterCoverage: number; delta: number; reranAt: string; theme?: string; counts?: Record<string, number>; durationMs?: number; beforeReflectionId?: string; afterReflectionId?: string; skipped?: boolean; skipReason?: string }> {
  console.log(`[rerunTheme:V1.6] START theme="${theme}" sourceTaskId=${sourceTaskId || "(none)"}`);

  // 1. 24h rerun 限流: 查 Task 表同主题最近 rerun
  if (sourceTaskId) {
    const lastRerun = await prisma.task.findFirst({
      where: {
        theme,
        rerunResult: { not: null },
        updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
    });
    if (lastRerun) {
      throw new Error(`主题 "${theme}" 24h 内已 rerun 过 (taskId=${lastRerun.id}), 跳过避免 token 滥用`);
    }
  }

  // 2. beforeCoverage
  const before = await prisma.flywheelReflection.findUnique({
    where: { theme },
    select: { coverageScore: true, id: true, updatedAt: true },
  });
  const beforeCoverage = before?.coverageScore ?? 0;
  const beforeReflectionId = before?.id ?? null;
  const beforeUpdatedAt = before?.updatedAt;

  // 2.5 增量检查: 加载消息, 看是否有比上次反思更新的对话
  // ★ P1-2 修复: 原来全量重跑同一批对话, LLM 产物变化在方差内, coverage 不提升
  //   现在先检查是否有新对话, 无新对话则跳过 LLM 步骤 (省 token + 避免无效重跑)
  const { loadThemeFullMessages } = await import("./reflect");
  const allMessages = await loadThemeFullMessages(theme);
  if (allMessages.length === 0) {
    throw new Error(`主题 "${theme}" 无有效消息 (空主题或 session API 不可达)`);
  }
  const latestMsgTime = allMessages.reduce((max: Date, m: any) => {
    return m.timestamp > max ? m.timestamp : max;
  }, new Date(0));
  if (beforeUpdatedAt && latestMsgTime <= beforeUpdatedAt) {
    console.log(`[rerunTheme:V1.6] SKIP theme="${theme}" 无新对话 (latest=${latestMsgTime.toISOString()} <= lastReflection=${beforeUpdatedAt.toISOString()})`);
    // 2026-09-10 遗留#4: 增量轮(跳过)也要留审计 — 原实现直接 return, 反思行看不出"曾被 rerun 且为何跳过"
    try {
      const cur = await prisma.flywheelReflection.findUnique({ where: { theme }, select: { sourceStats: true } });
      let base: any = {};
      try { base = cur?.sourceStats ? JSON.parse(cur.sourceStats) : {}; } catch { base = {}; }
      base.lastRerun = {
        at: new Date().toISOString(),
        result: "skipped",
        reason: "no_new_messages",
        beforeCoverage,
        lastMessageAt: latestMsgTime.toISOString(),
        lastReflectionAt: beforeUpdatedAt.toISOString(),
      };
      await prisma.flywheelReflection.update({ where: { theme }, data: { sourceStats: JSON.stringify(base) } });
    } catch (e: any) {
      console.warn(`[rerunTheme] 跳过审计落行失败(非致命): ${(e?.message || "").slice(0, 80)}`);
    }
    return {
      theme,
      beforeCoverage,
      afterCoverage: beforeCoverage,
      delta: 0,
      reranAt: new Date().toISOString(),
      beforeReflectionId: beforeReflectionId ?? undefined,
      afterReflectionId: beforeReflectionId ?? undefined,
      skipped: true,
      skipReason: "no_new_messages",
      counts: {},
    };
  }
  console.log(`[rerunTheme:V1.6] 有新对话 (latest=${latestMsgTime.toISOString()} > lastReflection=${beforeUpdatedAt?.toISOString() || "null"}), 执行重跑`);

  // 3. 重新组织 (5 步流水线, 复用已加载的 messages 避免重复 fetch)
  await runGlobalOrganizerByTheme(theme, allMessages);

  // 4. 再反思 (V1.5 reflectWorker)
  // 动态 import 避免循环依赖 (reflect.ts 内部 import prisma, 不会循环; 但保险起见用 require)
  const { reflectWorker } = await import("./reflect");
  await reflectWorker(theme);

  // 5. afterCoverage
  const after = await prisma.flywheelReflection.findUnique({
    where: { theme },
    select: { coverageScore: true, id: true },
  });
  const afterCoverage = after?.coverageScore ?? 0;
  const afterReflectionId = after?.id ?? null;
  const delta = afterCoverage - beforeCoverage;
  const reranAt = new Date().toISOString();

  console.log(`[rerunTheme:V1.6] END theme="${theme}" before=${beforeCoverage.toFixed(3)} after=${afterCoverage.toFixed(3)} delta=${delta.toFixed(3)}`);

  // 6. 写 Task.rerunResult (如 sourceTaskId 传入)
  if (sourceTaskId) {
    const rerunResult = JSON.stringify({
      theme,
      before: beforeCoverage,
      after: afterCoverage,
      delta,
      reranAt,
      beforeReflectionId,
      afterReflectionId,
    });
    try {
      await prisma.task.update({
        where: { id: sourceTaskId },
        data: { rerunResult, updatedAt: new Date() },
      });
    } catch (e: any) {
      console.error(`[rerunTheme:V1.6] update task.rerunResult failed: ${e.message}`);
    }
  }

  return { beforeCoverage, afterCoverage, delta, reranAt };
}

// ===== V1.6 NOTE: loadThemeFullMessages 在 reflect.ts 中 export, 这里避免重复实现 =====
// rerunTheme 用动态 import("./reflect") 调 reflectWorker, 复用了 V1.5 整套反思链路
// 这样 V1.5 任何对反思逻辑的优化都自动同步到 V1.6 rerun 路径, 0 重复开发
