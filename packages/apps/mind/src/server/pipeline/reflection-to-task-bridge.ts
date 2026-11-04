/**
 * reflection-to-task-bridge — V1 §15.2.2 阶段交付
 *
 * 修飞轮洞 1: reflection 不会自动变成 task
 *
 * 触发逻辑:
 *   - 扫 status=OPEN 的 reflection
 *   - 满足任一条件就生成 task:
 *     1) priority IN ('P0', 'P1')            — 高优先级必触发
 *     2) improvements LIKE '%gap%'           — V1 §15.2.2 明确写的 "gap"
 *     3) improvements LIKE '%未解%'          — 中文
 *     4) improvements LIKE '%未覆盖%'        — 中文
 *     5) actionType = 'CREATE_TASK'         — 显式标记
 *
 * 防重复:
 *   - 检查 Task 表 sourceReflectionId 唯一, 已存在则跳过
 *
 * 字段映射 (V1 §15.2.2 + §15.2.3 准备):
 *   - task.title         ← reflection.title
 *   - task.description   ← reflection.description || lesson || improvements
 *   - task.priority      ← reflection.priority
 *   - task.targetType    ← 推 (MEMORY / KNOWLEDGE / SKILL / PRACTICE), 给 §15.2.3 回填 scanner 用
 *   - task.tags          ← reflection.theme + actionType 逗号拼接
 *   - task.bridgeTriggered = true
 *
 * 真验 (§15.2.2): 一周内 ≥3 条 reflection 自动变 task
 */

import { prisma } from "@/lib/prisma";

const TRIGGER_PRIORITIES = ["P0", "P1", "P2"]; // P0-6: 放宽 P2 触发 (之前 P2 占 75% 全跳过)
const TRIGGER_TAG_PATTERNS = ["%gap%", "%未解%", "%未覆盖%", "%改进%", "%优化%", "%修复%", "%问题%"]; // P0-6: 扩大关键词匹配

interface BridgeResult {
  scanned: number;
  triggered: number;
  skipped: number;
  tasks: Array<{ taskId: string; reflectionId: string; reason: string }>;
}

function shouldTrigger(reflection: {
  priority: string | null;
  improvements: string | null;
  actionType: string | null;
}): { triggered: boolean; reason: string } {
  // P0/P1 必触发
  if (reflection.priority && TRIGGER_PRIORITIES.includes(reflection.priority)) {
    return { triggered: true, reason: `priority=${reflection.priority}` };
  }

  // 显式 actionType
  if (reflection.actionType === "CREATE_TASK") {
    return { triggered: true, reason: `actionType=CREATE_TASK` };
  }

  // improvements 内容含 gap/未解/未覆盖
  if (reflection.improvements) {
    const imp = reflection.improvements.toLowerCase();
    for (const pat of TRIGGER_TAG_PATTERNS) {
      const patLower = pat.toLowerCase().replace(/%/g, "");
      if (imp.includes(patLower)) {
        return { triggered: true, reason: `improvements contains "${patLower}"` };
      }
    }
  }

  return { triggered: false, reason: "no trigger" };
}

/** 根据 reflection 内容推断回填目标类型 (§15.2.3 准备) */
function inferTargetType(reflection: {
  actionType: string | null;
  improvements: string | null;
}): "MEMORY" | "KNOWLEDGE" | "SKILL" | "PRACTICE" | null {
  if (!reflection.actionType) return null;
  switch (reflection.actionType) {
    case "CREATE_TASK":
      return "PRACTICE";
    case "UPDATE_SKILL":
      return "SKILL";
    case "ADD_KNOWLEDGE":
      return "KNOWLEDGE";
    case "ALERT":
      return "MEMORY";
    default:
      return null;
  }
}

