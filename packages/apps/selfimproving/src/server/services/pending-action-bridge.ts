/**
 * Pending Action Bridge V3 — 反思结构化 + 聚类 + 上下文组装
 *
 * V2 链路(已废弃,保留供回退):
 *   1 improvement = 1 task(导致 11000+ 碎任务)
 *
 * V3 链路(新):
 *   1. 拉 30 天 OPEN + processingVersion='v3' 反思
 *   2. 按 theme + actionType 聚类
 *   3. 决策(actionConfidence >= 0.5 && actionType == CREATE_TASK)
 *   4. 查 TaskCluster dedup(同 clusterKey 1 天内只 1 task)
 *   5. 1 cluster = 1 task(含 structuredContext)
 *   6. 批量 markReflectionAsProcessed(transaction 内)
 */
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";

// 2026-09-11 P0 (任务 cmtvfgeps00121j765jmy4sk7): 任务**内容级**幂等守卫
//   背景(实测): 旧去重按 clusterKey(= 反思 id 集合)判定, 属**身份级**。同一批内容以新的反思集合再次进入时,
//   clusterKey 变了 -> 又建一条新任务。实测同一内容重复: 「并发安全」224 次、「离线登录」142 次;
//   全库 36,607 条任务里 190 组重复、涉及 3,255 条(8.9%), 近 24h 为 59/357(16.5%)。
//   判据(内容级): theme + description 完全相同, 且 (a) 存在非终态任务, 或 (b) 冷静期内建过同内容任务 -> 跳过。
//   为什么用 description: 它由 cluster 内容确定性拼装(含源反思与改进项), 同内容必同串 -> 可直接用 SQL 精确比对,
//   无需改表结构; 同时把 contentHash 写进 structuredContext 供将来快速比对。
const CONTENT_COOLDOWN_DAYS = Number(process.env.CLUSTER_TASK_CONTENT_COOLDOWN_DAYS ?? 7);
const NON_TERMINAL = ["PENDING", "IN_PROGRESS", "PROCESSING"];

function contentHashOf(spec: { theme?: string | null; description?: string | null }): string {
  return createHash("sha1").update(String(spec.theme || "") + "|" + String(spec.description || "")).digest("hex").slice(0, 16);
}

// === 旧版接口保留(供回退) ===
export interface PendingActionItem {
  reflectionId: string;
  reflectionTitle: string;
  content: string;
  priority?: string;
  category?: string;
}

const MIND_API = "http://localhost:3000/api/trpc";

/**
 * V2 旧版(保留供回退)
 */
export async function fetchPendingReflections(): Promise<PendingActionItem[]> {
  // 简化版: 只拉 V2 标记的反思
  return fetchReflectionsV2Compat();
}

