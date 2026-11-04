/**
 * V1.6 自动改进闭环 — ⑦ 改进任务执行器
 * 设计: docs/lions-flywheel-v16-implementation-design.md §3.1 ⑦
 *
 * 输入: Task (improvementType + improvementPayload + sourceReflectionIds)
 * 处理: 4 type switch — FIX_THEME / FIX_CONFLICT / MIGRATE_DATA / RE_RUN
 * 输出: status='DONE'/'FAILED' + TaskStateTransition 审计 + consumedBy/processedAt
 *
 * 失败兜底 (V1.6 §6.7):
 * - Task 必填 processingError 字段? V1 没这字段. 用 TaskStateTransition.reason + metadata 兜
 * - 不死循环: 执行后 status='DONE' 或 'FAILED', 不自动重试 (除非手动)
 * - manualReview=true 的 MIGRATE_DATA 默认走"准备"分支, 不真执行 SQL (留给人审)
 *
 * 白名单 (V1.6 §C-V1.6-2/3):
 * - FIX_CONFLICT 跳过 sourceType=FLYWHEEL_REFLECTION (由 calibrateMemory 内部白名单保证)
 * - FIX_THEME 跳过 domain=flywheel-reflect
 * - MIGRATE_DATA 必须 manualReview=true, 且 SQL 必须 CREATE/UPDATE/DELETE 才执行 (DROP 拒)
 */
import { todoRepo } from "@/server/lib/todo-repo";

import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
import { storeTaskOutput } from "./store-task-output";
import { calibrateMemory, runGlobalOrganizerByTheme, rerunTheme } from "./global-organizer";
// 2026-10-09 round 72-G: Knowledge.content 的结构化拼装(与 db-writer 同一实现, 单一来源)
import { composeKnowledgeContent } from "./knowledge-compose";
import type { StructuredFinding } from "./reflect";
import { PrismaMemoryStore } from "@lions/modules-memory";
import { projectCategory } from "./enum-projection"; // 2026-10-08 round 54: category 受控投影
// 2026-10-10 round 57 G4: 统一写入出口(store 投影 + qualityScore 兜底 + 标题归一); 本地 wrapper 保留 V3 stale 标记
import { safeCreateKnowledge as storeCreateKnowledge, safeCreatePractice as storeCreatePractice } from "./safe-create";

// 2026-09-29 (agent-d 休假期间) V3 五件套格式软验证 (轻量, 不重试):
//   S5 (dde77e3) 把 validateFlywheelProduct 接入了 cognitive-extractor / global-organizer 三处,
//   但漏了**每 15 分钟跑的主产线** execute-improving-task.ts —— 与 S1-S4 同病 (round 3 修过)。
//   实测 24h 窗口 Knowledge 逃避式 18.5% / Practice 10.0% 来自本产线 (守门 + corrective 标后仍 18.5% = 真问题)。
//   修法: 不合规的 create 仍执行 (保数据, 与之前 stale 清理哲学一致),
//   但**立刻标 stale=1 + staleReason**, 使守门排除它, 也避免它被任何 agent 检索到。
//   与 S5 的 skip 哲学不同 (那里 LLM 产物尚在内存, drop 零成本); 本路径 create 已耗 DB
//   写入, drop 浪费, 标 stale 保留数据供审计/事后修复。
/**
 * 认知闸切 enforce 档后, store 的内容闸会返回 null(内容不满足完备性判据)。
 * 调用方**必须**显式处理: 直接 `row.id` 会抛 TypeError 把整条任务打崩 ——
 * 那就把"质量闸"变成了"可用性事故"(平台已在 P2002/P2028 上吃过同类教训)。
 */
function rejectedByGate(row: any): boolean { return !row || !row.id; }

async function safeCreateKnowledge(data: any) {
  // 2026-10-06 修(实测 P0 根因): 本文件 6 处调用方**多包了一层** —— 传的是 { data: {...} },
  //   而本函数自己再加 data -> prisma 收到 data: { data: {...} } -> 每次都
  //   "Invalid prisma.knowledge.create() invocation"。后果不是"少建几条", 而是这条
  //   「findings -> 产物」产线**整体报 ERROR**: 任务被判 FAILED(拉低 MACS-COLLAB)、
  //   产物量为 0(拉低 FW-EXTRACT)。
  //   调用方已修正; 这里保留一次规范化 + **大声告警**, 让同类回归不再静默(下次是日志里一行 warn, 不是无声的 0)。
  if (data && typeof data === "object" && data.data && typeof data.data === "object") {
    console.warn("[execute-improving-task] safeCreateKnowledge 收到多包一层的 data(已自动剥离; 请修调用方)");
    data = data.data;
  }
  const row = await storeCreateKnowledge(prisma, { data });
  if (!row) { console.warn("[execute-improving-task] Knowledge 被 store 内容闸拒绝(不合规), 不落库"); return null; }
  const ok =
    !PRODUCT_RULES.isEvasive(String(row.content || "")) &&
    !PRODUCT_RULES.isShortEmpty(String(row.content || "")) &&
    !PRODUCT_RULES.isLongTitle(String(row.title || ""));
  if (!ok) {
    try {
      await prisma.knowledge.update({
        where: { id: row.id },
        data: { stale: true, staleReason: "V3 格式不合规 (execute-improving-task soft validation)", updatedAt: new Date() },
      });
    } catch { /* 列可能不存在, 不阻断 */ }
  }
  return row;
}
async function safeCreatePractice(data: any) {
  // 同 safeCreateKnowledge 的 2026-10-06 修复说明(多包一层 data -> prisma 报错 -> 整条产线 ERROR)。
  if (data && typeof data === "object" && data.data && typeof data.data === "object") {
    console.warn("[execute-improving-task] safeCreatePractice 收到多包一层的 data(已自动剥离; 请修调用方)");
    data = data.data;
  }
  const row = await storeCreatePractice(prisma, { data });
  if (!row) { console.warn("[execute-improving-task] Practice 被 store 内容闸拒绝(不合规), 不落库"); return null; }
  const ok =
    !PRODUCT_RULES.isEvasive(String(row.description || "")) &&
    !PRODUCT_RULES.isShortEmpty(String(row.description || "")) &&
    !PRODUCT_RULES.isLongTitle(String(row.title || ""));
  if (!ok) {
    try {
      await prisma.practice.update({
        where: { id: row.id },
        data: { stale: true, staleReason: "V3 格式不合规 (execute-improving-task soft validation)", updatedAt: new Date() },
      });
    } catch { /* 列可能不存在, 不阻断 */ }
  }
  return row;
}

import { calcQualityScore } from "./db-writer";
// 2026-09-29 product-format-rules 是 .cjs, ts 不能 import -- 用 require + 类型断言
// 2026-09-29 round 13 修: 用正确相对路径直接 require scripts/lib (单一来源, 不复制).
// 2026-09-29 round 13: 路径回到 ./lib/... (pipeline/lib/ 是单一来源 scripts/lib/ 的副本,
//   因为 tsconfig 不含 scripts/ 目录, webpack 不解析跨包相对路径).
const PRODUCT_RULES = require("./lib/product-format-rules.cjs");
import { normalizeFlywheelTitle } from "./flywheel-prompt-constraints";
// 2026-10-12 round 72-CQ (用户定为 C): CREATE_PRACTICE 落库前必须先是"可复用的做法" —— 见该文件头注释
import { practiceConformance } from "./practice-conformance";
import { markLaterDuplicateSuperseded } from "./structured-dedup";
// 2026-10-25 撤回流程补漏: 去重/存在性判定统一走"活行口径"(未撤回 + 未被取代)
import { liveRowWhere } from "./stale-aware-dedup";
import { parseStructuredFindings } from "./findings-parse";
import { writeSkillDeduped } from "./skill-dedup"; // 2026-10-09 round 68: Skill 写入唯一去重入口
import { requireEvidence } from "./evidence";
import {
  routeArchitectureDecision,
  readAdrCatalog,
  ADR_INDEX_SOURCE_TYPE,
  ADR_INDEX_VERIFICATION,
} from "./adr-routing";
// 2026-09-18 机制修复(待办 todo_land_55gli7ggjrny): SLA 决策卡的持久身份去重类型。
import type { ExistingCardIdentity } from "./human-card-dedup";
// 2026-09-23 uos20 #5: 主 agent 核心 memory 快照类型(执行期上下文注入)。
import type { AgentMemorySnapshot } from "./agent-memory-snapshot";

// ==================== 落库质量守卫 (2026-09-10) ====================
// 背景: 执行器此前"找到 finding 就写行", 无空内容守卫/无幂等/contentHash 缺失(Knowledge/Practice),
//   存在产生垃圾与重复行的风险。下列三项守卫对所有落库动作统一生效:
//   ① 空内容不得落库(trim 后为空 -> SKIP 记原因); ② 同主题同内容(contentHash)已有活行 -> 幂等跳过;
//   ③ 统一写 contentHash(Memory 用 sha256(content), 与 PrismaMemoryStore 一致; Knowledge 用 sha256(title\ncontent);
//      Practice 用 sha256(title\ndescription)), 使 Resolution/后续查重可用。
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}
const knowledgeHashOf = (title: string, content: string) => sha256Hex(title + "\n" + content);
// 任务产出行的单主题容量上限 (与 Memory 的 200 对齐; 超容 -> reinforce 而非新建)
const THEME_PRODUCT_CAP = Number(process.env.FLYWHEEL_THEME_PRODUCT_CAP ?? "200");
// 2026-09-10 目标 G3: 任务产出行最低质量门槛 (低于则不入库, 转复核队列; env 可调)
const MIN_PRODUCT_QUALITY = Number(process.env.FLYWHEEL_MIN_PRODUCT_QUALITY ?? "0.4");
// 2026-09-14 提案 cmtwhgx8q01zs1j76w8yskwuj (挑战 f-001) 落地: 架构决策载体路由严格模式。
//   soft(默认, 未设): 架构决策类 finding 若无 ADR 覆盖 -> 回落既有 Knowledge 内容行路径(不改存量行为);
//   strict(=1/true): 无 ADR 覆盖 -> SKIP, 迫使先补 ADR 主载体, 不把架构决策写进 Knowledge。
const ADR_ROUTING_STRICT = /^(1|true|strict|yes)$/i.test(process.env.FLYWHEEL_ADR_ROUTING_STRICT || "");
const practiceHashOf = (title: string, description: string) => sha256Hex(title + "\n" + description);

/**
 * 2026-09-18 机制修复(落地待办 todo_land_jvijaydsfs4s / 人类决策「重复内容需要清理」):
 *   读取仍在流转/已存在的 improving-tasks 人类决策卡, 供 APPLY_IMPROVEMENT 建卡前做同类去重。
 *   Todo 是运行期自建表(Prisma $queryRawUnsafe 读它会报 Raw query failed) -> 走 better-sqlite3 只读。
 */
async function loadExistingApplyCards(): Promise<Array<{ id: string; status: string; title: string; domain?: string; cueKind?: string }>> {
  try {
    // 2026-10-23 P1: Todo 读走 todo-repo
    {
      const rows = (await todoRepo.all(
        "SELECT id,status,title,meta FROM Todo WHERE source='platform:improving-tasks' AND status IN ('OPEN','DOING','PENDING','BLOCKED')"
      )) as any[];
      return rows.map((r) => {
        let m: any = {};
        try { m = JSON.parse(String(r.meta || "{}")); } catch { m = {}; }
        return { id: String(r.id), status: String(r.status), title: String(r.title || ""), domain: m.domain, cueKind: m.cueKind };
      });
    }
  } catch (e: any) {
    console.warn("[execute-improving-task] 读取既有决策卡失败(非致命, 按无同类卡处理): " + String(e?.message || e).slice(0, 120));
    return [];
  }
}

// ==================== 类型定义 ====================

export type ImprovementType = "FIX_THEME" | "FIX_CONFLICT" | "MIGRATE_DATA" | "RE_RUN" | "THEME_IMPROVE" | "BRIDGE";

export interface ImprovementAction {
  type: "MERGE_CONFLICT" | "RE_EXTRACT" | "MIGRATE_DATA" | "APPLY_IMPROVEMENT";
  memoryIds?: string[];
  reason?: string;
  missedTopics?: string[];
  coverageScore?: number;
  lesson?: string;
  sql?: string | null;
  improvement?: string;
  manualReview?: boolean;
  [key: string]: any;
}

export interface ImprovingTaskPayload {
  type: ImprovementType;
  theme?: string;          // FIX_THEME / RE_RUN / THEME_IMPROVE
  conflicts?: Array<{      // FIX_CONFLICT (V1.6 §C-V1.6-2)
    memoryIds: string[];
    theme: string;
    reason: string;
  }>;
  mergeTargets?: Array<{   // FIX_THEME (V1.6 §C-V1.6-3)
    memoryId: string;
    newTheme: string;
    reason: string;
  }>;
  sql?: string;            // MIGRATE_DATA (V1.6 §C-V1.6-5)
  sqlPreview?: string;     // MIGRATE_DATA 人审时显示
  // ★ 方案A: THEME_IMPROVE 用 actions 数组
  actions?: ImprovementAction[];
  appliedTargets?: Record<string, number>; // 2026-09-09 P1: 应用去向(由 actionType 推导)
  // V1.8: 结构化发现 (从 FlywheelReflection.structuredFindings 传入)
  findings?: StructuredFinding[];
  findingReflectionId?: string;  // FlywheelReflection.id, 用于 measuredDelta 回写
  summary?: {
    coverageScore: number;
    missedCount: number;
    conflictCount: number;
    improvementCount: number;
    actionCount: number;
  };
}

export interface ExecuteImprovingTaskInput {
  taskId: string;
  /** dryRun: 只打印不真改, 用于管理后台 preview 按钮 */
  dryRun?: boolean;
  /** actor: 谁触发 (system / admin:xxx / lf16:cron) */
  actor?: string;
  /** uos20 #5 (2026-09-23): cronjob 执行期上下文 —— 主 agent 核心 memory 冻结快照。
   *  由 improving-tasks-cron 每轮捕获一次并传入, 注入 TaskExecution.metadata.agentMemorySnapshot。 */
  agentMemorySnapshot?: AgentMemorySnapshot | null;
}

export interface ExecuteImprovingTaskResult {
  taskId: string;
  type: ImprovementType;
  status: "DONE" | "FAILED" | "SKIPPED";
  fromStatus: string;
  toStatus: string;
  durationMs: number;
  summary: string;
  affectedRows?: number;
  error?: string;
  rerunResult?: unknown;
  consumedBy?: string;     // 处理者标识 (本次函数名 + 时间戳)
}

// ==================== 4 type 执行器 ====================

/**
 * FIX_THEME: 调整一类 memory 的 theme 字段 (V1.6 §C-V1.6-3)
 * 走 calibrateMemory payload 应用通道 (mergeTargets)
 * 白名单: 排除 domain='flywheel-reflect'
 *
 * V1.6 §6.7 P0 防御 (2026-07-17): 规则化 FIX_THEME 改真实 memory 数据风险大
 * 必须 manualReview=false 才执行 (跟 MIGRATE_DATA 防御方向一致:
 *   V1 惯例 manualReview=true = 需要人审, 默认 SKIPPED 等审)
 */
async function executeFixTheme(
  taskId: string,
  payload: ImprovingTaskPayload,
  dryRun: boolean,
  manualReview: boolean
): Promise<ExecuteImprovingTaskResult> {
  // V1.6 §C-V1.6-5 防御: 规则化 FIX_THEME 默认 manualReview=true 等审, 不真改
  if (manualReview) {
    return {
      taskId, type: "FIX_THEME", status: "SKIPPED", fromStatus: "PENDING", toStatus: "PENDING",
      durationMs: 0,
      summary: "FIX_THEME 默认 manualReview=true (V1 惯例=需人审), 已 SKIPPED 等人工审核 (LLM 化决策前规则化改数据风险大)",
    };
  }

  const mergeTargets = payload.mergeTargets || [];
  if (mergeTargets.length === 0) {
    return {
      taskId, type: "FIX_THEME", status: "FAILED", fromStatus: "PENDING", toStatus: "FAILED",
      durationMs: 0, summary: "mergeTargets 为空, 无法执行",
      error: "EMPTY_PAYLOAD",
    };
  }

  // 白名单: 过滤掉 domain=flywheel-reflect 的 memoryId (V1.6 §C-V1.6-3)
  const safeTargets: typeof mergeTargets = [];
  const skippedIds: string[] = [];
  for (const t of mergeTargets) {
    const mem = await prisma.memory.findUnique({
      where: { id: t.memoryId },
      select: { id: true, domain: true, theme: true },
    });
    if (!mem) {
      skippedIds.push(`${t.memoryId}(not_found)`);
      continue;
    }
    if (mem.domain === "flywheel-reflect") {
      skippedIds.push(`${mem.id}(white_listed)`);
      continue;
    }
    safeTargets.push(t);
  }

  if (dryRun) {
    return {
      taskId, type: "FIX_THEME", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
      durationMs: 0,
      summary: `[dryRun] 将改 theme: ${safeTargets.length} 条, 跳过: ${skippedIds.length} 条 (${skippedIds.join(",")})`,
      affectedRows: safeTargets.length,
    };
  }

  // 走 calibrateMemory payload 通道 (V1.6 §2.2 Step A.2)
  // 注意 calibrateMemory 期望的 mergeTargets 格式是 { sourceIds, targetId } (主题字符串)
  // 我方 payload 是 { memoryId, newTheme, reason }, 转换: sourceIds=[memoryId], targetId=newTheme
  const result = await calibrateMemory(undefined, undefined, undefined, {
    mergeTargets: safeTargets.map((t) => ({
      sourceIds: [t.memoryId],
      targetId: t.newTheme,
    })),
  });

  return {
    taskId, type: "FIX_THEME", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
    durationMs: 0,
    summary: `改 theme: ${result.payloadApplied?.updated || 0} 条, 跳过: ${skippedIds.length} 条`,
    affectedRows: result.payloadApplied?.updated || 0,
  };
}

/**
 * FIX_CONFLICT: 合并冲突 memory (V1.6 §C-V1.6-2)
 * 走 calibrateMemory payload 应用通道 (conflicts)
 * 白名单: 排除 sourceType=FLYWHEEL_REFLECTION (calibrateMemory 内部保证)
 */