export async function runReflectionToTaskBridge(options: {
  limit?: number;
  dryRun?: boolean;
  signal?: AbortSignal;  // P0-3: route 层 withCronTimeout 注入, 提前 break
} = {}): Promise<BridgeResult> {
  const limit = options.limit ?? 100;
  const dryRun = options.dryRun ?? false;
  const signal = options.signal;

  // 1. 拉 OPEN 状态 reflection, P0/P1 优先 (因为 P2 默认全跳过)
  // P5 (2026-07-12): 加 CASE 排序 — 之前 ORDER BY id DESC LIMIT 100 全扫到 P2, 100% skipped
  const reflections = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      title: string;
      description: string | null;
      priority: string | null;
      improvements: string | null;
      actionType: string | null;
      theme: string | null;
    }>
  >(
    `SELECT id, title, description, priority, improvements, actionType, theme
     FROM Reflection
     WHERE status = 'OPEN'
       AND id NOT LIKE 'cma%'
     ORDER BY
       CASE priority
         WHEN 'P0' THEN 0
         WHEN 'P1' THEN 1
         WHEN 'P2' THEN 2
         WHEN 'P3' THEN 3
         ELSE 4
       END ASC,
       id DESC
     LIMIT ?`,
    limit
  );

  const tasks: BridgeResult["tasks"] = [];
  let triggered = 0;
  let skipped = 0;

  for (const r of reflections) {
    // P0-3: route 层 abort 后, 不再处理新 reflection
    if (signal?.aborted) {
      console.warn(`[reflection-bridge] signal aborted at reflectionId=${r.id}, break`);
      break;
    }
    const { triggered: should, reason } = shouldTrigger(r);
    if (!should) {
      skipped++;
      continue;
    }

    // 防重复: 检查是否已存在
    const existing = await prisma.task.findFirst({
      where: { sourceReflectionIds: r.id },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const targetType = inferTargetType(r);
    const tags = [r.theme, r.actionType].filter(Boolean).join(",");
    const description =
      r.description || r.improvements || r.title || "(无描述)";

    if (dryRun) {
      tasks.push({ taskId: "(dry-run)", reflectionId: r.id, reason });
      triggered++;
      continue;
    }

    // 3. 创建 task — 适配 monorepo Task 模型 (V1 §15.2.2 / Phase 1)
    //    monorepo Task 必填: background/requirements/materials/acceptanceCriteria/qualityStandards
    //    Phase 0 字段 (targetType/tags/bridgeTriggered) 不存在, 编码到 description / theme 元数据
    const meta = `[bridge:v1] [targetType:${targetType}] [tags:${tags}]`;
    const fullDesc = `${meta}\n\n${description.substring(0, 1800)}`;
    const task = await prisma.task.create({
      data: {
        title: r.title,
        description: fullDesc.substring(0, 2000),
        background: `源自 reflection: ${r.title} (${reason})`,
        requirements: r.improvements || description.substring(0, 500) || "见 description",
        materials: (r as any).lesson || "",
        acceptanceCriteria: "完成本 task 后能在对应类别 (Memory/Knowledge/Skill/Practice) 看到回填条目",
        qualityStandards: "回填条目 description 含 [task:<id>] 标记, FlywheelEvent 留痕",
        status: "PENDING",
        priority: r.priority || "P2",
        sourceReflectionIds: r.id,
        theme: targetType, // 借 theme 字段记录 targetType 路由
        improvementType: "BRIDGE", // P0-6: 设置 improvementType 让 improving-tasks-cron 能执行
      },
      select: { id: true },
    });

    // 4. 标记 reflection 为处理中 (status: OPEN -> ACTIVE, 不删 reflection)
    await prisma.$executeRawUnsafe(
      `UPDATE Reflection SET status = 'ACTIVE', updatedAt = ? WHERE id = ?`,
      new Date(),
      r.id
    );

    tasks.push({ taskId: task.id, reflectionId: r.id, reason });
    triggered++;
  }

  // 5. 飞轮事件 (审计 + §15.2.4 面板统计)
  if (triggered > 0 && !dryRun) {
    await prisma.flywheelEvent.create({
      data: {
        stage: "REFLECTION_TO_TASK",
        sourceType: "Reflection",
        sourceId: "batch",
        sourceTitle: `bridge: ${triggered} reflections → tasks`,
        targetStage: "Task",
        targetType: "Task",
        targetId: tasks[0]?.taskId,
      },
    });
  }

  return {
    scanned: reflections.length,
    triggered,
    skipped,
    tasks,
  };
}