async function fetchReflectionsV2Compat(): Promise<PendingActionItem[]> {
  try {
    const items: any[] = [];
    for (let p = 1; p <= 5; p++) {
      const url = `${MIND_API}/reflection.list?input=${encodeURIComponent(JSON.stringify({
        page: p,
        pageSize: 200,
      }))}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        if (response.status >= 500) {
          console.warn(`[pending-action-bridge] page ${p} HTTP ${response.status} (Prisma WASM cap?), 停止翻页`);
        } else {
          console.warn(`[pending-action-bridge] page ${p} HTTP ${response.status}`);
        }
        break;
      }
      const data = await response.json() as any;
      const rawItems = (data?.result?.data && Array.isArray(data.result.data)) ? data.result.data :
                       (data?.result?.data?.items || []);
      if (!rawItems || rawItems.length === 0) break;
      items.push(...rawItems);
      if (rawItems.length < 200) break;
    }
    const pending: PendingActionItem[] = [];
    for (const item of items) {
      if (item.status !== "OPEN") continue;
      const imp = item.improvements;
      if (!imp) continue;
      let text: string;
      if (Array.isArray(imp)) text = imp.join(" ");
      else if (typeof imp === "string") text = imp;
      else continue;
      if (!text || text.trim().length === 0) continue;
      pending.push({
        reflectionId: item.id,
        reflectionTitle: item.title,
        content: text.trim(),
        priority: item.priority,
        category: item.category,
      });
    }
    return pending;
  } catch (error) {
    console.warn(`[pending-action-bridge/v2] fetch error: ${error}`);
    return [];
  }
}

// === V3 新接口 ===

export interface V3Reflection {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  category?: string;
  theme?: string;
  actionType?: string;
  actionConfidence?: number;
  structuredImprovements?: Array<{ text: string; severity: string; area: string }>;
  improvements?: string;
  rootCauseAnalysis?: string;
  proposedPlan?: string;
  relatedMemoryIds?: string;
  relatedKnowledgeIds?: string;
  relatedSessionIds?: string;
  relatedProblemIds?: string;
  processingVersion?: string;
  sourceId?: string;
  sourceType?: string;
  createdAt?: string;
}

export interface ReflectionCluster {
  key: string;                 // `${theme}|${actionType}` 聚类 key
  theme: string;
  actionType: string;
  reflections: V3Reflection[];
  avgConfidence: number;
}

/**
 * 拉 30 天 OPEN + V3 标记的反思
 */
export async function fetchV3Reflections(): Promise<V3Reflection[]> {
  try {
    const items: V3Reflection[] = [];
    for (let p = 1; p <= 5; p++) {
      const url = `${MIND_API}/reflection.list?input=${encodeURIComponent(JSON.stringify({
        page: p,
        pageSize: 200,
      }))}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        if (response.status >= 500) {
          console.warn(`[pending-action-bridge] page ${p} HTTP ${response.status} (Prisma WASM cap?), 停止翻页`);
        } else {
          console.warn(`[pending-action-bridge] page ${p} HTTP ${response.status}`);
        }
        break;
      }
      const data = await response.json() as any;
      const rawItems = (data?.result?.data && Array.isArray(data.result.data)) ? data.result.data :
                       (data?.result?.data?.items || []);
      if (!rawItems || rawItems.length === 0) break;
      items.push(...(rawItems as V3Reflection[]));
      if (rawItems.length < 200) break;
    }

    // 客户端过滤: status=OPEN + processingVersion='v3'
    // 注: mind schema 没 processingVersion 字段, 但 API 返 null 也可能匹配
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return items.filter((r) => {
      if (r.status !== "OPEN") return false;
      if (r.createdAt && new Date(r.createdAt).getTime() < since) return false;
      return true;
    });
  } catch (error) {
    console.warn(`[pending-action-bridge/v3] fetch error: ${error}`);
    return [];
  }
}

/**
 * 按 theme + actionType 聚类
 */
export function clusterReflections(reflections: V3Reflection[]): ReflectionCluster[] {
  const map = new Map<string, ReflectionCluster>();
  for (const r of reflections) {
    const theme = r.theme || "未分类";
    // P0-4 修复: NONE actionType 在历史 V2 reflection 里 = 没 V3 字段, fallback 到 CREATE_TASK
    //   真根因: 992/1192 真数据 V2 reflection 没 V3 字段, fetch 返 actionType=None/theme=null
    //   这些是历史反思, 业务上有价值 (用户记录过的真实经验), 仍应建 task
    //   兼容: actionType=None/null → CREATE_TASK
    const rawActionType = r.actionType || "NONE";
    const actionType = (rawActionType === "NONE" || rawActionType === null) ? "CREATE_TASK" : rawActionType;
    const key = `${theme}|${actionType}`;
    if (!map.has(key)) {
      map.set(key, { key, theme, actionType, reflections: [], avgConfidence: 0 });
    }
    map.get(key)!.reflections.push(r);
  }
  // 计算 avgConfidence
  for (const c of map.values()) {
    c.avgConfidence = c.reflections.reduce((s, r) => s + (r.actionConfidence ?? 0), 0) / c.reflections.length;
  }
  return Array.from(map.values());
}