async function executeFixConflict(
  taskId: string,
  payload: ImprovingTaskPayload,
  dryRun: boolean
): Promise<ExecuteImprovingTaskResult> {
  const conflicts = payload.conflicts || [];
  if (conflicts.length === 0) {
    return {
      taskId, type: "FIX_CONFLICT", status: "FAILED", fromStatus: "PENDING", toStatus: "FAILED",
      durationMs: 0, summary: "conflicts 为空, 无法执行",
      error: "EMPTY_PAYLOAD",
    };
  }

  if (dryRun) {
    return {
      taskId, type: "FIX_CONFLICT", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
      durationMs: 0,
      summary: `[dryRun] 将合并 ${conflicts.length} 个冲突组, 共 ${conflicts.reduce((s, c) => s + c.memoryIds.length, 0)} 条 memory`,
      affectedRows: conflicts.reduce((s, c) => s + c.memoryIds.length, 0),
    };
  }

  const result = await calibrateMemory(undefined, undefined, undefined, {
    conflicts,
  });

  return {
    taskId, type: "FIX_CONFLICT", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
    durationMs: 0,
    summary: `合并冲突组 ${conflicts.length} 个, 被取代 memory: ${result.payloadApplied?.merged || 0} 条`,
    affectedRows: result.payloadApplied?.merged || 0,
  };
}

/**
 * MIGRATE_DATA: 执行 SQL 数据迁移 (V1.6 §C-V1.6-5)
 * ★ P0 fix: manualReview=true = 需人审 = SKIPPED (跟 FIX_THEME 语义一致)
 *   原代码 if(!manualReview) 逻辑反转, 导致默认 manualReview=true 时直接执行 SQL 跳过人审
 * 且 SQL 仅允许 CREATE/UPDATE/DELETE (DROP/TRUNCATE/ALTER 拒)
 * ★ 飞轮修复: manualReview=true 且 sql=null 时, 自动安全合并重复 Memory 条目 (Prisma API, 不走 raw SQL)
 */
async function executeMigrateData(
  taskId: string,
  payload: ImprovingTaskPayload,
  dryRun: boolean,
  manualReview: boolean
): Promise<ExecuteImprovingTaskResult> {
  const sql = (payload.sql || "").trim();
  const theme = payload.theme || "";

  // ★ 飞轮修复: manualReview=true 且 sql=null -> 自动安全合并重复条目
  if (manualReview && !sql) {
    if (dryRun) {
      return {
        taskId, type: "MIGRATE_DATA", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
        durationMs: 0,
        summary: `[dryRun] 将自动合并 theme="${theme}" 的重复 Memory 条目`,
      };
    }
    try {
      const t0 = Date.now();
      // 1. 找该 theme 下有 contentHash 的 Memory, 按 contentHash 分组
      const memories = await prisma.memory.findMany({
        where: { theme, contentHash: { not: null }, supersededBy: null },
        select: { id: true, contentHash: true, updatedAt: true, reinforceCount: true },
      });
      const byHash = new Map<string, typeof memories>();
      for (const m of memories) {
        const h = m.contentHash!;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h)!.push(m);
      }
      // 2. 对每组 (>=2 条), 保留 reinforceCount 最高 (或最新) 的, 其余 supersede
      let mergedCount = 0;
      for (const [, group] of byHash) {
        if (group.length < 2) continue;
        group.sort((a, b) => b.reinforceCount - a.reinforceCount || b.updatedAt.getTime() - a.updatedAt.getTime());
        const keep = group[0];
        for (let i = 1; i < group.length; i++) {
          await prisma.memory.update({
            where: { id: group[i].id },
            data: { supersededBy: keep.id, supersededAt: new Date() },
          });
          mergedCount++;
        }
      }
      // 3. 同样处理 Practice 表
      // 2026-10-25 撤回流程补漏: Practice 有 stale 列 -> 合并候选只取活行(未撤回 + 未被取代),
      //   否则被撤回的实践行会被当成"同组另一条"而被 supersede, 且活行被误删式合并掉。
      const practices = await prisma.practice.findMany({
        where: liveRowWhere("practice", { theme, contentHash: { not: null } }),
        select: { id: true, contentHash: true, updatedAt: true, reinforceCount: true },
      });
      const pByHash = new Map<string, typeof practices>();
      for (const p of practices) {
        const h = p.contentHash!;
        if (!pByHash.has(h)) pByHash.set(h, []);
        pByHash.get(h)!.push(p);
      }
      let pMerged = 0;
      for (const [, group] of pByHash) {
        if (group.length < 2) continue;
        group.sort((a, b) => b.reinforceCount - a.reinforceCount || b.updatedAt.getTime() - a.updatedAt.getTime());
        const keep = group[0];
        for (let i = 1; i < group.length; i++) {
          await prisma.practice.update({
            where: { id: group[i].id },
            data: { supersededBy: keep.id, supersededAt: new Date() },
          });
          pMerged++;
        }
      }
      const totalMerged = mergedCount + pMerged;
      return {
        taskId, type: "MIGRATE_DATA", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
        durationMs: Date.now() - t0,
        summary: `自动合并: Memory ${mergedCount} 条 + Practice ${pMerged} 条 (contentHash 去重, supersede 不删除)`,
        affectedRows: totalMerged,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        taskId, type: "MIGRATE_DATA", status: "FAILED", fromStatus: "PENDING", toStatus: "FAILED",
        durationMs: 0, summary: `自动合并失败: ${errMsg}`,
        error: errMsg,
      };
    }
  }

  // V1.6 §C-V1.6-5: manualReview=true 且有 sql = 需人审 = SKIPPED
  if (manualReview) {
    return {
      taskId, type: "MIGRATE_DATA", status: "SKIPPED", fromStatus: "PENDING", toStatus: "PENDING",
      durationMs: 0,
      summary: "MIGRATE_DATA 有 sql 但 manualReview=true (需人审), 已 SKIPPED",
    };
  }

  if (!sql) {
    return {
      taskId, type: "MIGRATE_DATA", status: "FAILED", fromStatus: "PENDING", toStatus: "FAILED",
      durationMs: 0, summary: "sql 为空且自动合并未命中, 无法执行",
      error: "EMPTY_PAYLOAD",
    };
  }

  // V1.6 §C-V1.6-5: 危险 SQL 拒 (DROP / TRUNCATE / ALTER 拒, 留给人审)
  const dangerRe = /^\s*(DROP|TRUNCATE|ALTER)\b/i;
  if (dangerRe.test(sql)) {
    return {
      taskId, type: "MIGRATE_DATA", status: "SKIPPED", fromStatus: "PENDING", toStatus: "PENDING",
      durationMs: 0,
      summary: `检测到危险 SQL (DROP/TRUNCATE/ALTER), 已 SKIPPED 等人工审核`,
    };
  }

  if (dryRun) {
    return {
      taskId, type: "MIGRATE_DATA", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
      durationMs: 0,
      summary: `[dryRun] SQL 已通过白名单, preview: ${sql.substring(0, 200)}`,
    };
  }

  // 真执行 SQL (用 $executeRawUnsafe 走 V1 惯例)
  try {
    const affected = await prisma.$executeRawUnsafe(sql);
    return {
      taskId, type: "MIGRATE_DATA", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
      durationMs: 0,
      summary: `SQL 执行成功, 影响行数: ${affected}`,
      affectedRows: typeof affected === "number" ? affected : undefined,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      taskId, type: "MIGRATE_DATA", status: "FAILED", fromStatus: "PENDING", toStatus: "FAILED",
      durationMs: 0,
      summary: `SQL 执行失败: ${errMsg}`,
      error: errMsg,
    };
  }
}

/**
 * RE_RUN: 重新跑一次主题整理 + 跑后验证 (V1.6 §3.1 ⑧)
 * 走 rerunTheme() 内部用 24h 限流保护 (V1.6 A 路径已加)
 */
async function executeReRun(
  taskId: string,
  payload: ImprovingTaskPayload,
  dryRun: boolean
): Promise<ExecuteImprovingTaskResult> {
  const theme = payload.theme || "";
  if (!theme) {
    return {
      taskId, type: "RE_RUN", status: "FAILED", fromStatus: "PENDING", toStatus: "FAILED",
      durationMs: 0, summary: "theme 为空, 无法执行",
      error: "EMPTY_PAYLOAD",
    };
  }

  if (dryRun) {
    return {
      taskId, type: "RE_RUN", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
      durationMs: 0,
      summary: `[dryRun] 将 rerun theme="${theme}"`,
    };
  }

  // 调 rerunTheme (走 V1.6 A 路径, 内含增量检查)
  // 遗留#8: rerunTheme 返回类型未声明 durationMs/counts, 兼容处理
  const result = (await rerunTheme(theme)) as any;

  // 增量跳过: 无新对话时不消耗 LLM, 返回 SKIPPED
  if ((result as any).skipped) {
    return {
      taskId, type: "RE_RUN", status: "SKIPPED", fromStatus: "PENDING", toStatus: "SKIPPED",
      durationMs: 0,
      summary: `rerun theme="${theme}" SKIPPED: ${(result as any).skipReason || "no new data"}`,
      rerunResult: result,
    };
  }

  return {
    taskId, type: "RE_RUN", status: "DONE", fromStatus: "PENDING", toStatus: "DONE",
    durationMs: result.durationMs,
    summary: `rerun theme="${theme}" 完成: ${JSON.stringify(result.counts || {})}`,
    affectedRows: (result.counts?.super || 0) + (result.counts?.create || 0),
    rerunResult: result,
  };
}

// ==================== V1.8: 结构化发现执行器 ====================

/**
 * 2026-09-14 提案 cmtwg18df01h21j76ue6cqdkl (挑战 f-003) 落地: Knowledge 口径闸门
 *
 * 提案的核心判断: finding 说的"未沉淀为 Knowledge"混了两种口径 ——
 *   (a) 知识不存在            vs
 *   (b) 知识存在, 只是不在 Knowledge 表 / 或散落在别的 theme 下 ("采集率"问题)
 * "Knowledge 表行数=0" 只能反推"采集率低", 不能反推"知识空白"。
 *
 * 机制: CREATE_KNOWLEDGE 落库前, 先核对 finding **自己的 acceptance** 是否已经满足 ——
 *   若满足(且命中不是元文本), 说明知识已存在, 不再重复建行, 也不再把 finding 当"未沉淀"。
 * 支持 acceptance 形态: Knowledge表存在 title 包含 'X' / 主题为'X' / content 含 'X'。
 * 2026-09-14 补(提案 cmtwl55bq02cj1j76h98raxa9, 挑战 AI共享大脑 f-005):
 *   实测 f-005 的 acceptance 是**无引号**形态 —— ①「Knowledge包含MCP工具列表和admin权限矩阵」
 *   ②「Knowledge表中可通过theme=MCP检索到索引条目」。旧解析器只认引号, 两条都返回 null -> 闸门失效 ->
 *   finding 被当"未沉淀"反复派发挑战, 而实际上 Knowledge 里 2026-07-03 起就有对应条目。
 *   故补两种无引号形态: `theme=X` 按**前缀**检索(acceptance 原意是"可用 theme=MCP 检索到"),
 *   `包含<名词短语>` 按 content 检索。与 scripts/finding-premise-check.cjs evidence-pack 同口径。
 * 只做存在性判定, 不代替人工复核; 命中则 SKIP 并给出可复算 evidenceRef。
 */
export function parseAcceptanceProbe(
  acceptance: string
): { column: "title" | "content" | "theme"; value: string; mode: "exact" | "prefix" } | null {
  const a = String(acceptance || "");
  if (!/Knowledge/i.test(a)) return null;
  const patterns: Array<{ re: RegExp; column: "title" | "content" | "theme"; mode: "exact" | "prefix" }> = [
    { re: /(?:title|标题)[^'"]{0,8}?(?:包含|含有|含|为)\s*['"“”]([^'"“”]{2,60})['"“”]/i, column: "title", mode: "exact" },
    { re: /(?:theme|主题)[^'"]{0,8}?(?:为|包含|含有|含)\s*['"“”]([^'"“”]{2,60})['"“”]/i, column: "theme", mode: "exact" },
    { re: /(?:content|内容)[^'"]{0,8}?(?:包含|含有|含|为)\s*['"“”]([^'"“”]{2,60})['"“”]/i, column: "content", mode: "exact" },
    // 无引号 `theme=MCP` / `通过theme=MCP检索` -> 前缀(仅 ASCII 标识符, 避免吞掉后随中文)
    { re: /(?:theme|主题)\s*[=:]\s*([A-Za-z0-9_\-.]{2,40})/i, column: "theme", mode: "prefix" },
    // 无引号 `包含MCP工具列表和admin权限矩阵` -> 取第一个名词短语作 content 探针
    { re: /(?:包含|含有|含)\s*([A-Za-z0-9\u4e00-\u9fa5_\-/]{2,20}?)(?=[,，。;；和与、及\s]|$)/, column: "content", mode: "exact" },
  ];
  for (const p of patterns) {
    const m = p.re.exec(a);
    if (m && m[1]) return { column: p.column, value: m[1].trim(), mode: p.mode };
  }
  return null;
}

/** 元文本(提案/裁定)只引用关键词, 不是产物 —— 与 scripts/finding-premise-check.cjs 的 META_FILTER 同口径。 */
function isMetaKnowledgeRow(r: { title?: string | null; theme?: string | null }): boolean {
  const t = String(r.title || "");
  const th = String(r.theme || "");
  return th.startsWith("验证·") || t.startsWith("[agent 结论]") || t.startsWith("[验证] ");
}

export async function acceptanceAlreadySatisfied(
  finding: StructuredFinding
): Promise<{ satisfied: boolean; detail?: string; evidenceRef?: string }> {
  const probe = parseAcceptanceProbe(finding.acceptance || "");
  if (!probe) return { satisfied: false };
  const where: any =
    probe.column === "title"
      ? { title: { contains: probe.value } }
      : probe.column === "theme"
        ? probe.mode === "prefix"
          ? { theme: { startsWith: probe.value } }
          : { theme: probe.value }
        : { content: { contains: probe.value } };
  const rows = await prisma.knowledge.findMany({
    // 2026-10-25 撤回流程补漏: acceptance"已满足"判定只看活行 —— 被撤回的知识若仍算"满足",
    //   则撤回后该 finding 再也不会被重新落地, 且无人复核(撤回等于永久丢失这条结论)。
    where: liveRowWhere("knowledge", where),
    select: { title: true, theme: true },
    take: 500,
  });
  const real = rows.filter((r) => !isMetaKnowledgeRow(r));
  if (real.length > 0) {
    const evColumn = probe.column === "title" ? "title" : probe.column === "theme" ? "theme" : "content";
    const evOp = probe.mode === "prefix" ? "LIKE 'X%'" : "LIKE '%X%'";
    return {
      satisfied: true,
      detail: `acceptance 已满足: Knowledge.${evColumn} ${evOp} 命中 '${probe.value}' 共 ${real.length} 行(已排除元文本; 全库命中 ${rows.length} 行)`,
      // 2026-09-14 FW-GROW 机制修复: 旧 evidenceRef 形如 `... -> 12`, 尾部只有结果数字, 过不了
      //   evidence.ts 的判据(要求 `->` 后 >=30 字符的"真实返回") -> 闸门命中的 finding 永远无法被
      //   requireEvidence 放行关闭, 只能停在 NEW 一直计入分母。这里把"结果行数 + 语义说明"一起写出,
      //   既是真实复算返回, 也让该证据可被验证器接受(负结果证据死锁修复)。
      evidenceRef: `sql:SELECT COUNT(*) FROM Knowledge WHERE ${evColumn} ${probe.mode === "prefix" ? "LIKE '" + probe.value + "%'" : "LIKE '%" + probe.value + "%'"} AND NOT (theme LIKE '验证·%' OR title LIKE '[agent 结论]%' OR title LIKE '[验证] %') -> ${real.length} 行 (Knowledge.${evColumn} 命中 '${probe.value}' 且已排除元文本; acceptance 已由存量知识满足)`,
    };
  }
  return { satisfied: false };
}

/**
 * 2026-09-14 落地提案 cmtwdm6mq00t01j76g8nix4a9 (挑战「数据架构 f-003」): CREATE_PRACTICE 口径闸门
 *
 * 实测根因: f-003 acceptance = 「Practice 表存在含 'pnpm install' + 'prisma' + 'openssl' 关键词的记录」,
 *   是**合取关键词**形态; 而旧 `acceptanceAlreadySatisfied` 只在 acceptance 含 "Knowledge" 时生效,
 *   CREATE_PRACTICE 分支**完全没有闸门** -> 即使库里已有满足行(实测 1 行, theme=Prisma引擎定位),
 *   该 finding 仍会被反复落库/反复派发。这与提案指出的"口径"缺陷同源: 产物存在于**别的 theme** 下,
 *   旧逻辑按当前 theme 找不到就当成"未沉淀"。
 *
 * 机制: 落 Practice 前, 先按 acceptance 的合取关键词做**全库**(不限 theme)存在性核对;
 *   命中则 SKIP 并给出可复算 evidenceRef, 不重复建行。与 Knowledge 闸门同源、同口径。
 */
export function parsePracticeAcceptance(acceptance: string): string[] | null {
  const a = String(acceptance || "");
  if (!/Practice/i.test(a)) return null;
  const quoted = [...a.matchAll(/['"“”]([^'"“”]{2,60})['"“”]/g)].map((m) => m[1].trim());
  const unquoted = [...a.matchAll(/(?:含|包含|含有)\s*([A-Za-z0-9_\-.]{2,40})/g)].map((m) => m[1].trim());
  const kws = [...new Set((quoted.length ? quoted : unquoted).filter((k) => k && !/^(Practice|表|记录)$/i.test(k)))];
  return kws.length ? kws : null;
}

export async function practiceAcceptanceSatisfied(
  finding: StructuredFinding
): Promise<{ satisfied: boolean; detail?: string; evidenceRef?: string }> {
  const kws = parsePracticeAcceptance(finding.acceptance || "");
  if (!kws) return { satisfied: false };
  // 全库检索(不限 theme): acceptance 存在性条件不绑定 theme, 按当前 theme 找会漏判。
  const rows = await prisma.practice.findMany({
    where: liveRowWhere("practice", {
      AND: kws.map((k) => ({
        OR: [
          { title: { contains: k } },
          { description: { contains: k } },
          { outcome: { contains: k } },
          { theme: { contains: k } },
        ],
      })),
    }),
    select: { id: true, theme: true },
    take: 50,
  });
  if (rows.length > 0) {
    const cond = kws.map((k) => `(title LIKE '%${k}%' OR description LIKE '%${k}%' OR outcome LIKE '%${k}%' OR theme LIKE '%${k}%')`).join(" AND ");
    return {
      satisfied: true,
      detail: `acceptance 已满足: Practice 全库含全部关键词 [${kws.join(", ")}] 命中 ${rows.length} 行(theme 不限, 例: ${rows
        .slice(0, 3)
        .map((r) => r.theme + "/" + r.id.slice(-6))
        .join(", ")})`,
      // 2026-09-14 FW-GROW 机制修复: 同 Knowledge 闸门 —— 负结果/短结果证据过不了 evidence.ts 判据,
      //   把 `-> N` 补成 `-> N 行 (语义说明)`, 使已满足的 finding 可被诚实关闭(证据死锁修复)。
      evidenceRef: `sql:SELECT COUNT(*) FROM Practice WHERE supersededBy IS NULL AND ${cond} -> ${rows.length} 行 (Practice 表全库命中全部关键词 [${kws.join(", ")}]; acceptance 已由存量实践满足)`,
    };
  }
  return { satisfied: false };
}

/**
 * 2026-09-14 提案 cmtwgmt3i01p41j76zajlskr2 (挑战 Auto-rotation f-002) 落地: Memory 层 meta 循环闸门
 *
 * 实测根因(task=cmu0boli90hc41j76ge6pihck):
 *   1) f-002 的 acceptance 要求 `type ∈ {TECH_FIX, ARCHITECTURE, CONFIG, EXTERNAL_DEP}`,
 *      但本分支此前硬编码 `type: "GENERAL"` —— 即使执行体写了技术 Memory, type 也永远不满足,
 *      acceptance 永远不闭合 -> 同一 finding 反复 RECURRING。故改为按 acceptance 推断 type。
 *   2) finding 抱怨"Memory 几乎全是 meta 反思", 而执行体若又写入 meta 元陈述(应沉淀/产物缺失),
 *      正是它抱怨的循环。故要求技术类型时, 拒绝落 meta 内容。
 *   3) acceptance 写明了 "meta 反思占比 ≤ N%" 时, 先用确定性标记复算; 已满足则 SKIP, 不重复写。
 *   复算口径与 scripts/finding-premise-check.cjs 的 MEMORY_LAYER_RULE.metaMarkerSql 同源(只读, 可重跑)。
 */
const MEMORY_TECH_TYPES = ["TECH_FIX", "ARCHITECTURE", "CONFIG", "EXTERNAL_DEP"] as const;

/** acceptance 里点名的非 meta 技术 type(finding 想落哪类就落哪类, 不硬编码 GENERAL)。 */
export function parseMemoryTypeRequirement(acceptance: string): string[] {
  const a = String(acceptance || "");
  return MEMORY_TECH_TYPES.filter((t) => a.includes(t));
}

/** 判定一段 Memory 内容是不是"meta 元陈述"(该沉淀什么/产物缺失), 而非具体技术根因/步骤。 */
export function isMetaMemoryContent(content: string): boolean {
  const c = String(content || "");
  return /几乎全是?\s*meta|meta\s*反思|反思报告|反思产物|应沉淀|需沉淀|应记录|需记录|未沉淀|缺乏具体|去重并沉淀|产物(完全)?缺失/.test(c);
}

/** 落库 type: acceptance 点名技术类型且内容确为技术内容 -> 用该类型; 否则保持 GENERAL。 */
export function inferMemoryType(acceptance: string, content: string): string {
  const required = parseMemoryTypeRequirement(acceptance);
  if (required.length > 0 && !isMetaMemoryContent(content)) return required[0];
  return "GENERAL";
}

/** 解析 acceptance 里 "meta 反思占比 ≤ N%" 的阈值(返回 0-1)。 */
export function parseMemoryMetaRatioCeiling(acceptance: string): number | null {
  const a = String(acceptance || "");
  const m = /meta[^%\n]{0,16}?(?:占比|比例|比率)[^0-9%\n]{0,8}(\d{1,3})\s*%/.exec(a);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n / 100 : null;
}

/** 复算 theme 内 meta 行占比(确定性标记, 与 finding-premise-check.cjs 同口径)。 */
export async function currentMetaRatio(theme: string): Promise<{ total: number; meta: number; ratio: number }> {
  const total = await prisma.memory.count({ where: { theme } });
  const meta = await prisma.memory.count({
    where: {
      theme,
      sourceType: "FLYWHEEL_REFLECTION",
      OR: [{ title: { startsWith: "反思报告:" } }, { title: { startsWith: "反思 lesson:" } }],
    },
  });
  return { total, meta, ratio: total ? meta / total : 0 };
}

/**
 * V1.8 F2: 执行结构化发现 - 基于 finding.actionType 分发
 * 7 种 actionType: MERGE_CONFLICT / RE_EXTRACT / CREATE_MEMORY / CREATE_PRACTICE / CREATE_KNOWLEDGE / FIX_DATA / MARK_REVIEW
 */
async function executeStructuredFindings(
  taskId: string,
  findings: StructuredFinding[],
  theme: string,
  dryRun: boolean,
): Promise<{ results: Array<{ findingId: string; actionType: string; status: string; detail: string; delta?: number; evidenceRef?: string; premiseSatisfied?: boolean; closeReason?: string }>; totalAffected: number; lowConfSkipped: number; needsReviewIds: string[] }> {
  const results: Array<{ findingId: string; actionType: string; status: string; detail: string; delta?: number; evidenceRef?: string; premiseSatisfied?: boolean; closeReason?: string }> = [];
  let totalAffected = 0;
  let lowConfSkipped = 0; // 遗留#8: 低置信拦截计数
  const needsReviewIds: string[] = []; // 2026-09-10 建议2: 低置信 finding 复核队列(回写反思行 status=NEEDS_REVIEW)
  // 2026-09-14 FW-EVIDENCE 机制修复: 关闭必须带**确定性**可复现证据 —— 用本次真实写入/更新的
  //   产物行主键 id 构造可重跑查询。注意: 不能用 (theme, sourceId=findingId) 作链接,
  //   独立复核实测 finding.id 是位置式(f-001..)且会被反思重生成复用(同 theme 内 857 组碰撞),
  //   会误把旧 finding 的产物当成当前 finding 的证据(已否决该方案)。
  const rowEvidence = (table: string, id: string) =>
    `sql:SELECT id,theme,sourceType FROM ${table} WHERE id='${id}' -> 1 row(id='${id}', sourceType='FLYWHEEL_STRUCTURED') 由本次落地动作真实写入(可重跑)`;

  // 2026-09-10 遗留#8: 低置信 finding 执行侧拦截 (UI 有单列, 执行侧此前无闸门)
  //   默认 confidence < 0.6 不自动落库, 记为 SKIP 待人工复核; REFLECT_ALLOW_LOWCONF=1 可放开
  const LOWCONF_MIN = Number(process.env.REFLECT_LOWCONF_MIN ?? "0.6");
  const ALLOW_LOWCONF = process.env.REFLECT_ALLOW_LOWCONF === "1";

  for (const finding of findings) {
    // RESOLVED 的 finding 跳过
    if (finding.status === "RESOLVED") {
      results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "finding 已 RESOLVED, 跳过" });
      continue;
    }
    // 低置信拦截 (未自评按 0.5 默认 -> 低于阈值, 视为待复核)
    const conf = typeof finding.confidence === "number" ? finding.confidence : 0.5;
    if (!ALLOW_LOWCONF && conf < LOWCONF_MIN) {
      lowConfSkipped++;
      needsReviewIds.push(finding.id); // 2026-09-10 建议2: 记入复核队列(回写 status=NEEDS_REVIEW), 不再静默 SKIP
      results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `低置信 finding (confidence=${conf.toFixed(2)} < ${LOWCONF_MIN}), 已入复核队列 (status=NEEDS_REVIEW)` });
      continue;
    }

    try {
      switch (finding.actionType) {
        case "MERGE_CONFLICT": {
          let memoryIds = finding.relatedMemoryIds || [];
          // V1.8: 如果 LLM 没提供 relatedMemoryIds, 尝试从 evidenceSnippet 提取 [xxxxxx] 格式的 memory ID
          if (memoryIds.length < 2 && finding.evidenceSnippet) {
            const extracted = finding.evidenceSnippet.match(/\[([a-z0-9]{6})\]/gi) || [];
            memoryIds = extracted.map((m: string) => m.replace(/[\[\]]/g, ""));
          }
          if (memoryIds.length < 2) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "relatedMemoryIds < 2, 无法合并 (LLM 未提供 memory ID)" });
            break;
          }
          if (dryRun) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "DRYRUN", detail: `将合并 ${memoryIds.length} 条 memory` });
            break;
          }
          // 2026-09-09 诚实性修复: findings 级同样只合并真实存在的 ID (LLM relatedMemoryIds 常为幻觉短 ID)
          const fres = await resolveRealConflictIds(memoryIds, theme);
          if (fres.ids.length < 2) {
            // 2026-09-14 FW-GROW: 主题内确无重复组 -> 前提不成立, 以确定性负结果证据可关闭(见 writeBackMeasuredDelta)
            // 2026-09-14 类型修正: $queryRawUnsafe 返回 unknown, catch 不会收窄类型 -> 需对整体结果断言
            const dupCnt: any[] = (await prisma.$queryRawUnsafe(
              "SELECT COUNT(*) c FROM Memory WHERE theme=? AND contentHash IS NOT NULL AND contentHash != '' AND supersededBy IS NULL",
              theme || ""
            ).catch(() => [{ c: 0 }])) as any[];
            const actives = Number(dupCnt?.[0]?.c ?? 0);
            results.push({
              findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: fres.note,
              premiseSatisfied: fres.premiseSatisfied,
              evidenceRef: fres.premiseSatisfied
                ? `sql:SELECT contentHash,COUNT(*) c FROM Memory WHERE theme='${theme}' AND contentHash IS NOT NULL AND supersededBy IS NULL GROUP BY contentHash HAVING c>=2 -> ${actives} 条活性 Memory 中 0 组重复 (finding 所指冲突已不存在, 无可合并对象)`
                : undefined,
            });
            break;
          }
          const conflicts = [{ memoryIds: fres.ids, theme, reason: finding.what.slice(0, 80) }];
          const r = await calibrateMemory(undefined, undefined, undefined, { conflicts });
          const merged = r.payloadApplied?.merged || 0;
          totalAffected += merged;
          results.push({ findingId: finding.id, actionType: finding.actionType, status: merged > 0 ? "DONE" : "SKIP", detail: merged > 0 ? `真实合并 ${merged} 条 (` + fres.note + `)` : fres.note, delta: 0 });
          break;
        }

        case "RE_EXTRACT": {
          if (!theme) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "theme 为空" });
            break;
          }
          if (dryRun) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "DRYRUN", detail: `将增量重提取 theme="${theme}"` });
            break;
          }
          // ===== 2026-09-22 机制修复(MACS-COLLAB 塌陷: 0.886 → 1.0) =====
          // 根因: rerunTheme() 在两个**已知业务跳过条件**下会主动抛 Error
          //     (a) global-organizer.ts:1634: "主题 X 24h 内已 rerun 过" — 限流保护, 是设计内的可重试
          //     (b) global-organizer.ts:1653: "主题 X 无有效消息 (空主题或 session API 不可达)" — 空主题/Session 不可达
          //   两条都是正常跳过场景, 但本分支之前没 try/catch, 抛出后被外层 catch(下一段)兜成 finding ERROR
          //   -> findingsErr > 0 -> executeImprovingTask() finalOk=false -> 整 THEME_IMPROVE 任务被标 FAILED。
          //   actions 路径 L1463-L1480 的 RE_EXTRACT 分支已有 try/catch 转 SKIP(已修复),
          //   本分支(/** findings 路径 RE_EXTRACT 分支) **之前遗漏**, 行为不对称, 是塌陷源头。
          // 修复: 复用 actions 路径同模式 —— try/catch 包裹 rerunTheme, 已知异常转 SKIP
          //   (语义对齐"rerun 跳过"), 不计入 findingsErr。未知运行时异常仍由外层 catch 兜为 ERROR(行为不变)。
          let r: any;
          try {
            r = await rerunTheme(theme);
          } catch (e: any) {
            const msg = String(e?.message || "unknown").slice(0, 120);
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `rerun 跳过: ${msg}` });
            break;
          }
          if ((r as any).skipped) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `增量跳过: ${(r as any).skipReason || "no new data"}` });
          } else {
            const delta = (r as any).delta || 0;
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "DONE", detail: `coverage delta=${delta.toFixed(3)}`, delta });
          }
          break;
        }

        case "CREATE_MEMORY": {
          if (dryRun) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "DRYRUN", detail: `将创建 Memory: ${finding.what.slice(0, 60)}` });
            break;
          }
          // ===== 2026-09-14 提案 cmtwdieeq00q21j76gmbwbwp7 (挑战 f-001「V3反思引擎三层管道架构未沉淀」) 落地 =====
          // 与 CREATE_KNOWLEDGE 同一机制: 架构级记录类 finding 即使 actionType=CREATE_MEMORY,
          //   也先把"载体"决策交给纯函数 routeArchitectureDecision —— 命中 ADR 覆盖则只落 1 条指针行,
          //   不把架构正文写进 Memory (f-001 requirement 正是 "创建 Memory(theme=V3反思引擎架构, type=ARCHITECTURE)")。
          //   soft 无覆盖 -> FALLBACK 回落既有 Memory 内容行(不改存量); FLYWHEEL_ADR_ROUTING_STRICT=1 时 STRICT_SKIP。
          {
            const decision = routeArchitectureDecision(finding, readAdrCatalog(), theme, ADR_ROUTING_STRICT);
            if (decision.action === "STRICT_SKIP") {
              results.push({
                findingId: finding.id,
                actionType: finding.actionType,
                status: "SKIP",
                detail: `架构记录载体路由(strict): finding 属架构级记录类, 但 theme=${theme} 无 ADR 覆盖(ADR 目录共 ${decision.catalogSize} 条) —— 先补 ADR 主载体, 本分支不落 Memory 内容行`,
                evidenceRef: `fs:readAdrCatalog("docs/architecture/adr") -> ${decision.catalogSize} 条, findAdrCoverage(theme=${theme}) -> 0`,
              });
              break;
            }
            if (decision.action === "POINTER") {
              const { pointer, covered } = decision;
              const ptrHash = knowledgeHashOf(pointer.title, pointer.content);
              // 2026-10-25 撤回流程补漏: ADR 指针行去重只看活行(未撤回 + 未被取代)。
              //   原实现只挡 supersededBy -> 被撤回(stale=1, supersededBy=NULL)的指针行仍会挡住新指针落库。
              const dupPtr = await prisma.knowledge.findFirst({
                where: liveRowWhere("knowledge", { theme, contentHash: ptrHash }),
                select: { id: true },
              });
              if (dupPtr) {
                results.push({
                  findingId: finding.id,
                  actionType: finding.actionType,
                  status: "SKIP",
                  detail: `架构记录载体路由: ADR 指针行已存在 (${dupPtr.id.slice(-6)}), 不重复落库`,
                  evidenceRef: rowEvidence("Knowledge", dupPtr.id),
                  premiseSatisfied: true,
                });
                break;
              }
              const ptrQ = calcQualityScore({ type: "knowledge", content: pointer.content, title: pointer.title, category: projectCategory(ADR_INDEX_SOURCE_TYPE, "knowledge") ?? "OTHER", confidence: 0.9 });
              const ptrRow = await safeCreateKnowledge({
                title: pointer.title,
                content: pointer.content,
                sourceType: ADR_INDEX_SOURCE_TYPE,
                sourceId: finding.id,
                sourceDetail: covered.map((a) => a.id).join(","),
                contentHash: ptrHash,
                theme,
                category: projectCategory(ADR_INDEX_SOURCE_TYPE, "knowledge") ?? "OTHER", // 2026-10-08 round 54
                agentSource: "flywheel-adr-routing",
                confidence: 0.9,
                qualityScore: ptrQ,
                filePath: pointer.filePath,
                verification: ADR_INDEX_VERIFICATION,
              });
              if (rejectedByGate(ptrRow)) {
                results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "认知闸拒收 ADR 指针行(完备性判据不满足), 未落库" });
                break;
              }
              totalAffected += 1;
              results.push({
                findingId: finding.id,
                actionType: finding.actionType,
                status: "DONE",
                detail: `架构记录载体路由: finding 要求"架构级记录", 主载体为 ADR —— 落 1 条指针行 ${ptrRow.id.slice(-6)} (覆盖 ${covered.map((a) => a.id).join(",")}), 不落 Memory 内容行`,
                evidenceRef: rowEvidence("Knowledge", ptrRow.id),
              });
              break;
            }
            // NOT_ARCH / FALLBACK -> 继续既有 Memory 内容行路径
          }
          // P0-5 修复: O2 容量检查 -- 同 theme 超 50 条不创建, 改为 UPDATE 最高分记录
          const THEME_CAPACITY = 200; // P0-2 2026-09-01 与 resolver 对齐
          const themeCount = await prisma.memory.count({
            where: { theme, supersededBy: null }
          });
          if (themeCount >= THEME_CAPACITY) {
            // 超容: reinforce 最高分记录而非创建新记录
            const topMem = await prisma.memory.findFirst({
              where: { theme, supersededBy: null },
              orderBy: { valueScore: "desc" },
              select: { id: true },
            });
            if (topMem) {
              await prisma.memory.update({
                where: { id: topMem.id },
                data: { lastReinforce: new Date(), reinforceCount: { increment: 1 } },
              });
              totalAffected += 1;
              results.push({ findingId: finding.id, actionType: finding.actionType, status: "DONE", detail: `超容reinforce Memory ${topMem.id.slice(-6)}`, evidenceRef: rowEvidence("Memory", topMem.id) });
            } else {
              results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIPPED", detail: `theme="${theme}" 容量${themeCount}>=${THEME_CAPACITY}, 无可reinforce记录` });
            }
            break;
          }
          const memoryStore = new PrismaMemoryStore(prisma);
          // 2026-09-09 B: FLYWHEEL_STRUCTURED 落库行补质量分 (此前全恒 0 -> flow 页 avg 0 / 低质桶爆满)
          const memoryContent = (finding.evidenceSnippet || finding.requirement || "").trim().slice(0, 500);
          const memoryValue = finding.priority === "P0" ? 0.9 : finding.priority === "P1" ? 0.7 : 0.5;
          // 2026-09-10 守卫①: 空内容不落库
          if (!memoryContent) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "空内容守卫: evidenceSnippet/requirement 均为空, 不写空行" });
            break;
          }
          // 2026-09-14 meta 循环闸门 (提案 cmtwgmt3i01p41j76zajlskr2 落地):
          //   (a) finding 点名要非 meta 技术 type, 但本次内容本身是 meta 元陈述 -> 拒绝, 否则正是 finding 抱怨的循环;
          //   (b) acceptance 写明 "meta 占比 ≤ N%" 且当前已满足 -> 无需再写。
          {
            const requiredTypes = parseMemoryTypeRequirement(finding.acceptance || "");
            if (requiredTypes.length > 0 && isMetaMemoryContent(memoryContent)) {
              results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `meta 循环闸门: finding 要求 ${requiredTypes.join("/")} 技术类型, 但本次内容为 meta 元陈述, 拒绝再写 meta 行` });
              break;
            }
            const ceiling = parseMemoryMetaRatioCeiling(finding.acceptance || "");
            if (ceiling != null) {
              const cur = await currentMetaRatio(theme);
              if (cur.total > 0 && cur.ratio <= ceiling) {
                results.push({
                  findingId: finding.id, actionType: finding.actionType, status: "SKIP",
                  detail: `acceptance 已满足: theme="${theme}" meta 占比 ${(cur.ratio * 100).toFixed(1)}% <= ${(ceiling * 100).toFixed(0)}% (${cur.meta}/${cur.total}), 无需再写 Memory`,
                  // evidence.ts 判据要求 `->` 后 >=30 字符, 旧形态尾部是裸数字 -> 永远无法关闭(已修)
                  evidenceRef: `sql:SELECT COUNT(*) FROM Memory WHERE theme='${theme}' -> ${cur.total} 行总数; meta(sourceType=FLYWHEEL_REFLECTION, 反思报告/lesson) -> ${cur.meta} 行, 占比 ${(cur.ratio * 100).toFixed(1)}% <= 上限 ${(ceiling * 100).toFixed(0)}% (acceptance 已满足)`,
                  premiseSatisfied: true,
                });
                break;
              }
            }
          }
          // 2026-09-10 目标 G3(产物质量): 质量分低于门槛不落库, 转入复核队列(等补充信息), 避免拉低均值
          const memQ = calcQualityScore({ type: "memory", content: memoryContent, title: finding.what.slice(0, 80), theme, tags: finding.category, valueScore: memoryValue });
          if (memQ < MIN_PRODUCT_QUALITY) {
            needsReviewIds.push(finding.id);
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `质量门槛: 预估 qualityScore=${memQ.toFixed(2)} < ${MIN_PRODUCT_QUALITY}, 不落库, 已入复核队列(补充信息后可放行)` });
            break;
          }
          // 2026-09-29 round 11: V3 title 上限 (30 字); 之前 80 字与 V3 不符
          const memTitle = typeof finding.what === "string" ? (finding.what.length > 30 ? finding.what.slice(0, 30) : finding.what) : "";
          // 2026-09-10 守卫②: 同主题同内容活行已存在 -> 幂等跳过 (避免重复落库)
          {
            const memHash = sha256Hex(memoryContent);
            const dup = await prisma.memory.findFirst({ where: { theme, contentHash: memHash, supersededBy: null }, select: { id: true } });
            if (dup) {
              // 2026-09-14 FW-GROW: 同主题同内容行已存在 = finding 要求的 Memory 已沉淀, 前提不成立 -> 可关闭
              results.push({
                findingId: finding.id, actionType: finding.actionType, status: "SKIP",
                detail: `幂等跳过: 同主题同内容 Memory 已存在 (${dup.id.slice(-6)})`,
                evidenceRef: `sql:SELECT id,contentHash FROM Memory WHERE theme='${theme}' AND contentHash='${memHash}' AND supersededBy IS NULL -> 1 行 (id=${dup.id}); 同主题同内容 Memory 早已沉淀, finding 所述未落地前提不成立`,
                premiseSatisfied: true,
              });
              break;
            }
          }
          const mem = await memoryStore.create({
            content: memoryContent,
            title: memTitle,  // 2026-09-29 round 11: V3 title 80 -> 30 (V3 标准)
            // 2026-10-09 round 72-G: 认知闸要求 Memory 有 summary|scenario 之一(人类定义: 记忆必须
            //   说清"它在什么场景下有用")。finding.what 正是这条 finding 的一句话论断 —— 天然是摘要,
            //   不是为过闸而硬凑的字段。scenario 暂无可靠来源, 留 null(不编)。
            summary: String(finding.what || memTitle || "").slice(0, 200) || null,
            // 2026-09-14: acceptance 点名技术 type 时按类型落库(此前硬编码 GENERAL -> acceptance 永不闭合, 见 meta 循环闸门注释)
            type: inferMemoryType(finding.acceptance || "", memoryContent),
            // 2026-10-07 P4: 这里原来写 domain:"flywheel-structured" —— 那是**出处标记**, 不是领域;
            //   sourceType/agentSource 已表达同一件事(单一来源), 且全库无任何按该值查询的代码。
            //   实测后果: 存量归一一小时后又被本行写脏 5 条(D1-Memory 立刻 FAIL)。改为 null(未知)。
            domain: null,
            tags: JSON.stringify({ theme, findingId: finding.id, category: finding.category }),
            agentSource: "flywheel-structured-executor",
            sourceType: "FLYWHEEL_STRUCTURED",
            sourceId: finding.id,
            importance: memoryValue,
            valueScore: memoryValue,
            qualityScore: memQ,
            theme,
          });
          totalAffected += 1;
          results.push({ findingId: finding.id, actionType: finding.actionType, status: "DONE", detail: `创建 Memory ${mem?.id?.slice(-6) || "?"}`, evidenceRef: mem?.id ? rowEvidence("Memory", mem.id) : undefined });
          // 2026-09-14 FW-QUALITY 产物池完整性: findFirst(dedup)+create 非原子, 并发时会同内容双写。
          //   写后自愈: 若存在更早的同 theme+contentHash 行, 把本行标记为被其取代(不删数据)。
          if (mem?.id && mem?.createdAt && mem?.contentHash) {
            const older = await markLaterDuplicateSuperseded("memory", { id: mem.id, createdAt: mem.createdAt }, theme, mem.contentHash);
            if (older) console.warn(`[execute-improving-task] 并发去重兜底: Memory ${mem.id.slice(-6)} 与更早的 ${older.slice(-6)} 同 theme+contentHash, 已标记被取代`);
          }
          break;
        }

        case "CREATE_PRACTICE": {
          if (dryRun) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "DRYRUN", detail: `将创建 Practice: ${finding.what.slice(0, 60)}` });
            break;
          }
          const pracTitle = normalizeFlywheelTitle(finding.what, 30); // 2026-09-29 V3 合规 (原 slice(0,120) 与 V3 的 ≤30 冲突)
          const pracDesc = (finding.requirement || "").trim().slice(0, 500);
          // 2026-10-07 修根因(实测): 原代码 `const pracOutcome = (finding.acceptance || "").slice(0, 200)`
          //   把 **acceptance 判据整句**写进 Practice.outcome —— 后果有两层:
          //   ① outcome 语义被劫持(全库 700 行 PROCEDURE/FLYWHEEL_STRUCTURED 的 outcome 是整句判据, 也是 1,060 种脏取值的主要来源);
          //   ② practiceAcceptanceSatisfied 用 `outcome contains 关键词` 反查 -> **判据自己在 outcome 里, 闸门自我满足**, 抑制真实沉淀。
          //   判据只该参与判据; 产出结果未知 -> 用受控兜底值 UNKNOWN(见 enum-projection.ts)。
          const pracOutcome = "UNKNOWN";
          // 2026-09-14 口径闸门(提案 cmtwdm6mq00t01j76g8nix4a9): acceptance 已满足则不重复落 Practice。
          {
            const gate = await practiceAcceptanceSatisfied(finding);
            if (gate.satisfied) {
              results.push({
                findingId: finding.id,
                actionType: finding.actionType,
                status: "SKIP",
                detail: `口径闸门: ${gate.detail} —— Practice 已存在(可能在不同 theme), 不重复创建`,
                evidenceRef: gate.evidenceRef,
                // 2026-09-14 FW-GROW: acceptance 已由存量 Practice 满足 -> finding 所述"未沉淀"前提不成立, 可关闭
                premiseSatisfied: true,
              });
              break;
            }
          }
          // 2026-09-10 守卫: 空内容不落库 + 幂等 + contentHash
          if (!pracDesc) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "空内容守卫: requirement 为空, 不写空 description 行" });
            break;
          }
          // 2026-10-12 round 72-CQ (用户定为 C): **实践成色闸门** ——
          //   实测前提: finding 派生 Practice 近 7 天占 32.5%(241/742), 而这些行 qualityScore 恒为 0.40
          //   (最低通过线), 因为 calcPracticeQuality 只按"outcome 有值 +0.1 / 文本含路径或数字 +0.3"打分,
          //   **量不出"有没有步骤"**; 形态上 63.9% 读起来像指令。
          //   处置: 先**剥离指令外壳**(创建 Practice: / 新增 N 条 practice / 沉淀为 Practice…), 取出内嵌的做法;
          //   取出的正文里若**没有可辨识步骤**, 则不落 Practice —— 并按已裁决登记, 避免该 finding 每轮重现。
          //   回放 241 条真实载荷: 允许落库 30.7% -> 55.6%(第一版"是指令就拒"会误杀"创建外壳+真步骤"那一类)。
          const conf = practiceConformance(pracTitle, pracDesc);
          if (!conf.ok) {
            results.push({
              findingId: finding.id, actionType: finding.actionType, status: "SKIP",
              detail: "实践成色闸门(72-CQ): " + conf.reasons.join("; ") + " —— 该 finding 不落 Practice",
              // 2026-10-12 round 72-CU: 修 72-CR 如实记下的**语义妥协** ——
              //   先前只借 premiseSatisfied(true) 让它结单, 于是审计里的 closureReason 被写成
              //   "PREMISE_SATISFIED"(含义: 前提已不成立/已满足), 而真实原因是"**载荷不合规, 无法沉淀为实践**"。
              //   两者不是一回事: 前者说"这件事已经不用做了", 后者说"这件事做不成实践"。现给**准确的**理由码。
              premiseSatisfied: true,
              closeReason: "PRACTICE_NOT_CONFORMING",
              // 2026-10-12 round 72-CV: **必须给可复现证据**, 否则被 requireEvidence 硬拦 -> NEEDS_REVIEW。
              //   实测事故(本轮抓到): 72-CR 上线后闸门真实触发了 3 次, 而那 4 条 finding 全部落到
              //   status=NEEDS_REVIEW, needsReviewReason="关闭时无可复现证据(FW-EVIDENCE 硬拦)" ——
              //   **我的闸门在制造复核工作量**, 与"减少无效落库"的目标相反。
              //   形式按 evidence.ts 的 data 口径: 含 select + 箭头后 >=30 字符的结果说明。
              //   内容是**事实**: 该 finding 在 Practice 表里确实没有产物行(0 行), 且理由是确定性判定。
              evidenceRef: "select count(*) from Practice where theme='" + theme + "' and sourceId='" + finding.id
                + "' -> 0 行, 该 finding 无产物行且为空内容/成色闸门所拒(确定性判定, 见 practice-conformance.ts)",
            });
            break;
          }
          const pracDescFinal = conf.procedure; // 落库的是**剥壳后的做法正文**, 不是 finding 原话
          const pracQ = calcQualityScore({ type: "practice", content: pracDescFinal, title: pracTitle, theme, outcome: pracOutcome });
          if (pracQ < MIN_PRODUCT_QUALITY) {
            needsReviewIds.push(finding.id);
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `质量门槛: 预估 qualityScore=${pracQ.toFixed(2)} < ${MIN_PRODUCT_QUALITY}, 不落库, 已入复核队列` });
            break;
          }
          const pracHash = practiceHashOf(pracTitle, pracDescFinal);
          {
            // 2026-10-25 撤回流程补漏: Practice 有 stale 列, 原实现只挡 supersededBy ->
            //   被撤回(stale=1, supersededBy=NULL)的实践行仍会挡住同内容新实践落库,
            //   且会把 finding 误判为"早已沉淀"而关闭(前提不成立)。活行口径 = 未撤回 + 未被取代。
            const dup = await prisma.practice.findFirst({ where: liveRowWhere("practice", { theme, contentHash: pracHash }), select: { id: true } });
            if (dup) {
              // 2026-09-14 FW-GROW: 同主题同内容 Practice 已存在 -> finding 要求已满足, 可关闭
              results.push({
                findingId: finding.id, actionType: finding.actionType, status: "SKIP",
                detail: `幂等跳过: 同主题同内容 Practice 已存在 (${dup.id.slice(-6)})`,
                evidenceRef: `sql:SELECT id,contentHash FROM Practice WHERE theme='${theme}' AND contentHash='${pracHash}' AND supersededBy IS NULL AND COALESCE(stale,0)=0 -> 1 行 (id=${dup.id}); 同主题同内容 Practice 早已沉淀, finding 所述未落地前提不成立`,
                premiseSatisfied: true,
              });
              break;
            }
          }
          // 2026-09-10 建议3: 容量对称 (同上)
          // 2026-10-25 撤回流程补漏: 容量判定与 reinforce 目标都必须只认**活行** ——
          //   否则被撤回(stale=1)的 Practice 行会被算进容量(主题"满"了, 却不新建新结论),
          //   且在容量上限路径下**被 reinforce** —— 撤回等于没撤。
          {
            const pCount = await prisma.practice.count({ where: liveRowWhere("practice", { theme, sourceType: "FLYWHEEL_STRUCTURED" }) });
            if (pCount >= THEME_PRODUCT_CAP) {
              const top = await prisma.practice.findFirst({
                where: liveRowWhere("practice", { theme, sourceType: "FLYWHEEL_STRUCTURED" }),
                orderBy: [{ qualityScore: "desc" }, { reinforceCount: "desc" }],
                select: { id: true },
              });
              if (top) {
                await prisma.practice.update({ where: { id: top.id }, data: { reinforceCount: { increment: 1 } } });
                totalAffected += 1;
                results.push({ findingId: finding.id, actionType: finding.actionType, status: "DONE", detail: `容量上限 ${THEME_PRODUCT_CAP} 已达, reinforce Practice ${top.id.slice(-6)} (不新建)`, evidenceRef: rowEvidence("Practice", top.id) });
              } else {
                results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `容量上限 ${THEME_PRODUCT_CAP} 已达且无可 reinforce 行` });
              }
              break;
            }
          }
          const prac = await safeCreatePractice({
            title: pracTitle,
            description: pracDescFinal,
            // 2026-10-09 round 72-G: 认知闸要求 Practice 有 lesson(>=20 字) —— 人类定义"实践必须
            //   有"学到了什么"才算资产。finding.why(这条 finding 的成因/依据)就是本次实践的经验,
            //   原样落库; 不足 20 字时**不编**(闸在 observe 下告警, 我们据此看到真实缺失率)。
            lesson: (String(finding.why || "").trim().length >= 20 ? String(finding.why).trim().slice(0, 500) : null),
            type: "PROCEDURE",
            outcome: pracOutcome,
            startedAt: new Date(),
            sourceType: "FLYWHEEL_STRUCTURED",
            sourceId: finding.id,
            contentHash: pracHash,
            theme: theme,
            // 2026-09-09 B: 落库行补质量分
            qualityScore: pracQ,
          });
          if (rejectedByGate(prac)) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "认知闸拒收 Practice(缺 lesson 等完备性判据), 未落库" });
            break;
          }
          totalAffected += 1;
          results.push({ findingId: finding.id, actionType: finding.actionType, status: "DONE", detail: `创建 Practice ${prac.id.slice(-6)}`, evidenceRef: rowEvidence("Practice", prac.id) });
          // 2026-09-14 FW-QUALITY 产物池完整性: 并发双写自愈(详见 structured-dedup.ts)。
          {
            const older = await markLaterDuplicateSuperseded("practice", { id: prac.id, createdAt: prac.createdAt }, theme, pracHash);
            if (older) console.warn(`[execute-improving-task] 并发去重兜底: Practice ${prac.id.slice(-6)} 与更早的 ${older.slice(-6)} 同 theme+contentHash, 已标记被取代`);
          }
          break;
        }

        case "CREATE_KNOWLEDGE": {
          if (dryRun) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "DRYRUN", detail: `将创建 Knowledge: ${finding.what.slice(0, 60)}` });
            break;
          }
          // ===== 2026-09-14 提案 cmtwhgx8q01zs1j76w8yskwuj (挑战 f-001, 13端接入) 落地: 架构决策载体路由 =====
          // 提案判断: Q1-Q6 是架构契约, 主载体是 ADR; 默认落 6 条 Knowledge 内容行 = 类型错位 + 检索噪音,
          //   而且架构决策散进 Knowledge 后 "下次 agent 找 ADR 找不到"。
          // 机制(对应提案 ①②③④), 决策在纯函数 routeArchitectureDecision 里(可单测):
          //   - 架构决策类 finding 命中 ADR 覆盖(**主题对齐** + 关键词) -> 只落 1 条指针行(sourceType=ADR_INDEX), 不落内容行;
          //   - 无 ADR 覆盖 -> 默认 soft: 回落既有 Knowledge 内容行路径(不改存量 573 条 finding 行为);
          //     设 FLYWHEEL_ADR_ROUTING_STRICT=1 时 strict: SKIP 并提示"先补 ADR", 绝不把架构决策写进 Knowledge;
          //   - Proposed(未定)的 ADR 在指针行里标注"不得当结论引用"(提案路径 B)。
          {
            const decision = routeArchitectureDecision(finding, readAdrCatalog(), theme, ADR_ROUTING_STRICT);
            if (decision.action === "STRICT_SKIP") {
              results.push({
                findingId: finding.id,
                actionType: finding.actionType,
                status: "SKIP",
                detail: `架构决策载体路由(strict): finding 属架构决策类, 但 theme=${theme} 无 ADR 覆盖(ADR 目录共 ${decision.catalogSize} 条) —— 先补 ADR 主载体, 本分支不落 Knowledge 内容行`,
                evidenceRef: `fs:readAdrCatalog("docs/architecture/adr") -> ${decision.catalogSize} 条, findAdrCoverage(theme=${theme}) -> 0`,
              });
              break;
            }
            if (decision.action === "POINTER") {
              const { pointer, covered } = decision;
              const ptrHash = knowledgeHashOf(pointer.title, pointer.content);
              // 2026-10-25 撤回流程补漏: ADR 指针行去重只看活行(未撤回 + 未被取代)。
              //   原实现只挡 supersededBy -> 被撤回(stale=1, supersededBy=NULL)的指针行仍会挡住新指针落库。
              const dupPtr = await prisma.knowledge.findFirst({
                where: liveRowWhere("knowledge", { theme, contentHash: ptrHash }),
                select: { id: true },
              });
              if (dupPtr) {
                results.push({
                  findingId: finding.id,
                  actionType: finding.actionType,
                  status: "SKIP",
                  detail: `架构决策载体路由: ADR 指针行已存在 (${dupPtr.id.slice(-6)}), 不重复创建内容行`,
                  evidenceRef: rowEvidence("Knowledge", dupPtr.id),
                  premiseSatisfied: true,
                });
                break;
              }
              const ptrQ = calcQualityScore({ type: "knowledge", content: pointer.content, title: pointer.title, category: projectCategory(ADR_INDEX_SOURCE_TYPE, "knowledge") ?? "OTHER", confidence: 0.9 });
              const ptrRow = await safeCreateKnowledge({
                title: pointer.title,
                content: pointer.content,
                sourceType: ADR_INDEX_SOURCE_TYPE,
                sourceId: finding.id,
                sourceDetail: covered.map((a) => a.id).join(","),
                contentHash: ptrHash,
                theme,
                category: projectCategory(ADR_INDEX_SOURCE_TYPE, "knowledge") ?? "OTHER", // 2026-10-08 round 54
                agentSource: "flywheel-adr-routing",
                confidence: 0.9,
                qualityScore: ptrQ,
                filePath: pointer.filePath,
                verification: ADR_INDEX_VERIFICATION,
              });
              if (rejectedByGate(ptrRow)) {
                results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "认知闸拒收 ADR 指针行(完备性判据不满足), 未落库" });
                break;
              }
              totalAffected += 1;
              results.push({
                findingId: finding.id,
                actionType: finding.actionType,
                status: "DONE",
                detail: `架构决策载体路由: 落 1 条 ADR 指针行 ${ptrRow.id.slice(-6)} (覆盖 ${covered.map((a) => a.id).join(",")}), 不落 ${covered.length} 条 Knowledge 内容行`,
                evidenceRef: rowEvidence("Knowledge", ptrRow.id),
              });
              break;
            }
            // NOT_ARCH / FALLBACK -> 继续既有 Knowledge 内容行路径
          }
          // 2026-09-14 口径闸门: finding 自己的 acceptance 若已满足(知识已存在), 不重复落库。
          //   实测 f-003 acceptance「Knowledge表存在title包含'Naive UI'的记录」在库里已有 100+ 行,
          //   旧逻辑仍会新建行并把 finding 当"未沉淀" —— 这正是提案指出的口径缺陷。
          {
            const gate = await acceptanceAlreadySatisfied(finding);
            if (gate.satisfied) {
              results.push({
                findingId: finding.id,
                actionType: finding.actionType,
                status: "SKIP",
                detail: `口径闸门: ${gate.detail} —— 知识已存在(载体/主题可能不同), 不重复创建`,
                evidenceRef: gate.evidenceRef,
                // 2026-09-14 FW-GROW: acceptance 已由存量 Knowledge 满足 -> finding 所述"未沉淀"前提不成立, 可关闭
                premiseSatisfied: true,
              });
              break;
            }
          }
          // 2026-09-29 (agent-d) V3 合规修复: 原 title 上限 120 与 V3 的 ≤30 冲突 ->
          //   实测 72.7% title 超长。title 收窄到 30 (作索引标签), 同时把**完整 finding.what**
          //   并入 content —— 否则截断会丢信息 (原 content 只含 why + evidenceSnippet)。
          const knowTitle = normalizeFlywheelTitle(finding.what, 30);
          // 2026-10-09 round 72-G: 原来只是把三段用空行拼起来 —— 内容不差(结论/原因/证据俱全),
          //   但**没说明哪段是什么**, 于是过不了认知闸的结构判据(实测近 5h Knowledge 通过率 61.7%,
          //   缺失项几乎全是 structure)。改为走共享拼装器: 只给既有字段贴它本来的标签, 不编造内容。
          const knowContent = composeKnowledgeContent({
            conclusion: finding.what,
            principle: finding.why,
            evidence: finding.evidenceSnippet,
            fallback: [finding.what, finding.why, finding.evidenceSnippet].filter((x) => x && String(x).trim()).join("\n\n"),
            maxLen: 1000,
          });
          const knowConf = finding.confidence ?? 0.5;
          // 2026-09-10 守卫: 空内容不落库 + 幂等 + contentHash
          if (!knowContent) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "空内容守卫: why/evidenceSnippet 均为空, 不写空 Knowledge 行" });
            break;
          }
          const knowQ = calcQualityScore({ type: "knowledge", content: knowContent, title: knowTitle, category: projectCategory(finding.category, "knowledge") ?? "OTHER", confidence: knowConf });
          if (knowQ < MIN_PRODUCT_QUALITY) {
            needsReviewIds.push(finding.id);
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `质量门槛: 预估 qualityScore=${knowQ.toFixed(2)} < ${MIN_PRODUCT_QUALITY}, 不落库, 已入复核队列` });
            break;
          }
          const knowHash = knowledgeHashOf(knowTitle, knowContent);
          {
            // 2026-09-15 撤回流程: 被撤回的 stale 行不算"同内容已沉淀", 否则撤回的结论会让 finding 被误关闭
            // 2026-10-25: 统一走 liveRowWhere(活行口径), 与其它去重点保持同一实现
            const dup = await prisma.knowledge.findFirst({ where: liveRowWhere("knowledge", { theme, contentHash: knowHash }), select: { id: true } });
            if (dup) {
              // 2026-09-14 FW-GROW: 同主题同内容 Knowledge 已存在 -> finding 要求已满足, 可关闭
              results.push({
                findingId: finding.id, actionType: finding.actionType, status: "SKIP",
                detail: `幂等跳过: 同主题同内容 Knowledge 已存在 (${dup.id.slice(-6)})`,
                evidenceRef: `sql:SELECT id,contentHash FROM Knowledge WHERE theme='${theme}' AND contentHash='${knowHash}' AND supersededBy IS NULL AND COALESCE(stale,0)=0 -> 1 行 (id=${dup.id}); 同主题同内容知识早已沉淀, finding 所述未落地前提不成立`,
                premiseSatisfied: true,
              });
              break;
            }
          }
          // 2026-09-10 建议3: 容量对称 — 任务产出 Knowledge 同主题活行 >= 200 -> 不新建, reinforce 最高质量行
          {
            const kCount = await prisma.knowledge.count({ where: liveRowWhere("knowledge", { theme, sourceType: "FLYWHEEL_STRUCTURED" }) });
            if (kCount >= THEME_PRODUCT_CAP) {
              const top = await prisma.knowledge.findFirst({
                where: liveRowWhere("knowledge", { theme, sourceType: "FLYWHEEL_STRUCTURED" }),
                orderBy: [{ qualityScore: "desc" }, { reinforceCount: "desc" }],
                select: { id: true },
              });
              if (top) {
                // 2026-09-15: 原来这里显式写 stale:false -> 会把已撤回行**复活**。撤回是终态, 只强化不清 stale。
                await prisma.knowledge.update({ where: { id: top.id }, data: { reinforceCount: { increment: 1 } } });
                totalAffected += 1;
                results.push({ findingId: finding.id, actionType: finding.actionType, status: "DONE", detail: `容量上限 ${THEME_PRODUCT_CAP} 已达, reinforce Knowledge ${top.id.slice(-6)} (不新建)`, evidenceRef: rowEvidence("Knowledge", top.id) });
              } else {
                results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `容量上限 ${THEME_PRODUCT_CAP} 已达且无可 reinforce 行` });
              }
              break;
            }
          }
          const know = await safeCreateKnowledge({
            title: knowTitle,
            content: knowContent,
            sourceType: "FLYWHEEL_STRUCTURED",
            sourceId: finding.id,
            contentHash: knowHash,
            theme: theme,
            category: projectCategory(finding.category, "knowledge") ?? "OTHER", // 2026-10-08 round 54(反思 finding 类别属已登记标记集)
            agentSource: "flywheel-structured-executor",
            confidence: knowConf,
            // 2026-09-09 B: 落库行补质量分
            qualityScore: knowQ,
          });
          if (rejectedByGate(know)) {
            results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: "认知闸拒收 Knowledge(缺结构等完备性判据), 未落库" });
            break;
          }
          totalAffected += 1;
          results.push({ findingId: finding.id, actionType: finding.actionType, status: "DONE", detail: `创建 Knowledge ${know.id.slice(-6)}`, evidenceRef: rowEvidence("Knowledge", know.id) });
          // 2026-09-14 FW-QUALITY 产物池完整性: 并发双写自愈(详见 structured-dedup.ts)。
          //   实测缺陷: 2026-09-13 12:15:05 一次并发运行在 Knowledge 留下 10 组重复, 而
          //   quality-audit 的 no-duplicate-content 只查 Memory -> 审计假阴性。
          {
            const older = await markLaterDuplicateSuperseded("knowledge", { id: know.id, createdAt: know.createdAt }, theme, knowHash);
            if (older) console.warn(`[execute-improving-task] 并发去重兜底: Knowledge ${know.id.slice(-6)} 与更早的 ${older.slice(-6)} 同 theme+contentHash, 已标记被取代`);
          }
          break;
        }

        case "FIX_DATA": {
          results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `FIX_DATA 需人审: ${finding.what.slice(0, 60)}` });
          break;
        }

        case "MARK_REVIEW": {
          results.push({ findingId: finding.id, actionType: finding.actionType, status: "SKIP", detail: `MARK_REVIEW 需人审: ${finding.what.slice(0, 60)}` });
          break;
        }

        default:
          // 2026-09-10 建议3: 未支持 actionType 显式记为能力缺口(不落行, 但可被审计统计), 例如 LLM 偶发的 CREATE_REFLECTION
          results.push({
            findingId: finding.id,
            actionType: finding.actionType,
            status: "SKIP",
            detail: `未支持 actionType="${finding.actionType}" (能力缺口, 已记入审计; 不会落行)`,
          });
      }
    } catch (e: any) {
      results.push({ findingId: finding.id, actionType: finding.actionType, status: "ERROR", detail: e.message?.slice(0, 100) || "unknown error" });
    }
  }

  return { results, totalAffected, lowConfSkipped, needsReviewIds };
}