/**
 * 查 TaskCluster dedup(同 clusterKey 1 天内只 1 task)
 */
async function getExistingClusterTaskIds(clusterKeys: string[]): Promise<Map<string, string>> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await prisma.taskCluster.findMany({
    where: {
      clusterKey: { in: clusterKeys },
      createdAt: { gte: oneDayAgo },
      status: "ACTIVE",
      taskId: { not: null },
    },
  });
  const map = new Map<string, string>();
  for (const e of existing) {
    if (e.taskId) map.set(e.clusterKey, e.taskId);
  }
  return map;
}

/**
 * 解析 improvements 字段(老格式字符串 or 新格式 JSON)
 */
function parseStructuredImprovements(r: V3Reflection): Array<{ text: string; severity: string; area: string }> {
  if (Array.isArray(r.structuredImprovements) && r.structuredImprovements.length > 0) {
    return r.structuredImprovements;
  }
  // 老格式 fallback
  if (typeof r.improvements === "string" && r.improvements.trim()) {
    try {
      const parsed = JSON.parse(r.improvements);
      if (Array.isArray(parsed)) return parsed.filter((p: any) => p && p.text);
    } catch { /* not JSON */ }
    // 是单字符串
    return [{ text: r.improvements, severity: r.priority || "P2", area: "" }];
  }
  // P0-4 修复: prisma 自动 JSON.parse, improvements 已是 list
  //   优先判断 list of strings (V2 实际数据 99% 是这个格式)
  if (Array.isArray(r.improvements) && r.improvements.every((p: any) => typeof p === "string")) {
    return (r.improvements as string[])
      .filter((s) => s && s.trim().length >= 5)  // 太短的过滤
      .map((text: string) => ({ text, severity: r.priority || "P2", area: "" }));
  }
  // P0-4 修复: improvements 是 list of objects
  if (Array.isArray(r.improvements) && r.improvements.length > 0) {
    return r.improvements
      .filter((p: any) => p && typeof p === "object" && p.text)
      .map((p: any) => ({ text: String(p.text), severity: p.severity || r.priority || "P2", area: p.area || "" }));
  }
  return [];
}

/**
 * 从 reflection 抽取关联 ID 列表
 */