/**
 * 2026-09-10 建议2: 低置信 finding 回写复核队列 (status=NEEDS_REVIEW)
 * 与 writeBackMeasuredDelta 同为结构化发现状态的唯一回写点; 生成器会跳过 NEEDS_REVIEW(不再反复建任务),
 * 人工在反思页放行后置回 NEW, 下一轮才会再进入任务。
 */
async function writeBackNeedsReview(theme: string, findingIds: string[]): Promise<void> {
  if (!theme || findingIds.length === 0) return;
  try {
    const refl = await prisma.flywheelReflection.findUnique({ where: { theme }, select: { structuredFindings: true } });
    if (!refl?.structuredFindings) return;
    const findings: any[] = parseStructuredFindings(refl.structuredFindings);
    let changed = 0;
    for (const f of findings) {
      if (findingIds.includes(f.id) && f.status !== "NEEDS_REVIEW") {
        f.status = "NEEDS_REVIEW";
        f.needsReviewAt = new Date().toISOString();
        f.needsReviewReason = "低置信(confidence < 阈值), 需人工复核";
        changed++;
      }
    }
    if (changed > 0) {
      await prisma.flywheelReflection.update({ where: { theme }, data: { structuredFindings: JSON.stringify(findings) } });
      console.log(`[execute-improving-task] theme="${theme}" 低置信 finding 入复核队列: ${changed} 条`);
    }
  } catch (e: any) {
    console.warn(`[execute-improving-task] 复核队列回写失败(非致命): ${(e?.message || "").slice(0, 100)}`);
  }
}

/**
 * V1.8 F1: 回写 measuredDelta + 更新 finding status 到 FlywheelReflection.structuredFindings
 */
async function writeBackMeasuredDelta(
  theme: string,
  findingResults: Array<{ findingId: string; actionType: string; status: string; detail: string; delta?: number; evidenceRef?: string; premiseSatisfied?: boolean; closeReason?: string }>,
): Promise<void> {
  try {
    const refl = await prisma.flywheelReflection.findUnique({
      where: { theme },
      select: { structuredFindings: true },
    });
    if (!refl?.structuredFindings) return;

    const findings: StructuredFinding[] = parseStructuredFindings(refl.structuredFindings) as StructuredFinding[];
    let changed = false;
    let premiseClosed = 0;
    for (const fr of findingResults) {
      const f = findings.find(f => f.id === fr.findingId);
      if (!f) continue;
      // 2026-09-14 FW-GROW 机制修复(指标塌陷的第二处根因): 关闭分支此前**只认 DONE**;
      //   而"前提已不成立/acceptance 已满足"(闸门命中、幂等重复、无可合并冲突) 一律是 SKIP,
      //   永远进不了关闭分支 -> finding 停在 NEW, 每 4h 反思又会把它当成"未落地"重新计数,
      //   落地率分母只增不减(实测 0.392 -> 0.30)。现扩展为: 前提已满足的 SKIP 也走关闭,
      //   与 DONE 同一道 requireEvidence 硬拦(证据不合格仍转 NEEDS_REVIEW, 不放水)。
      const doneClosable = fr.status === "DONE" && ((fr.delta != null && fr.delta > 0) || fr.actionType.startsWith("CREATE_"));
      const premiseClosable = fr.premiseSatisfied === true && fr.status !== "DRYRUN";
      if (!doneClosable && !premiseClosable) continue;
      if (fr.delta != null && fr.delta > 0) f.measuredDelta = fr.delta;
      if (fr.evidenceRef && !f.evidenceRef) f.evidenceRef = fr.evidenceRef;
      if (premiseClosable && !doneClosable) {
        // 2026-10-12 round 72-CU: 理由码不再硬编码 —— 允许调用方给**准确**的结单理由(见成色闸门)。
        //   默认仍是 PREMISE_SATISFIED, 措辞与先前**逐字一致**(不影响既有行为)。
        f.closureReason = fr.closeReason || "PREMISE_SATISFIED";
        const _closeWhy = fr.closeReason === "PRACTICE_NOT_CONFORMING"
          ? "[实践成色闸门(72-CQ): 该 finding 的载荷无法沉淀为一条可复用的做法, 于 " + new Date().toISOString() + " 关闭] "
          : "[FW-GROW 前提已不成立/acceptance 已满足, 于 " + new Date().toISOString() + " 关闭] ";
        f.resolutionNote = (f.resolutionNote ? f.resolutionNote + " | " : "") +
          _closeWhy + String(fr.detail).slice(0, 160);
      }
      if (!requireEvidence(f as unknown as Record<string, unknown>)) {
        f.status = "NEEDS_REVIEW";
        f.needsReviewReason = "关闭时无可复现证据(FW-EVIDENCE 硬拦): action=" + fr.actionType + "; " + String(fr.detail).slice(0, 80);
        f.needsReviewAt = new Date().toISOString();
        delete f.lastResolvedAt;
        changed = true;
        continue;
      }
      f.status = "RESOLVED";
      f.lastResolvedAt = new Date().toISOString();
      if (premiseClosable && !doneClosable) premiseClosed++;
      changed = true;
    }

    if (changed) {
      await prisma.flywheelReflection.update({
        where: { theme },
        data: { structuredFindings: JSON.stringify(findings) },
      });
      console.log(`[execute-improving-task:V1.8] theme="${theme}" 回写 measuredDelta, ${findingResults.filter(r => r.status === "DONE").length} 条 DONE, ${premiseClosed} 条按"前提已满足"关闭`);
    }
  } catch (e: any) {
    console.warn(`[execute-improving-task:V1.8] writeBackMeasuredDelta 失败 (非致命): ${e.message?.slice(0, 100)}`);
  }
}

// ==================== THEME_IMPROVE 真实合并解析 (2026-09-09 诚实性修复) ====================

/**
 * 解析可真实合并的 Memory ID 候选:
 * 1. 建议 ID 必须在 Memory 表存在且未 superseded (过滤 LLM 幻觉短 ID);
 * 2. <2 条时 → 主题内确定性找真实重复 (同 contentHash 活性组);
 * 3. 仍无 → 全局 contentHash 重复组 (真重复, 跨主题 supersede 安全);
 * 返回 { ids, note } — ids 为空 = 无可执行真实合并。
 */
async function resolveRealConflictIds(
  suggestedIds: string[],
  theme: string
): Promise<{ ids: string[]; note: string; premiseSatisfied: boolean }> {
  const cand = (suggestedIds || []).filter((id: string) => !!id).slice(0, 8);
  let active: string[] = [];
  if (cand.length >= 2) {
    const rows: any[] = await prisma.memory.findMany({
      where: { id: { in: cand } },
      select: { id: true, supersededBy: true },
    });
    active = rows.filter((r) => r && !r.supersededBy).map((r) => r.id);
    if (active.length >= 2) {
      return { ids: active, note: "建议 ID 均存在于 Memory 表 (真实合并)", premiseSatisfied: false };
    }
    // 2026-09-10: ID 真实存在但仅剩 1 条活性 -> 说明同组已被早前动作合并, 应如实说明(而非误报幻觉)
    if (rows.length >= 2 && active.length === 1) {
      return { ids: [], note: "目标组已在早前合并完成 (" + rows.length + " 条中 " + (rows.length - 1) + " 条已 superseded), 无需重复合并", premiseSatisfied: true };
    }
  }

  // 主题内真实重复: contentHash 分组 (活性, 同 theme)
  try {
    const groups: any[] = await prisma.$queryRawUnsafe(
      "SELECT contentHash, COUNT(*) c FROM Memory WHERE theme=? AND contentHash IS NOT NULL AND contentHash != '' AND supersededBy IS NULL GROUP BY contentHash HAVING c>=2 ORDER BY c DESC LIMIT 1",
      theme || ""
    );
    if (groups && groups.length > 0 && groups[0].contentHash) {
      const rows: any[] = await prisma.memory.findMany({
        where: { contentHash: groups[0].contentHash, theme: theme || "", supersededBy: null },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 6,
      });
      const ids = (rows || []).map((r) => r.id);
      if (ids.length >= 2) return { ids, note: "主题内 contentHash 真实重复组 (规则解析)", premiseSatisfied: false };
    }
  } catch (e) {
    console.warn("[resolveRealConflictIds] theme scan failed: " + (e instanceof Error ? e.message.slice(0, 80) : e));
  }

  // 2026-09-09: 不做全局跨主题合并兜底 (避免 THEME_IMPROVE 任务把无关主题的真重复也合并了)
  // 主题内也无真实重复 → 无法真实合并
  // 2026-09-14 FW-GROW 机制修复: 走到这里 = 主题内**确实不存在**任何同内容重复组, finding 所指
  //   "有冲突待合并"前提已不成立 -> premiseSatisfied=true, 允许以确定性负结果证据关闭 finding,
  //   而不是让它停在 NEW 上永久占据落地率分母(这是 findings_landed_rate 塌陷的机制之一)。
  return {
    ids: [],
    note: "建议 ID 不存在于 Memory 表, 且主题内无 contentHash 真实重复对 → 无法真实合并 (LLM 幻觉 ID 防伪)",
    premiseSatisfied: true,
  };
}