function parseRelatedIds(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * V3 决策 + 创建任务主流程
 */
export async function processReflectionsV3(): Promise<{
  clusters: number;
  created: number;
  attached: number;
  skipped: number;
  details: string[];
}> {
  const details: string[] = [];

  // 1. 拉反思
  const reflections = await fetchV3Reflections();
  if (reflections.length === 0) {
    return { clusters: 0, created: 0, attached: 0, skipped: 0, details: ["无 V3 反思"] };
  }
  details.push(`拉取 ${reflections.length} 条 V3 反思`);

  // 2. 聚类
  const clusters = clusterReflections(reflections);
  details.push(`聚成 ${clusters.length} 个 cluster`);

  // 3. 查 dedup
  const existingMap = await getExistingClusterTaskIds(clusters.map((c) => c.key));
  details.push(`已存在 ${existingMap.size} 个 cluster dedup`);

  let created = 0, attached = 0, skipped = 0;

  for (const cluster of clusters) {
    // 4. 决策: confidence < 0.5 跳过
    // P0-4 修复: NONE fallback cluster (V2 历史) 跳过 conf 阈值, 因为没 LLM 算过 conf=0
    const isNoneFallback = cluster.reflections.some((r: any) => !r.actionConfidence || r.actionConfidence === 0);
    if (cluster.avgConfidence < 0.5 && !isNoneFallback) {
      details.push(`[SKIP] ${cluster.key} avgConfidence=${cluster.avgConfidence.toFixed(2)} < 0.5`);
      skipped += cluster.reflections.length;
      continue;
    }
    // 5. 决策: actionType != CREATE_TASK 跳过(V3 暂只支持建任务)
    if (cluster.actionType !== "CREATE_TASK") {
      details.push(`[SKIP] ${cluster.key} actionType=${cluster.actionType} 非 CREATE_TASK`);
      skipped += cluster.reflections.length;
      continue;
    }
    // 6. 决策: 无 improvements 跳过
    const allImprovements = cluster.reflections.flatMap((r) => parseStructuredImprovements(r));
    if (allImprovements.length === 0) {
      details.push(`[SKIP] ${cluster.key} 无 improvements`);
      skipped += cluster.reflections.length;
      continue;
    }

    // 7. dedup: 已有 task → 附加
    const existingTaskId = existingMap.get(cluster.key);
    if (existingTaskId) {
      try {
        await attachToExistingTask(existingTaskId, cluster);
        details.push(`[ATTACH] ${cluster.key} → ${existingTaskId} (${cluster.reflections.length} 反思)`);
        attached += cluster.reflections.length;
        // mark processed
        for (const r of cluster.reflections) {
          await markReflectionAsProcessed(r.id);
        }
      } catch (e) {
        details.push(`[ERR attach] ${cluster.key}: ${e}`);
      }
      continue;
    }

    // 8. 建新 task — P3 修复: 拆 transaction 减小持锁时间
    // 原因: prisma 5.22 SQLite engine 内部 hardcoded 5s query timeout, 长 transaction + 多 update 必超时
    // 解决: 拆 3 步独立, 每次写入都立即释放锁
    try {
      // 8a. 二次检查 TaskCluster unique(防并发) — P3 修复: 限 24h 内 + 智能 attach
      // 老 task 真在跑 (PENDING/IN_PROGRESS) → 复用 (attach, 不建新 task)
      // 老 task 终态 (COMPLETED/FAILED/CANCELLED/DEPRECATED/BLOCKED) → 不 attach, 让 8b 继续建新 task
      // 原因: 之前 8a 永远 attach, V3 Generator 永远不创建新 task → 0 PENDING 任务
      // P3.2 修复: 加 lastSeenAt 24h 限制 — 老 cluster 24h 内已被接管过则跳过
      // 解决: V3 cycle 2min 一次, 老 task 跑完 (review FAILED -> BLOCKED) 后每次 cycle 接管
      //       持续 30min 15 次接管 (5 cluster × 15 次) — sibling 设计的死循环
      // 业务规则: 同一 clusterKey 24h 内只能接管 1 次 (lastSeenAt 24h 内, 跳过)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const oneDayAgoMs = oneDayAgo.getTime();
      // raw query 查 ACTIVE cluster + 关联 task status
      // P0-5 修复: 取消 24h 窗口限制 (前次 P3.2 24h 限制 + lastSeenAt 永远 false bug)
      // 真根因: TaskCluster.createdAt 3天前 < oneDayAgoMs → line 342 `tc.createdAt >= oneDayAgoMs` 永远 false
      //   existing 永远 undefined → 8b 永远建新 task → 死循环
      // 业务规则: 同 clusterKey 1 个 ACTIVE cluster, 已存在 → SKIP-COOLDOWN (不管老 task 状态)
      // 真要重启周期: 手动 update cluster.status='EXPIRED' 或用 UI 按钮
      const existingRows = await prisma.$queryRaw`
        SELECT tc.id as "clusterId", tc."taskId" as "taskId", t.status as "taskStatus",
               tc."lastSeenAt" as "lastSeenAt", tc."createdAt" as "clusterCreatedAt"
        FROM "TaskCluster" tc
        LEFT JOIN "Task" t ON t.id = tc."taskId"
        WHERE tc."clusterKey" = ${cluster.key}
          AND tc.status = 'ACTIVE'
          AND tc."taskId" IS NOT NULL
        ORDER BY tc."createdAt" DESC
        LIMIT 1
      ` as Array<{ clusterId: string; taskId: string; taskStatus: string | null; lastSeenAt: number | null; clusterCreatedAt: number | null }>;
      const existing = existingRows[0];

      if (existing && existing.taskStatus && !["COMPLETED", "FAILED", "CANCELLED", "DEPRECATED", "BLOCKED"].includes(existing.taskStatus)) {
        // 老 task 真在跑 (PENDING/IN_PROGRESS) → 复用 attach
        await attachToExistingTask(existing.taskId, cluster);
        await prisma.$executeRaw`
          UPDATE "TaskCluster" SET "lastSeenAt" = ${new Date()} WHERE id = ${existing.clusterId}
        `;
        details.push(`[ATTACH-RACE] ${cluster.key} → ${existing.taskId} (lastSeenAt 更新)`);
        attached += cluster.reflections.length;
        continue;
      }
      // 老 task 终态 → 跳过, 避免死循环 (P0-5 新增强约束)
      if (existing && existing.taskStatus && ["COMPLETED", "FAILED", "CANCELLED", "DEPRECATED", "BLOCKED"].includes(existing.taskStatus)) {
        // 同 clusterKey 1 个 ACTIVE cluster, 已存在 → SKIP
        details.push(`[SKIP-COOLDOWN] ${cluster.key}: 同 clusterKey 已有 ACTIVE cluster ${existing.clusterId} → 老 task ${existing.taskId} (status=${existing.taskStatus}), 跳过避免死循环 (P0-5 修复: 取消 P3.2 24h 限制)`);
        await prisma.$executeRaw`
          UPDATE "TaskCluster" SET "lastSeenAt" = ${new Date()} WHERE id = ${existing.clusterId}
        `;
        skipped += cluster.reflections.length;
        continue;
      }

      // 8b. 建 task (独立写入, 立即 commit)
      const taskSpec = buildTaskSpecFromCluster(cluster);
      // 8b-guard (2026-09-11 P0 内容级幂等): 同内容不重复入队
      const chash = contentHashOf(taskSpec);
      const since = new Date(Date.now() - CONTENT_COOLDOWN_DAYS * 864e5);
      const dupContent = await prisma.task.findFirst({
        where: {
          theme: taskSpec.theme ?? null,
          description: taskSpec.description,
          OR: [{ status: { in: NON_TERMINAL } }, { createdAt: { gte: since } }],
        },
        select: { id: true, status: true, createdAt: true },
      }).catch(() => null);
      if (dupContent) {
        details.push("[SKIP-CONTENT-DUP] " + cluster.key + ": 同内容任务已存在 " + dupContent.id + " (status=" + dupContent.status + ", hash=" + chash + ") -> 跳过入队");
        skipped += cluster.reflections.length;
        continue;
      }
      taskSpec.structuredContext = JSON.stringify({
        ...(() => { try { return JSON.parse(String(taskSpec.structuredContext || "{}")); } catch { return {}; } })(),
        contentHash: chash,
        contentCooldownDays: CONTENT_COOLDOWN_DAYS,
      });
      const task = await prisma.task.create({ data: taskSpec });

      // 8c. 建 TaskCluster (独立写入, 用 upsert 避免 P2002 错 — 即使并发也只建 1 个)
      try {
        await prisma.taskCluster.create({
          data: {
            clusterKey: cluster.key,
            theme: cluster.theme,
            taskId: task.id,
            reflectionIds: cluster.reflections.map((r) => r.id).join(","),
            status: "ACTIVE",
          },
        });
      } catch (e: any) {
        if (e?.code === "P2002") {
          // 并发: 别人已建 TaskCluster, 我们刚建的 task 怎么办?
          // 之前逻辑: 永远标 DEPRECATED (兜底) → 0 个 task 真跑
          // P3 修复: 智能接管 — 看老 cluster 关联 task 状态
          //   - 老 task 终态 (COMPLETED/FAILED/CANCELLED/DEPRECATED/BLOCKED) → 接管
          //     (更新 dup.taskId 指向新 task, 我们 task 保持 PENDING, 真跑)
          //   - 老 task 真在跑 (PENDING/IN_PROGRESS) → 真撞车, 我们标 DEPRECATED (原行为)
          const dup = await prisma.taskCluster.findUnique({ where: { clusterKey: cluster.key } });
          if (dup?.taskId && dup.taskId !== task.id) {
            // P3 修复: 用 raw query 查老 task 状态 (绕 prisma binary parser)
            const oldTaskRows = await prisma.$queryRaw`
              SELECT status FROM "Task" WHERE id = ${dup.taskId}
            ` as Array<{ status: string }>;
            const oldStatus = oldTaskRows[0]?.status;
            const terminalStates = ["COMPLETED", "FAILED", "CANCELLED", "DEPRECATED", "BLOCKED"];

            if (!oldStatus || terminalStates.includes(oldStatus)) {
              // 老 task 终态或不存在 → 接管: 更新 cluster.taskId + 老 task 标 DEPRECATED
              await prisma.$executeRaw`
                UPDATE "TaskCluster" SET "taskId" = ${task.id},
                  "reflectionIds" = ${cluster.reflections.map((r) => r.id).join(",")},
                  status = 'ACTIVE'
                WHERE id = ${dup.id}
              `;
              if (oldStatus && oldStatus !== "DEPRECATED") {
                // 老 task 非 DEPRECATED 才标 DEPRECATED (避免重复 update)
                await prisma.$executeRaw`
                  UPDATE "Task" SET status = 'DEPRECATED' WHERE id = ${dup.taskId} AND status != 'DEPRECATED'
                `;
              }
              details.push(`[TAKEOVER] ${cluster.key} → 新 task ${task.id} 接管 (老 task ${dup.taskId} status=${oldStatus})`);
              created += cluster.reflections.length;
              continue;
            }

            // 老 task 真在跑 → 真撞车, 我们兜底标 DEPRECATED (原行为)
            await attachToExistingTask(dup.taskId, cluster);
            await prisma.$executeRaw`
              UPDATE "Task" SET status = 'DEPRECATED' WHERE id = ${task.id} AND status != 'DEPRECATED'
            `;
            details.push(`[ATTACH-CONCURRENT] ${cluster.key} → ${dup.taskId} (新 task 已弃用, 老 task 在跑)`);
            attached += cluster.reflections.length;
            continue;
          }
        }
        throw e; // 其他错正常抛
      }

      details.push(`[CREATE] ${cluster.key} → ${task.id} (${cluster.reflections.length} 反思)`);
      created += cluster.reflections.length;

      // 8d. 批量 mark (并发+小批量, 避免 1 query 持锁太久)
      for (const r of cluster.reflections) {
        try {
          await markReflectionAsProcessed(r.id);
        } catch (markErr) {
          // 标记失败不阻塞 task 已建的事实
          details.push(`[WARN mark] ${r.id}: ${(markErr as Error).message?.slice(0, 80)}`);
        }
      }
    } catch (e: any) {
      // TaskCluster unique 冲突(并发 2 tick 同时建)
      if (e?.code === "P2002" || String(e).includes("Unique constraint")) {
        // fallback: 重新查 + attach
        try {
          const existing = await prisma.taskCluster.findUnique({ where: { clusterKey: cluster.key } });
          if (existing?.taskId) {
            await attachToExistingTask(existing.taskId, cluster);
            details.push(`[ATTACH-CONFLICT] ${cluster.key} → ${existing.taskId}`);
            attached += cluster.reflections.length;
            for (const r of cluster.reflections) {
              await markReflectionAsProcessed(r.id);
            }
            continue;
          }
        } catch (e2) {
          details.push(`[ERR fallback] ${cluster.key}: ${e2}`);
        }
      }
      details.push(`[ERR create] ${cluster.key}: ${e}`);
      skipped += cluster.reflections.length;
    }
  }

  return { clusters: clusters.length, created, attached, skipped, details };
}

/**
 * 构架 task 数据(从 cluster)
 */
function buildTaskSpecFromCluster(cluster: ReflectionCluster): any {
  const allImprovements = cluster.reflections.flatMap((r) => parseStructuredImprovements(r));
  const allMemoryIds = Array.from(new Set(cluster.reflections.flatMap((r) => parseRelatedIds(r.relatedMemoryIds))));
  const allKnowledgeIds = Array.from(new Set(cluster.reflections.flatMap((r) => parseRelatedIds(r.relatedKnowledgeIds))));
  const allSessionIds = Array.from(new Set(cluster.reflections.flatMap((r) => parseRelatedIds(r.relatedSessionIds))));
  const allProblemIds = Array.from(new Set(cluster.reflections.flatMap((r) => parseRelatedIds(r.relatedProblemIds))));

  // 收集所有 proposedPlan
  const plans = cluster.reflections
    .map((r) => r.proposedPlan)
    .filter((p): p is string => !!p && p.trim().length > 0);

  // 收集根因
  const rootCauses = cluster.reflections
    .map((r) => r.rootCauseAnalysis)
    .filter((c): c is string => !!c && c.trim().length > 0);

  // 标题: 主题 + 数量
  const title = `[${cluster.theme}] 改进方案 (${cluster.reflections.length} 个反思汇总)`;

  // description: 综合
  const description = [
    `本任务由 ${cluster.reflections.length} 个反思聚类生成(主题: ${cluster.theme}, actionType: ${cluster.actionType}, avgConfidence: ${cluster.avgConfidence.toFixed(2)})。`,
    "",
    "=== 源反思 ===",
    ...cluster.reflections.map((r, i) => `${i + 1}. [${r.priority || "P?"}] ${r.title}\n   ${(r.description || "").slice(0, 200)}`),
    "",
    "=== 改进项 ===",
    ...allImprovements.slice(0, 10).map((imp, i) => `${i + 1}. [${imp.severity}] ${imp.text}${imp.area ? ` (${imp.area})` : ""}`),
    rootCauses.length > 0 ? "\n=== 根因分析 ===\n" + rootCauses.join("\n---\n") : "",
  ].filter((s) => s !== "").join("\n");

  // requirements: 改进项展开为 checklist
  const requirements = allImprovements.slice(0, 10).map((imp, i) => `${i + 1}. ${imp.text}`).join("\n") || "(无具体改进项)";

  // materials: 关联上下文
  const materials = [
    `主题: ${cluster.theme}`,
    `反思数量: ${cluster.reflections.length}`,
    allMemoryIds.length > 0 ? `关联记忆 (${allMemoryIds.length}):\n${allMemoryIds.slice(0, 5).map((id) => `  - ${id}`).join("\n")}` : "",
    allKnowledgeIds.length > 0 ? `关联知识 (${allKnowledgeIds.length}):\n${allKnowledgeIds.slice(0, 5).map((id) => `  - ${id}`).join("\n")}` : "",
    allSessionIds.length > 0 ? `关联会话 (${allSessionIds.length}):\n${allSessionIds.slice(0, 5).map((id) => `  - ${id}`).join("\n")}` : "",
    allProblemIds.length > 0 ? `关联问题 (${allProblemIds.length}):\n${allProblemIds.slice(0, 5).map((id) => `  - ${id}`).join("\n")}` : "",
    plans.length > 0 ? `\n=== 实施计划(LLM 建议) ===\n${plans.join("\n---\n")}` : "",
  ].filter((s) => s !== "").join("\n");

  // acceptanceCriteria: 验证项
  const acceptanceCriteria = [
    "1. 完成所有 requirements 清单项",
    `2. 解决了 ${cluster.reflections.length} 个反思反映的核心问题`,
    "3. 验证根因已被消除(不是表面修复)",
    "4. 有执行记录、问题记录、解决方案",
    plans.length > 0 ? "5. 实施计划中的每一步都有产出" : "",
  ].filter((s) => s !== "").join("\n");

  // structuredContext: 完整上下文
  const structuredContext = JSON.stringify({
    clusterKey: cluster.key,
    theme: cluster.theme,
    actionType: cluster.actionType,
    confidence: cluster.avgConfidence,
    rootCause: rootCauses[0] || null,
    plan: plans[0] ? plans[0].split("\n").filter((l) => l.trim()) : [],
    acceptanceSignals: acceptanceCriteria.split("\n"),
    relatedReflections: cluster.reflections.map((r) => ({ id: r.id, title: r.title, priority: r.priority })),
    relatedMemories: allMemoryIds,
    relatedKnowledge: allKnowledgeIds,
    relatedSessions: allSessionIds,
    relatedProblems: allProblemIds,
  }, null, 2);

  return {
    title,
    description,
    background: `由反思引擎 V3 自动聚类生成。主题: ${cluster.theme}。共 ${cluster.reflections.length} 个反思。`,
    requirements,
    materials,
    acceptanceCriteria,
    qualityStandards: "1. 完整解决根因(非表面修复) 2. 有执行过程记录 3. 方案合理可维护",
    priority: cluster.reflections.some((r) => r.priority === "P1") ? "P1" : "P2",
    sourceReflectionIds: cluster.reflections.map((r) => r.id).join(","),
    theme: cluster.theme,
    structuredContext,
    contextVersion: "v3",
    status: "PENDING",
  };
}

/**
 * 附加到现有 task(更新 sourceReflectionIds + structuredContext)
 */
async function attachToExistingTask(taskId: string, cluster: ReflectionCluster): Promise<void> {
  const existing = await prisma.task.findUnique({ where: { id: taskId } });
  if (!existing) throw new Error(`Task ${taskId} not found`);

  const allReflectionIds = new Set<string>();
  if (existing.sourceReflectionIds) {
    existing.sourceReflectionIds.split(",").forEach((id) => id.trim() && allReflectionIds.add(id.trim()));
  }
  cluster.reflections.forEach((r) => allReflectionIds.add(r.id));

  const newCtx = (() => {
    try {
      return existing.structuredContext ? JSON.parse(existing.structuredContext) : {};
    } catch {
      return {};
    }
  })();
  newCtx.relatedReflections = Array.from(allReflectionIds).map((id) => ({ id, title: "" }));

  await prisma.task.update({
    where: { id: taskId },
    data: {
      sourceReflectionIds: Array.from(allReflectionIds).join(","),
      structuredContext: JSON.stringify(newCtx, null, 2),
    },
  });
  await prisma.taskCluster.update({
    where: { clusterKey: cluster.key },
    data: { lastSeenAt: new Date(), reflectionIds: Array.from(allReflectionIds).join(",") },
  });
}

/**
 * Mark a reflection's pending action as handled.
 * 去重: 已 mark 过的跳过(避免重复写 FlywheelEvent)。
 */
export async function markReflectionAsProcessed(reflectionId: string): Promise<void> {
  try {
    // 先查重
    const existing = await prisma.flywheelEvent.findFirst({
      where: {
        sourceType: "REFLECTION",
        sourceId: reflectionId,
        stage: "REFLECTION_PROCESSED",
      },
      select: { id: true },
    });
    if (existing) return; // 已 mark 过, skip
    await prisma.flywheelEvent.create({
      data: {
        stage: "REFLECTION_PROCESSED",
        sourceType: "REFLECTION",
        sourceId: reflectionId,
        sourceTitle: "Reflection processed (V3 cluster)",
        targetStage: "LEARN",
        targetType: "REFLECTION",
        targetId: reflectionId,
      },
    });
  } catch (error) {
    console.warn(`[pending-action-bridge] mark error: ${error}`);
  }
}