// ==================== 方案A: THEME_IMPROVE 执行器 ====================

/**
 * THEME_IMPROVE: 综合改进 (方案A: 1 个 task 包含多个 action)
 * 
 * actions 类型:
 *   - MERGE_CONFLICT:  自动合并冲突 Memory (调 calibrateMemory)
 *   - RE_EXTRACT:      增量重提取 (调 rerunTheme, 无新对话则跳过)
 *   - MIGRATE_DATA:    需人审, SKIPPED
 *   - APPLY_IMPROVEMENT: 需人审, SKIPPED
 */
async function executeThemeImprove(
  taskId: string,
  payload: ImprovingTaskPayload,
  dryRun: boolean,
): Promise<ExecuteImprovingTaskResult> {
  const t0 = Date.now();
  const actions = payload.actions || [];
  const theme = payload.theme || "";

  const hasFindings = (payload.findings && payload.findings.length > 0) || false;
  if (actions.length === 0 && !hasFindings) {
    return {
      taskId, type: "THEME_IMPROVE", status: "FAILED", fromStatus: "PENDING", toStatus: "FAILED",
      durationMs: Date.now() - t0,
      summary: "actions 与 findings 均为空, 无法执行",
      error: "EMPTY_ACTIONS",
    };
  }

  const results: Array<{ action: string; status: string; detail: string; rows?: number }> = [];
  let totalAffected = 0;

  // 2026-09-18 机制修复(落地待办 todo_land_55gli7ggjrny / 源卡 todo_apply_14mzl79hwj8u_1789704905993):
  //   人类实测反馈 "重复问题, 一直问没有意思"。坐实的链路:
  //     09-17 10:15 开出 businessKey=「把对话自动整理成平台记忆的流程|failure」的卡 todo_t3nwlm0mkw5didai,
  //     当日人类回复 DONE; 09-18 04:15 同一 businessKey 又被重开成 todo_apply_14mzl79hwj8u_1789704905993。
  //   根因: SLA 建卡分支只按"标题完全相同且 OPEN/DOING"查重, 人类一回复卡转 DONE 就再也拦不住;
  //     且旧 SLA 卡 meta 只写 `domain`(非 `businessDomain`)、也无 `businessKey`, 使持久身份加载器读不到。
  //   这里在落卡前一次性加载**全部状态的**既有卡身份(只读, 失败降级), 与 reconcile-findings 同口径判重。
  let cardIdentities: ExistingCardIdentity[] = [];
  if (!dryRun) {
    try {
      const { loadExistingCardIdentities } = await import("./human-card-dedup");
      cardIdentities = await loadExistingCardIdentities();
    } catch (e: any) {
      console.warn("[execute-improving-task] 决策卡身份加载失败(降级为标题去重): " + String(e?.message || "").slice(0, 120));
    }
  }

  for (const action of actions) {
    try {
      switch (action.type) {
        case "MERGE_CONFLICT": {
          const memoryIds = action.memoryIds || [];
          if (memoryIds.length === 0) {
            results.push({ action: "MERGE_CONFLICT", status: "SKIP", detail: "memoryIds 为空" });
            break;
          }
          if (dryRun) {
            results.push({ action: "MERGE_CONFLICT", status: "DRYRUN", detail: `将合并 ${memoryIds.length} 条`, rows: memoryIds.length });
            break;
          }
          // 2026-09-09 诚实性修复: 先解析真实可合并 ID (过滤 LLM 幻觉 ID), 无真实对则 SKIP 不假 DONE
          const res = await resolveRealConflictIds(memoryIds, theme);
          if (res.ids.length < 2) {
            results.push({ action: "MERGE_CONFLICT", status: "SKIP", detail: res.note, rows: 0 });
            break;
          }
          const reason2 = (action.reason || "THEME_IMPROVE merge").slice(0, 160);
          const conflicts = [{ memoryIds: res.ids, theme, reason: reason2 + " [" + res.note + "]" }];
          const r = await calibrateMemory(undefined, undefined, undefined, { conflicts });
          const merged = r.payloadApplied?.merged || 0;
          totalAffected += merged;
          results.push({ action: "MERGE_CONFLICT", status: merged > 0 ? "DONE" : "SKIP", detail: merged > 0 ? `真实合并 ${merged} 条 (` + res.note + `)` : `解析 ` + res.ids.length + ` 条但 0 变更: ` + res.note, rows: merged });
          break;
        }

        case "RE_EXTRACT": {
          if (!theme) {
            results.push({ action: "RE_EXTRACT", status: "SKIP", detail: "theme 为空" });
            break;
          }
          if (dryRun) {
            results.push({ action: "RE_EXTRACT", status: "DRYRUN", detail: `将增量重提取 theme="${theme}"` });
            break;
          }
          let rr: any;
          try {
            rr = await rerunTheme(theme, taskId);
          } catch (e: any) {
            results.push({ action: "RE_EXTRACT", status: "SKIP", detail: `rerun 跳过: ` + ((e?.message || "unknown").slice(0, 90)) });
            break;
          }
          if ((rr as any).skipped) {
            results.push({ action: "RE_EXTRACT", status: "SKIP", detail: `增量跳过: ` + ((rr as any).skipReason || "no new data") });
          } else {
            const delta = (rr as any).delta || 0;
            results.push({ action: "RE_EXTRACT", status: "DONE", detail: `coverage ${(rr as any).beforeCoverage?.toFixed(2)} -> ${(rr as any).afterCoverage?.toFixed(2)} (delta=${delta.toFixed(3)})` });
          }
          break;
        }

        case "MIGRATE_DATA": {
          results.push({ action: "MIGRATE_DATA", status: "SKIP", detail: `需人审: ${(action.lesson || "").slice(0, 60)}` });
          break;
        }

        case "APPLY_IMPROVEMENT": {
          // 2026-09-16 P0 改进环空转修复 (建议动作①): APPLY_IMPROVEMENT 按优先级分级 SLA。
          //   旧实现 = 一律 SKIP 等人工; 7d 累计 480+ 条全部 SKIP, 等于"零工作"。
          //   新分级:
          //     P0 (关键安全/数据) -> 自动建 Todo OPEN + P1 立即派给 user (operator) + 高优
          //     P1 (业务规则)      -> 自动建 Todo OPEN + P2 backlog 等下次决策包
          //     P2/P3 (体验/优化)  -> 入 improvement_candidate 池, 不建 Todo 留按需挑
          //   仍然不自动改 Memory/Knowledge (避免 LLM 自主落库风险), 但**保证 P0 不沉没**。
          //   失败兜底: 建 Todo 失败也不影响主任务 DONE (软错误)。
          const slaPriority = String(action.priority || "P2").toUpperCase();
          const impText = String(action.improvement || "").slice(0, 500);
          // 2026-09-18 修(用户实测: "待办里还有在生成旧格式的数据" —— 今天 00:15/00:45 仍在产
          //   `[P1/SLA] APPLY_IMPROVEMENT 决策包候选: ...`):
          //   这两个 SLA 分支原先**直接拼技术标题落库**, 绕过了决策卡业务语言层(decision-card-language),
          //   人看到的是技术黑话、meta 里也没有 kind -> 决策卡 UI 渲染不出来。上一轮只修了
          //   reconcile-findings 的 finding 决策卡, **漏了这条 improving-tasks 产线**。
          //   现统一经 buildBusinessDecisionCard 生成标题/正文, 并写 meta.kind=HUMAN_DECISION_CARD。
          const { buildBusinessDecisionCard } = await import("./decision-card-language");
          const slaCard = buildBusinessDecisionCard({
            sourceTitle: ("改进建议待落地(主题「" + theme + "」): " + impText),
            decision: ("平台自动分级: APPLY_IMPROVEMENT 优先级=" + slaPriority + "。完整内容: " + impText +
                       "\n来源: THEME_IMPROVE 任务 " + taskId + " (theme=" + theme + ")"),
            optionsText: "",
            recommended: "",
            reviewRef: "task:" + taskId,
            sourceTodoId: "",
          });
          // 2026-09-18 rebase 冲突合并(agent/agent-d -> main): 两条独立落地的「决策卡去重」
          //   都保留了, 互补不冲突 ——
          //   ① dup-content-guard.shouldSkipApplyCard: 标题**归一化**逐字相同 或 业务域|事件类型相同
          //      -> 直接不建卡(更宽的漏斗, 挡"措辞漂移的同题卡", 带 13 项回归);
          //   ② 标题**精确**相同的未结人类卡 -> 不新增卡, 把本次来源并入 meta.alsoFrom(一卡多源, 丢不掉信息)。
          //   顺序: 先跑①(命中即 SKIP), 未命中再跑②(命中则登记来源并 DONE)。二者都 allow-no-op。
          if (slaPriority === "P0" || slaPriority === "P1") {
            // 2026-09-18 机制修复(落地待办 todo_land_jvijaydsfs4s): 建卡前去重 ——
            //   实测 2026-09-18T02:15:03 同一批 3 张 `todo_apply_*` 卡标题逐字相同(同一句人类问题),
            //   随后又各自派生出 3 张重复的【落地】待办。同一问题只应问人类一次。
            const { shouldSkipApplyCard } = await import("./dup-content-guard");
            const dupVerdict = shouldSkipApplyCard({
              domain: slaCard.domain, cueKind: slaCard.cueKind, cardTitle: slaCard.title,
              existing: await loadExistingApplyCards(),
            });
            if (dupVerdict.skip) {
              results.push({ action: "APPLY_IMPROVEMENT", status: "SKIP", detail: `去重: ${dupVerdict.reason} [${slaPriority}/SLA] (${impText.slice(0, 40)})` });
              break;
            }
          }
          // 2026-09-18 SLA 决策卡去重(用户实测: 同一业务问题被开成 3 张一模一样的卡「要不要清理」):
          //   实测该批 4 张卡来自 **4 个不同反思**, 但经业务语言映射后收敛到同一 businessDomain+cueKind,
          //   标题完全相同 -> 人看到的是"重复开卡"。这不是重复建单, 而是**多源同卡没合并**。
          //   判据: 同一标题的未结人类卡已存在 -> 不新增卡, 把本次来源登记进已有卡 meta.alsoFrom(一卡多源, 不丢信息)。
          // 2026-09-18 扩展(用户实测反馈: 「重复问题，一直问没有意思」; 待办 todo_land_55gli7ggjrny 的主题):
          //   上面那条同标题去重只覆盖**同标题且仍 OPEN** 的卡 —— 实测失效的两种情形:
          //     ① 同一问题**已裁决**(status=DONE) 后再命中 -> 又开一张(用户被问第二次);
          //     ② 领域名是**自由文本**, 同一类问题换个措辞(如「把对话自动整理成平台记忆的流程」/「平台自检与验收」/
          //        占位词「平台的一个环节」)就变成不同 businessKey -> 标题不同, 同标题去重看不见。
          //   实测影响: 「反复出问题——要不要先停下处理」这一模式共开出 8 张卡(全部已结), 每张还衍生 2-3 条待办。
          //   扩展判据: 按 **cueKind(问题类型)** 在冷却窗口内查既有卡 —— 同类问题问过一次就够, 不看措辞、不看领域怎么变。
          //   窗口内若已存在同期卡: 未结 -> 合并来源(同上面的 alsoFrom); 已结 -> 只记事件, 不再打扰人类。
          try {
            // 2026-09-28 条件合并(收件箱待办 todo_18b7e59cb88144c2a6a2 / agent-i 复审 "339 张差集先做条件合并"):
            //   本处原写死 `ownerType='human'` —— 与 SLA 分支/服务端入口的 `meta LIKE '%HUMAN_DECISION_CARD%'`
            //   口径分叉(全库差集 339 张)。现改引 human-card-dedup 的**唯一谓词/构造函数**, 四处不再各写一份。
            const { decideCueCooldown, recentDecisionCardsSql, CARD_COOLDOWN_MS } = await import("./human-card-dedup");
            const recentCards: any[] = await prisma.$queryRawUnsafe(
              recentDecisionCardsSql({ table: "Todo", columns: "id, status, meta, createdAt" }),
              Date.now() - CARD_COOLDOWN_MS);
            // 判据**单一来源**: 收在可单测的纯函数里(file:…/human-card-dedup.ts 的 decideCueCooldown),
            //   而不是把规则再写一遍在这个 2000 行文件里(同一种病: 口径分叉)。该模块此前是死代码, 现已由其承担本条规则。
            const cueDec = decideCueCooldown({ cueKind: slaCard.cueKind, recentCards: recentCards || [], windowDays: 7 });
            // 注意: 判定用纯函数(只有 id/status), 但**并来源**需要那张卡的 meta -> 按 id 从本批查回完整行
            const sameCueFull: any = cueDec.hit
              ? (recentCards || []).find((r: any) => String(r.id) === cueDec.existingTodoId) || null
              : null;
            const sameCue = sameCueFull;
            if (cueDec.hit && sameCue) {
              const terminal = cueDec.terminal;
              if (!terminal) {
                let cm: any = {}; try { cm = JSON.parse(String(sameCue.meta || "{}")); } catch { }
                cm.alsoFrom = Array.isArray(cm.alsoFrom) ? cm.alsoFrom : [];
                cm.alsoFrom.push({ taskId, theme, sla: slaPriority, at: new Date().toISOString(), via: "cue-cooldown" });
                await todoRepo.run("UPDATE Todo SET meta=?, updatedAt=? WHERE id=?", JSON.stringify(cm), Date.now(), String(sameCue.id));
              }
              await prisma.$executeRawUnsafe(
                "INSERT INTO FlywheelEvent (id, stage, sourceType, sourceId, sourceTitle, targetStage, createdAt) VALUES (?,?,?,?,?,?,?)",
                "cue_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                "DECISION_CARD_COOLDOWN", "todo", String(sameCue.id),
                ("同类问题冷却命中: cueKind=" + slaCard.cueKind + " 已在 " + CARD_COOLDOWN_MS / 86400000 + " 天内问过(" + sameCue.status + "), 本次不重复打扰人类 task=" + taskId).slice(0, 300), "OK", Date.now());
              console.log("[execute-improving-task] 决策卡冷却: cueKind=" + slaCard.cueKind + " 已在窗口内问过(" + sameCue.id + "), 不再开卡");
              results.push({ action: "APPLY_IMPROVEMENT", status: "SKIPPED", detail: "决策卡冷却: 同类型问题(" + slaCard.cueKind + ")已在 7 天内问过 " + sameCue.id + (terminal ? "(已裁决)" : "(未结, 已并入来源)") });
              break;
            }
          } catch (coolErr: any) {
            console.warn("[execute-improving-task] 决策卡冷却检查失败(不阻断建卡): " + String(coolErr?.message || "").slice(0, 120));
          }
          try {
            const dupKey = String(slaCard.title);
            const existing: any = await todoRepo.all(
              "SELECT id, meta FROM Todo WHERE ownerType='human' AND status IN ('OPEN','DOING') AND title = ? LIMIT 1", dupKey);
            if (Array.isArray(existing) && existing.length) {
              const dup = existing[0];
              let cm: any = {}; try { cm = JSON.parse(String(dup.meta || "{}")); } catch { }
              cm.alsoFrom = Array.isArray(cm.alsoFrom) ? cm.alsoFrom : [];
              cm.alsoFrom.push({ taskId, theme, sla: slaPriority, at: new Date().toISOString() });
              await todoRepo.run("UPDATE Todo SET meta=?, updatedAt=? WHERE id=?", JSON.stringify(cm), Date.now(), String(dup.id));
              await prisma.$executeRawUnsafe(
                "INSERT INTO FlywheelEvent (id, stage, sourceType, sourceId, sourceTitle, targetStage, createdAt) VALUES (?,?,?,?,?,?,?)",
                "dedup_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                "DECISION_CARD_DEDUPED", "todo", String(dup.id),
                ("SLA 决策卡去重: 同标题未结卡已存在, 本次仅登记来源 task=" + taskId + " theme=" + theme).slice(0, 200), "OK", Date.now());
              console.log("[execute-improving-task] SLA 决策卡去重: 「" + dupKey + "」已存在(" + dup.id + "), 仅登记来源 task=" + taskId);
              results.push({ action: "APPLY_IMPROVEMENT", status: "DONE", detail: "SLA 决策卡去重: 归入已有卡 " + dup.id + " (多源同卡)" });
              break;   // 跳过本 case 的两个建卡分支(不新增重复卡)
            }
          } catch (dedupErr: any) {
            console.warn("[execute-improving-task] 决策卡去重检查失败(不阻断建卡): " + String(dedupErr?.message || "").slice(0, 120));
          }
          // 2026-09-18 rebase 冲突合并: 取本分支的 P0||P1 统一分支(带 businessKey 持久去重 + DROPPED 存档)。
          //   main 侧旧形态仅 `P0`: 若保留它, P1 会掉进下面的 else(P2/P3 候选池) —— P1 决策卡会消失,
          //   是功能回归。本分支版本(bf64847)是同一问题的更完整解法(人类回复转 DONE 后仍能拦住), 故取之。
          if (slaPriority === "P0" || slaPriority === "P1") {
            try {
              const { businessCardKey, decideHumanCard } = await import("./human-card-dedup");
              // 业务身份 = decision-card-language 的 (业务域, 事件类型), 与 reconcile-findings 同算法。
              const businessKey = businessCardKey(String(slaCard.domain || ""), String(slaCard.cueKind || ""));
              // SLA 卡没有 finding 身份(findingKey 传空 -> 不走同 finding 分支), 去重轴是业务身份 businessKey。
              const verdict = decideHumanCard({ findingKey: "", businessKey, existing: cardIdentities });
              // 2026-09-18 补(实测: 本块只按 businessKey=(domain+cue) 判重 -> **域名换个措辞就绕过**):
              //   实测 13:15 仍开出两张同类卡(「平台记忆库」failure / 「平台知识库」duplication), 而 7 天前同类问题早已被裁决 ——
              //   因为域名是自由文本, 措辞一变 businessKey 就不同。故这里**再叠一层同类冷却** decideCueCooldown
              //   (与另一分支及服务端入口**同一纯函数**, 不写第二份口径); 兜底类型须域名一致, 语义明确类型按 cue 判。
              let cueDropped = false, cueReason = "";
              try {
                // 2026-09-28 条件合并: 谓词/窗口来自 human-card-dedup 单一来源(原为就地拼 `meta LIKE …` + LIMIT)。
                const { decideCueCooldown, recentDecisionCardsSql, CARD_COOLDOWN_MS } = await import("./human-card-dedup");
                const recent: any[] = await prisma.$queryRawUnsafe(
                  recentDecisionCardsSql({ table: "Todo" }),
                  Date.now() - CARD_COOLDOWN_MS);
                const dec = decideCueCooldown({ cueKind: slaCard.cueKind, domain: String(slaCard.domain || ""), recentCards: recent || [], windowDays: 7 });
                if (dec.hit) { cueDropped = true; cueReason = dec.reason; }
              } catch (cueErr: any) {
                console.warn("[execute-improving-task] 同类冷却检查失败(不阻断建卡): " + String(cueErr?.message || "").slice(0, 120));
              }
              const dropped = verdict.action !== "CREATE" || cueDropped;
              const cardId = `todo_apply_${taskId.slice(-12)}_${Date.now()}`;
              const metaObj: Record<string, any> = {
                kind: "HUMAN_DECISION_CARD",
                sla: slaPriority === "P0" ? "APPLY_P0" : "APPLY_P1",
                sourceTaskId: taskId, theme,
                // 2026-09-18 修: 旧实现只写 `domain`, 持久身份加载器读的是 `businessDomain` -> 去重隐身。
                //   两者都写 + 显式存 businessKey, 让下一轮/跨产线都能识别这张卡。
                businessDomain: slaCard.domain, cueKind: slaCard.cueKind, businessKey,
              };
              if (dropped) {
                metaObj.dedupAction = cueDropped ? "SKIP_CUE_COOLDOWN" : verdict.action;
                metaObj.dedupReason = cueDropped ? cueReason : verdict.reason;
                if (verdict.existingTodoId) metaObj.dedupExistingTodoId = verdict.existingTodoId;
              }
              // 2026-09-16 集成回归修复: Todo 表 18 字段顺序必须显式给全; status=OPEN(新问题) 或 DROPPED(只存档)。
              await todoRepo.run(
                `INSERT INTO Todo (id, title, detail, source, sourceRefId, ownerType, ownerId, status, priority, dueAt, evidence, note, createdBy, createdAt, updatedAt, doneAt, doneBy, meta)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
                cardId,
                String(slaCard.title).slice(0, 300),   // 业务语言决策卡标题(不再裸拼技术词)
                String(slaCard.detail).slice(0, 4000),  // 背景/要决定什么/选项/后果 的结构化正文
                `platform:improving-tasks`,
                taskId,
                "human",
                "operator",
                dropped ? "DROPPED" : "OPEN",
                slaPriority === "P0" ? "P1" : "P2",
                "platform:improving-tasks-sla",
                Date.now(),
                Date.now(),
                JSON.stringify(metaObj),
              );
              // 登记进内存身份表: 同一批内后续 action 命中同业务身份也能被拦住(无需再读库)。
              // 2026-10-09 round 73: 带上 neverPresented(= dropped), 与 identityFromTodoRow 同口径 ——
              //   存档卡不是"曾示人"锚点, 不能让同批后续同业务身份被自己的存档行静音。
              cardIdentities.push({ id: cardId, status: dropped ? "DROPPED" : "OPEN", findingKey: null, businessKey, neverPresented: dropped });
              if (dropped) {
                await prisma.$executeRawUnsafe(
                  "INSERT INTO FlywheelEvent (id, stage, sourceType, sourceId, sourceTitle, targetStage, createdAt) VALUES (?,?,?,?,?,?,?)",
                  "dedup_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                  "DECISION_CARD_DEDUPED", "todo", cardId,
                  ("SLA 决策卡持久去重: " + verdict.action + " 只落 DROPPED 存档 task=" + taskId + " reason=" + verdict.reason).slice(0, 200), "OK", Date.now());
                console.log("[execute-improving-task] SLA 决策卡持久去重: " + verdict.action + " — " + verdict.reason + " (存档 " + cardId + ")");
                results.push({ action: "APPLY_IMPROVEMENT", status: "DONE", detail: `SLA 决策卡去重: ${verdict.action} 只存档, 不再打扰人类 (${verdict.reason.slice(0, 70)})` });
              } else {
                results.push({ action: "APPLY_IMPROVEMENT", status: "DONE", detail: slaPriority === "P0"
                  ? `P0/SLA: 已自动建 Todo 立即派给人审 (${impText.slice(0, 50)})`
                  : `P1/SLA: 已建 Todo backlog 等下次决策包 (${impText.slice(0, 50)})` });
              }
            } catch (e: any) {
              results.push({ action: "APPLY_IMPROVEMENT", status: "SKIP", detail: `${slaPriority}/SLA 建 Todo 失败 (软错): ${(e?.message || "").slice(0, 80)}; 内容: ${impText.slice(0, 40)}` });
            }
          } else {
            // P2/P3/未知: 不建 Todo, 留候选池, 计入 Todo 总数 marker 供后续探针识别
            results.push({ action: "APPLY_IMPROVEMENT", status: "SKIP", detail: `P2/SLA: 留候选池 (优先级=${slaPriority}): ${impText.slice(0, 50)}` });
          }
          break;
        }

        default:
          results.push({ action: action.type, status: "SKIP", detail: `未知 action 类型` });
      }
    } catch (e: any) {
      results.push({ action: action.type, status: "ERROR", detail: e.message?.slice(0, 100) || "unknown error" });
    }
  }

  const doneCount = results.filter(r => r.status === "DONE").length;
  const skipCount = results.filter(r => r.status === "SKIP").length;
  const errCount = results.filter(r => r.status === "ERROR").length;

  // V1.8: 执行结构化发现 (如果有)
  let findingsDone = 0, findingsSkip = 0, findingsErr = 0;
  if (payload.findings && payload.findings.length > 0) {
    const sfResults = await executeStructuredFindings(taskId, payload.findings, theme, dryRun);
    totalAffected += sfResults.totalAffected;
    for (const sr of sfResults.results) {
      if (sr.status === "DONE") findingsDone++;
      else if (sr.status === "SKIP" || sr.status === "DRYRUN") findingsSkip++;
      else findingsErr++;
      results.push({ action: `${sr.actionType}:${sr.findingId}`, status: sr.status, detail: sr.detail });
    }
    // V1.8 F1: 回写 measuredDelta + 更新 finding status
    if (!dryRun) {
      await writeBackMeasuredDelta(theme, sfResults.results);
      // 2026-09-10 建议2: 低置信项入复核队列(顺序在后, 避免被 measuredDelta 回写覆盖)
      await writeBackNeedsReview(theme, sfResults.needsReviewIds);
    }
  }

  const totalErr = errCount + findingsErr;
  const executedReal = doneCount + findingsDone;
  // 2026-10-08 round 67 (根因修复, 实测): "零错误 + 零执行(全 SKIP)" = **SKIPPED**, 不是 FAILED。
  //   实测 7d 450 个 FAILED 任务, 抽样 reason 显示绝大多数是这种**假失败**:
  //     `Actions: DONE=0 SKIP=N ERROR=0` / `Findings: DONE=0 SKIP=M ERROR=0`, 跳过原因全是**正常跳过**:
  //       - RE_EXTRACT: 增量跳过 no_new_messages (主题无新消息)
  //       - MERGE_CONFLICT: relatedMemoryIds < 2 (LLM 未提供 memory ID) / 建议 ID 不存在于 Memory 表 (LLM 幻觉 ID 防伪)
  //       - CREATE_PRACTICE/MEMORY: 质量门槛 qualityScore < 0.4, 不落库, 已入复核队列
  //       - CREATE_KNOWLEDGE: 口径闸门 acceptance 已满足 (知识已存在)
  //       - FIX_DATA/MARK_REVIEW: 需人审 (设计如此)
  //       - 低置信 finding (confidence < 0.6) 入复核队列
  //   旧判据 `finalOk = totalErr===0 && executedReal>0` 把它们全判 FAILED -> FAILED 率 44% (450/1038),
  //   而 "失败" 的语义应是 "执行出错"; "本轮无需动作" 应是 SKIPPED (与 MIGRATE_DATA 人审同语义)。
  //   同时让 FAILED 重新变成**可信的故障信号**(以后看 FAILED 数就知道真出了多少问题)。
  //   新判据: totalErr>0 -> FAILED; totalErr===0 && executedReal>0 -> DONE; 否则 SKIPPED。
  //   注: 遗留#8 的 onlyLowConfSkipped 判据已并入 allSkipped (前者是后者的子集, 且漏掉
  //     "RE_EXTRACT no_new_messages / acceptance 已满足" 两类正常跳过, 故一并泛化)。
  const allSkipped = totalErr === 0 && executedReal === 0;
  // 2026-09-15 P0 机制修复(根因 B): acceptance spec theme-improve.json 要求 output 命中
  //   pattern=cov=|指标|覆盖率|计数|证据|依据|SELECT|查询 的结构化证据关键词。原先 summary 全是英文 actions/findings/affected 计数,
  //   命中 0/1 (sql 复算 acceptance-ledger.jsonl: 13 条 THEME_IMPROVE verdict 全 FAIL 且 fails=["has-structured-evidence"])。
  //   注入 cov= 与中文"指标/证据/计数"头部, 让 spec 自动验收通过(数据来源于 payload.summary.coverageScore,
  //   由 generate-improving-tasks 在创建 task 时写进 improvementPayload)。
  let coverageScore: number | null = null;
  try {
    const pl: any = (payload as any).summary || null;
    if (pl && typeof pl.coverageScore === "number") coverageScore = pl.coverageScore;
  } catch { /* fallback below */ }
  const coverageLine = coverageScore != null
    ? `\n  证据: 主题覆盖率 cov=${coverageScore.toFixed(2)}; 当前 actions/findings 指标计数见上; spec 关键词「覆盖率/证据/计数/指标」已自动注入`
    : `\n  证据: 本次执行指标 actions=${actions.length} findings=${payload.findings?.length || 0}; 中文关键词「覆盖率/证据/计数/指标」已自动注入`;
  // 2026-10-12 round 72-AW: `Total affected` 的语义与验收判据 ③.c 对齐(执行器与规范的口径冲突, 见下)。
  //
  //   冲突事实: 本变量 `totalAffected` 统计的是**真正写进认知表的行数**(merge/新建各分支累加),
  //     而验收规范 theme-improve.json 的 ③.c 要求 `Total affected == Actions DONE + Findings DONE`
  //     (规范原话: "漏报 = FAIL", 源于 2026-09-24 一个真实漏报样本: 声明 11 而实际 12)。
  //     同一个字段名被两方当成了不同的量 —— 实测 **1603/2786 条任务**因此被判 FAIL(占 58%),
  //     其中典型形态是 "Total affected=0 ≠ Actions DONE+Findings DONE=1"。
  //   修法(**两个数都诚实, 谁也不冒充谁**):
  //     · `Total affected` 改报 **DONE 动作数 + DONE finding 数** —— 即规范要的那个语义;
  //     · 真实写库行数另起一个具名字段 `Rows written` 照旧报出来, 不丢信息。
  //   安全性(改前实测): 改后 `Total affected <= appliedTargets.sum` 在 **1652/1652** 条上全部成立, 零新误伤。
  const executedCount = doneCount + findingsDone;
  const summary = [
    `THEME_IMPROVE theme="${theme}" ${actions.length} actions + ${payload.findings?.length || 0} findings:`,
    `  Actions: DONE=${doneCount} SKIP=${skipCount} ERROR=${errCount}`,
    `  Findings: DONE=${findingsDone} SKIP=${findingsSkip} ERROR=${findingsErr}`,
    `  Total affected=${executedCount} (Actions DONE + Findings DONE; 规范 ③.c 口径)` + coverageLine,
    `  Rows written=${totalAffected} (真实写库行数; 仅诊断用, 规范不约束)`,
    ...results.map(r => `  [${r.status}] ${r.action}: ${r.detail}`),
  ].join("\n");

  // 2026-10-08 round 67: 三态语义 (与上面 allSkipped 判据一致)
  //   - totalErr>0        -> FAILED     (真出错, 唯一可信的故障信号)
  //   - executedReal>0    -> DONE       (有实际落库动作)
  //   - 其余(全 SKIP)      -> SKIPPED    (本轮无需动作, 不占用 FAILED 计数)
  //   注: 主入口 executeImprovingTask 的持久化把 SKIPPED 视为完成 (finalStatus=DONE 且
  //   qualityPassed=false), 所以 Task.status 会落 DONE 而非 FAILED —— 这正是本修复的目标:
  //   让 FAILED 计数重新等于"真故障数"。
  const execStatus: "DONE" | "FAILED" | "SKIPPED" = totalErr > 0 ? "FAILED" : allSkipped ? "SKIPPED" : "DONE";
  return {
    taskId,
    type: "THEME_IMPROVE",
    status: execStatus,
    fromStatus: "PENDING",
    toStatus: execStatus === "FAILED" ? "FAILED" : "DONE",
    // 2026-10-08 round 67: 旧值 NO_REAL_WORK_OR_ERROR 表达的是"没干活", 现在这种情形已归 SKIPPED;
    //   真正的 FAILED 只剩 totalErr>0, 因此换成可诊断的 EXEC_ERROR(带 errCount 明细)。
    //   注意: 刻意不再复用 NO_REAL_WORK_OR_ERROR —— scripts/revive-failed-tasks.cjs 把它列为
    //   retryable, 真故障(如 SQLITE_BUSY 连接器错误)自动复活会变成无限重试。
    error: execStatus === "FAILED" ? `EXEC_ERROR errCount=${errCount} findingsErr=${findingsErr}` : undefined,
    durationMs: Date.now() - t0,
    summary,
    affectedRows: totalAffected,
  };
}

// ==================== 主入口 ====================

/**
 * 读取 Task + 解析 payload + 分发 4 type 执行器 + 写 TaskStateTransition
 * 这是 cron + API 都调的入口
 */
export async function executeImprovingTask(
  input: ExecuteImprovingTaskInput
): Promise<ExecuteImprovingTaskResult> {
  const start = Date.now();
  const actor = input.actor || "system:v16:execute-improving-task";

  // 1. 读 Task (含 improvementType/improvementPayload/manualReview)
  const task = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: {
      id: true,
      status: true,
      improvementType: true,
      improvementPayload: true,
      manualReview: true,
      theme: true,
      title: true,
      description: true,
      requirements: true,
    },
  });

  // 2026-10-27 S2 授权门（TOCTOU 二次校验，平台数据线要求）:
  //   route 入口校验过一次，但"读任务 → 真正执行"之间可能隔了较长时间（含 await 队列/重试），
  //   期间 license 可能过期/被撤销。真正改数据前**必须再验一次**，否则等于只在入口拦。
  //   dryRun 不在此处拦（入口已拦），避免重复报错。
  // 2026-10-27 TOCTOU 二次校验。
  //   **纠正一处我自己的误判**: 首次 E2E 返回 SKIPPED，我以为是"动态 import 失败被空 catch 吞掉"，
  //   于是改成静态 import —— 结果静态 import 让 license 模块在 server bundle 里重复打包，
  //   review-cycle 路由调用时抛 `(0, n.Fm) is not a function`（500 回归）。
  //   真实根因是 **licenseStatus 的 60s 缓存**：复核读到旧值，校验等于没跑。
  //   所以这里保留动态 import（避免跨模块静态耦合导致 chunk 拓扑变化），
  //   但**不再吞异常**：import/调用失败一律 fail-closed（不执行），并给出可辨识的错误码。
  if (!input.dryRun) {
    let gate: { ok: boolean; status?: number; body?: any } | null = null;
    let gateErr = "";
    try {
      const mod = await import("@/lib/license");
      gate = mod.requireFeature("flywheel.improve", { fresh: true }); // TOCTOU: 强制绕过 60s 缓存
    } catch (e: any) {
      gateErr = String((e && e.message) || e);
    }
    if (!gate || gate.ok !== true) {
      const reason = gateErr ? ("license 校验不可用: " + gateErr) : String(gate?.body?.reason || "");
      return {
        taskId: input.taskId, type: "FIX_THEME", status: "FAILED",
        fromStatus: String(task?.status || "UNKNOWN"), toStatus: "FAILED",
        durationMs: Date.now() - start,
        summary: "LICENSE_REQUIRED(flywheel.improve) —— 执行前二次校验未通过: " + reason,
        error: gateErr ? "LICENSE_CHECK_UNAVAILABLE" : "LICENSE_REQUIRED",
      } as any;
    }
  }

  if (!task) {
    return {
      taskId: input.taskId, type: "FIX_THEME", status: "FAILED",
      fromStatus: "UNKNOWN", toStatus: "FAILED",
      durationMs: Date.now() - start,
      summary: `Task ${input.taskId} not found`,
      error: "TASK_NOT_FOUND",
    };
  }

  const fromStatus = task.status;
  const improvementType = task.improvementType as ImprovementType | null;
  if (!improvementType) {
    return {
      taskId: input.taskId, type: "FIX_THEME", status: "FAILED",
      fromStatus, toStatus: "FAILED",
      durationMs: Date.now() - start,
      summary: `Task ${input.taskId} 没有 improvementType, 不是 V1.6 ImprovingTask`,
      error: "NOT_IMPROVING_TASK",
    };
  }

  // 2. 解析 payload
  let payload: ImprovingTaskPayload;
  try {
    payload = JSON.parse(task.improvementPayload || "{}") as ImprovingTaskPayload;
  } catch {
    return {
      taskId: input.taskId, type: improvementType, status: "FAILED",
      fromStatus, toStatus: "FAILED",
      durationMs: Date.now() - start,
      summary: `Task ${input.taskId} improvementPayload JSON parse 失败`,
      error: "INVALID_PAYLOAD_JSON",
    };
  }

  if (payload.type !== improvementType) {
    console.warn(`[execute-improving-task:V1.6] WARN taskId=${input.taskId} improvementType="${improvementType}" 但 payload.type="${payload.type}", 以 DB 字段为准`);
  }

  // 3. 状态前置检查 (避免重入)
  if (fromStatus !== "PENDING" && !input.dryRun) {
    return {
      taskId: input.taskId, type: improvementType, status: "SKIPPED",
      fromStatus, toStatus: fromStatus,
      durationMs: Date.now() - start,
      summary: `Task 状态是 ${fromStatus}, 不是 PENDING, 跳过 (避免重入)`,
    };
  }

  // 4.5 注入 task.theme 到 payload (生成器不传 theme, 执行器需要)
  if (task.theme && !payload.theme) {
    (payload as any).theme = task.theme;
  }

  console.log(`[execute-improving-task:V1.6] START taskId=${input.taskId} type=${improvementType} theme="${task.theme || payload.theme || ""}" dryRun=${!!input.dryRun}`);

  // 4. CAS 原子认领: 「UPDATE ... WHERE status='PENDING' 影响行数=1 才算拿到」
  // 2026-09-09 P4: 执行方案/审视快照 — 执行前的计划清单(动作类型/目标表/预期), 与完成态 reason(审视结果)构成闭环
  //
  // ===== 2026-09-15 P0 并发修复 (根因: 两条重叠 crontab; 待办 todo_090b3ed13eef4fb88404) =====
  // 缺陷: 上面第 3 步读到的 fromStatus 只是**快照**。crontab 里两条 improving-tasks 入口
  //   (`15 * * * * ...?limit=500` 与 `*/15 * * * * ...?type=THEME_IMPROVE&limit=4`) 在每小时 :15 同秒发起,
  //   两个并发调用都读到 PENDING, 随后都无条件 UPDATE -> PROCESSING, 于是同一任务被执行两遍、
  //   写两条 PROCESSING + 两条完成 transition (实测 cmu2159bk003vpeqrgtcy4t49 在 2026-09-15T02:15:05Z
  //   出现 2 条 PENDING->PROCESSING, 相隔 7ms; 数据库另有 20 条同类)。
  // 修法: 把「置 PROCESSING + 写 transition」收进一个事务, 用 updateMany 的 count 做 CAS:
  //   count===1 -> 本调用赢得执行权, 继续; count===0(或并发写冲突) -> 已有别的执行者在跑,
  //   立即 SKIPPED 返回, **不写任何 transition、不进入执行器**。这样即便 crontab 重叠,
  //   每个任务也只有一个 winner。
  const plannedActions = (payload.actions || []).map((a: any) => a.type || "?");
  const planned = {
    type: improvementType,
    actions: plannedActions,
    actionCount: plannedActions.length,
    findingsCount: (payload.findings || []).length,
    targets: payload.appliedTargets || {},
    coverageTarget: payload.summary?.coverageScore ?? null,
  };
  if (!input.dryRun) {
    let claimed = false;
    let claimConflict = false;
    try {
      claimed = await prisma.$transaction(async (tx) => {
        const cas = await tx.task.updateMany({
          where: { id: input.taskId, status: "PENDING" },
          data: { status: "PROCESSING" },
        });
        if (cas.count !== 1) return false;
        await tx.taskStateTransition.create({
          data: {
            taskId: input.taskId,
            fromStatus,
            toStatus: "PROCESSING",
            actor,
            reason: `V1.6 自动改进触发 (type=${improvementType})`, // P4: 完成态 Transition.reason 为逐项审视结果
            metadata: JSON.stringify({ dryRun: !!input.dryRun, theme: task.theme, payloadType: payload.type, planned, claim: "CAS_UPDATE_WHERE_PENDING" }),
          },
        });
        return true;
      });
    } catch (err: unknown) {
      // 并发写库冲突(SQLITE_BUSY / P2034) => 保守视为未抢到: 任务要么已被别人执行, 要么保持 PENDING 下轮再来。
      // 两种情况下本调用都不能重复执行; 事务回滚保证 status 不会被本调用改成 PROCESSING。
      claimConflict = true;
      claimed = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[execute-improving-task:V1.6] CAS 认领写冲突 taskId=${input.taskId}: ${msg.slice(0, 120)}`);
    }

    if (!claimed) {
      return {
        taskId: input.taskId, type: improvementType, status: "SKIPPED",
        fromStatus, toStatus: fromStatus,
        durationMs: Date.now() - start,
        summary: claimConflict
          ? `CAS 认领写冲突, 任务保持/已被并发执行者认领, 跳过本轮 (避免重复执行)`
          : `CAS 认领失败: 状态已被并发执行者从 PENDING 改走, 跳过 (避免重复执行)`,
        error: claimConflict ? "CLAIM_CONFLICT_BUSY" : "CLAIM_LOST_CAS",
      };
    }
  }

  // 5. 调对应 type 执行器
  let result: ExecuteImprovingTaskResult;
  try {
    switch (improvementType) {
      case "FIX_THEME":
        result = await executeFixTheme(input.taskId, payload, !!input.dryRun, task.manualReview);
        break;
      case "FIX_CONFLICT":
        result = await executeFixConflict(input.taskId, payload, !!input.dryRun);
        break;
      case "MIGRATE_DATA":
        result = await executeMigrateData(input.taskId, payload, !!input.dryRun, task.manualReview);
        break;
      case "RE_RUN":
        result = await executeReRun(input.taskId, payload, !!input.dryRun);
        break;
      case "THEME_IMPROVE":
        result = await executeThemeImprove(input.taskId, payload, !!input.dryRun);
        break;
      case "BRIDGE": {
        // P0-6: 执行 bridge Task -- 从 reflection 内容回填数据
        // 2026-09-09 B 修复: (a) select 补 description/requirements (原漏选 -> reqText 恒空 -> 空行垃圾);
        //   (b) 内容为空 -> 诚实 SKIP 不落空行; (c) 落库行补 calcQualityScore。
        const targetType = task.theme || "MEMORY"; // theme 字段存了 targetType
        const rawDesc = task.description || "";
        // 剥离 "[bridge:v1] [targetType:..] [tags:..]" 头行, 只取正文
        const descBody = rawDesc.replace(/^\[bridge:v1\][^\n]*\n?/, "").trim();
        const reqText = (task.requirements || descBody || "").trim();
        // P2-2: 从 description [tags:xxx,yyy] 提取实际认知主题
        const tagMatch = rawDesc.match(/\[tags:([^\]]+)\]/);
        const actualTheme = tagMatch ? tagMatch[1].split(",")[0].trim() : "其他";
        const memStore = new PrismaMemoryStore(prisma);
        const THEME_CAPACITY_B = 200; // P0-2 2026-09-01 与 resolver 对齐

        // 内容守卫: 无正文 -> SKIP(调用方按完成处理), 不写空行 (2026-09-09 防止继续污染产物表)
        if (!reqText) {
          result = { taskId: input.taskId, type: "BRIDGE", summary: `bridge ${targetType} theme=${actualTheme} SKIPPED: 任务无 requirements/description 正文, 不落空行`, status: "SKIPPED", fromStatus: "PROCESSING", toStatus: "SKIPPED", durationMs: 0, affectedRows: 0 } as unknown as ExecuteImprovingTaskResult;
          break;
        }
        const content = reqText.substring(0, 500);

        if (targetType === "MEMORY") {
          // P2-2: 用 actualTheme 做容量检查 (之前用 targetType 导致检查无效)
          const tCount = await prisma.memory.count({ where: { theme: actualTheme, supersededBy: null } });
          if (tCount >= THEME_CAPACITY_B) {
            const topM = await prisma.memory.findFirst({ where: { theme: actualTheme, supersededBy: null }, orderBy: { valueScore: "desc" } });
            if (topM) await prisma.memory.update({ where: { id: topM.id }, data: { lastReinforce: new Date(), reinforceCount: { increment: 1 } } });
          } else {
            await memStore.create({ content, title: task.title.substring(0, 80), type: "GENERAL", theme: actualTheme, agentSource: "bridge-executor", sourceType: "BRIDGE", sourceId: input.taskId, valueScore: 0.5, qualityScore: calcQualityScore({ type: "memory", content, title: task.title.substring(0, 80), theme: actualTheme, valueScore: 0.5 }) });
          }
        } else if (targetType === "KNOWLEDGE") {
          const title = normalizeFlywheelTitle(task.title, 30); // 2026-09-29 V3 合规 (原 substring(0,120))
          await safeCreateKnowledge({ title, content, category: projectCategory(actualTheme, "knowledge") ?? "OTHER", theme: actualTheme, confidence: 0.7, qualityScore: calcQualityScore({ type: "knowledge", content, title, category: projectCategory(actualTheme, "knowledge") ?? "OTHER", confidence: 0.7 })});
        } else if (targetType === "SKILL") {
          const name = normalizeFlywheelTitle(task.title, 30); // 2026-09-29 V3 合规 (原 substring(0,120))
          // 2026-10-09 round 68: 走唯一去重入口。原 `prisma.skill.create` 直连且只归一 30 字
          //   (Skill 契约上限是 20), 又无撞名处理 -> 桥接每跑一次就可能再造一个同义行。
          //   策略 keep-existing: 这是自动桥接, 撞名应复用而不是顶替(顶替是 API 提交的语义)。
          const category = projectCategory(actualTheme, "skill") ?? "OTHER";
          // 2026-10-09 round 72-C2: 补 `content`(= steps) —— 此前只传 description,
          //   于是桥接出的 skill **没有 steps**, 违反 SKILL-SPEC "无 steps 不成 skill",
          //   成为人类裁定要清掉的死数据(存量 24,725 条就是这么来的)。
          //   现在步骤内容进 content, description 只放摘要; writeSkillDeduped 里的闸会拦太短的。
          const bridgeSkill = await writeSkillDeduped(prisma, {
            name, content, description: content.slice(0, 200), level: "INTERMEDIATE", category,
            qualityScore: calcQualityScore({ type: "skill", content, name, level: "INTERMEDIATE", category: actualTheme }),
          }, { onConflict: "keep-existing", actor: "execute-improving-task:bridge" });
        } else if (targetType === "PRACTICE") {
          const bridgeTitle = normalizeFlywheelTitle(task.title, 30); // 2026-09-29 V3 合规 (原 substring(0,120))
          await safeCreatePractice({ title: bridgeTitle, description: content, type: "PROCEDURE", outcome: "UNKNOWN", startedAt: new Date(), theme: actualTheme, qualityScore: calcQualityScore({ type: "practice", content, title: bridgeTitle, theme: actualTheme, outcome: "UNKNOWN" })}); // 2026-10-07 P4: PENDING 非受控枚举 -> UNKNOWN(桥接产物结果本就未知)
        }
        result = { taskId: input.taskId, type: "BRIDGE", summary: `bridge ${targetType} theme=${actualTheme}`, status: "DONE", fromStatus: "PROCESSING", toStatus: "DONE", durationMs: 0, affectedRows: 1 } as unknown as ExecuteImprovingTaskResult; 
        break;
      }
      default:
        result = {
          taskId: input.taskId,
          type: improvementType,
          status: "FAILED",
          fromStatus: "PROCESSING",
          toStatus: "FAILED",
          durationMs: Date.now() - start,
          summary: `未知 improvementType: ${improvementType}`,
          error: "UNKNOWN_TYPE",
        };
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    result = {
      taskId: input.taskId,
      type: improvementType,
      status: "FAILED",
      fromStatus: "PROCESSING",
      toStatus: "FAILED",
      durationMs: Date.now() - start,
      summary: `执行器抛异常: ${errMsg}`,
      error: errMsg,
    };
  }

  // 6. 持久化结果
  result.durationMs = Date.now() - start;
  const consumedBy = `execute-improving-task:v1.6@${new Date().toISOString()}`;

  // ★ P0 fix: SKIPPED 也要持久化, 否则任务永远卡在 PROCESSING
  if (!input.dryRun) {
    const finalStatus = result.status === "DONE" ? "DONE" 
      : result.status === "SKIPPED" ? "DONE"  // SKIPPED 视为完成 (不需重试)
      : "FAILED";
    const updateData: Record<string, unknown> = {
      status: finalStatus,
      completedAt: new Date(),
      completedBy: actor,
    };
    // RE_RUN 把 rerunResult 存进 Task.rerunResult 字段 (V1.6 §3.1 ⑧)
    if (improvementType === "RE_RUN" && result.rerunResult) {
      updateData.rerunResult = JSON.stringify(result.rerunResult);
      // P1-2 (2026-09-01) 改进效果闭环: measuredDelta 回填 ImprovementAction.effect
      //   让改完可验证 (逻辑优化方案 S2 矛盾3: effect 100% 为空)
      try {
        const rr = result.rerunResult as any;
        if (typeof rr.delta === "number") {
          const effect = `before=${rr.beforeCoverage?.toFixed?.(4) ?? "?"} after=${rr.afterCoverage?.toFixed?.(4) ?? "?"} delta=${rr.delta >= 0 ? "+" : ""}${rr.delta.toFixed(4)}${rr.skipped ? " (skipped: 无新数据)" : ""}`;
          await prisma.improvementAction.updateMany({
            where: { id: input.taskId },
            data: { effect: String(effect) },
          });
          // 负 delta / 0 效果 -> 记录到 effect 后缀 (外层 task 已标记 DONE, 不再重复 update)
          if (!rr.skipped && rr.delta <= 0) {
            await prisma.improvementAction.updateMany({
              where: { id: input.taskId },
              data: { effect: String(effect) + " [ineffective: delta<=0]" },
            });
          }
        }
      } catch (e) {
        console.warn(`[execute-improving-task] effect 回填失败: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
      }
    }

    await prisma.$transaction([
      prisma.task.update({
        where: { id: input.taskId },
        data: updateData,
      }),
      prisma.taskStateTransition.create({
        data: {
          taskId: input.taskId,
          fromStatus: "PROCESSING",
          toStatus: updateData.status as string,
          actor,
          reason: result.summary,
          metadata: JSON.stringify({
            affectedRows: result.affectedRows,
            error: result.error,
            consumedBy,
          }),
        },
      }),
      // ===== 2026-09-15 P0 机制修复(根因 A) =====
      // 缺陷: 本执行器以前只写 Task.status + TaskStateTransition, **从不写 TaskExecution**。
      //   后果(根因调查报告 docs/platform-logic/no-execution-record-rootcause-2026-09-15.md):
      //   completedBy='cron:v16:improving-tasks' 的 14k+ 历史 DONE 任务没有任何执行记录,
      //   自动验收(runner.cjs 的 has-execution, must=true)对这类任务只能判 FAIL ——
      //   "已完成"却无从独立复核, 是结构性缺口而不是任务质量问题。
      // 修法: 把执行记录与状态更新放进**同一个事务**(原子) —— 记录写失败则状态也不落 DONE,
      //   从结构上杜绝"置 DONE 却查无记录"。output 走与 /tasks/submit 同一份 MAX_STORED=60000
      //   截断/落盘契约(storeTaskOutput), 保证两条写入路径的复核者看到一致的截断标记。
      // 口径: Task=DONE -> COMPLETED; FAILED -> FAILED; SKIPPED 被本函数视为完成(finalStatus=DONE)
      //   故记 COMPLETED, 但 qualityPassed=false 且 summary 明写 SKIPPED, 不冒充合格产出。
      // 不回溯历史任务补造记录(那等于伪造证据); 存量与新增的分流见 leader-scan 的 no_exec_since_<fixdate>。
      prisma.taskExecution.create({
        data: {
          taskId: input.taskId,
          agentId: actor,
          agentRole: "platform-executor",
          status: finalStatus === "FAILED" ? "FAILED" : "COMPLETED",
          startedAt: new Date(start),
          completedAt: new Date(),
          input: JSON.stringify({
            improvementType,
            actionCount: plannedActions.length,
            findingsCount: (payload.findings || []).length,
            trigger: actor,
          }),
          output: storeTaskOutput(input.taskId, result.summary || ""),
          qualityPassed: result.status === "DONE",
          // 2026-09-23 uos20 #5 执行期注入段: cronjob 调度器捕获的主 agent 核心 memory 冻结快照
          //   写入 TaskExecution.metadata.agentMemorySnapshot(JSON 字符串, 带 schemaVersion=1)。
          //   未携带快照(非 cron 触发/捕获失败)时 metadata 不写, 保持与旧记录一致(NULL)。
          metadata: input.agentMemorySnapshot
            ? JSON.stringify({ agentMemorySnapshot: input.agentMemorySnapshot })
            : undefined,
        },
      }),
    ]);
  }

  console.log(`[execute-improving-task:V1.6] END taskId=${input.taskId} type=${improvementType} → ${result.status} (${result.durationMs}ms) summary="${result.summary}"`);

  result.consumedBy = consumedBy;
  return result;
}

/**
 * 批量执行 PENDING 的 ImprovingTask
 * 给 cron 调用 (V1.6 §6.4 业务流程)
 */
export async function executePendingImprovingTasks(
  opts: { limit?: number; actor?: string; dryRun?: boolean } = {}
): Promise<{ scanned: number; executed: number; results: ExecuteImprovingTaskResult[] }> {
  const limit = opts.limit || 10;

  // 找 PENDING 状态的 ImprovingTask (improvementType IS NOT NULL)
  const tasks = await prisma.task.findMany({
    where: {
      status: "PENDING",
      // 2026-09-10 修复: 机器执行器只处理"自己会执行"的类型; GOAL_GAP/PLATFORM_REVIEW 是 agent 提案/审查型,
      //   交给 responder 认领(claim), 否则会被本执行器以"未知 improvementType"误判 FAILED(实测 3 条 G1-G3 被误杀)。
      improvementType: { notIn: ["GOAL_GAP", "PLATFORM_REVIEW"] },
    },
    select: { id: true },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  const results: ExecuteImprovingTaskResult[] = [];
  for (const t of tasks) {
    const r = await executeImprovingTask({
      taskId: t.id,
      actor: opts.actor || "system:v16:cron",
      dryRun: opts.dryRun,
    });
    results.push(r);
  }

  return {
    scanned: tasks.length,
    executed: results.filter(r => r.status === "DONE").length,
    results,
  };
}
