/**
 * task-resolved-scanner — V1 §15.2.3 阶段交付
 *
 * 修飞轮洞 2: task resolved 后只回填 memory, 缺 4 类 (memory/knowledge/skill/practice)
 *
 * 真验 (§15.2.3): 4 类都有新增条目
 *
 * 路由逻辑:
 *   1. task.targetType 优先 (Phase 0.2 bridge 已写)
 *   2. 没 targetType 时按 tags 推:
 *      - 包含 "skill" / "能力"          → SKILL
 *      - 包含 "knowledge" / "知识"      → KNOWLEDGE
 *      - 包含 "practice" / "实践"      → PRACTICE
 *      - 其他                            → MEMORY
 *
 * 回填内容 (复用现有 memory/knowledge/skill/practice 模型):
 *   - title       ← task.title
 *   - description ← task.description
 *   - sourceTaskId ← task.id (审计)
 *   - tags        ← task.tags (逗号分隔)
 *
 * 触发: status = 'DONE' 且未回填过 (用 Task.sourceReflectionId + resolved_at 时间戳兜底)
 */

import { prisma } from "@/lib/prisma";

// 2026-09-29 (agent-d 休假期间 round 5) V3 五件套软验证: task-resolved-scanner.ts
//   3 个 create (Memory / Knowledge / Practice) 此前未接 validateFlywheelProduct, 与 S5 同病。
//   仿 execute-improving-task.ts 的 wrapper: 不 drop, 不合规标 stale (保数据, 守门/检索排除)
async function safeCreateKnowledge(data: any) {
  const row = await storeCreateKnowledge(prisma, { data });
  if (!row) { console.warn("[task-resolved-scanner] Knowledge 被 store 内容闸拒绝(不合规), 不落库"); return null; }
  const ok = !PRODUCT_RULES.isEvasive(String(row.content || "")) && !PRODUCT_RULES.isShortEmpty(String(row.content || "")) && !PRODUCT_RULES.isLongTitle(String(row.title || ""));
  if (!ok) {
    try { await prisma.knowledge.update({ where: { id: row.id }, data: { stale: true, staleReason: "V3 格式不合规 (task-resolved-scanner soft validation)", updatedAt: new Date() } }); } catch {}
  }
  return row;
}
async function safeCreatePractice(data: any) {
  const row = await storeCreatePractice(prisma, { data });
  if (!row) { console.warn("[task-resolved-scanner] Practice 被 store 内容闸拒绝(不合规), 不落库"); return null; }
  const ok = !PRODUCT_RULES.isEvasive(String(row.description || "")) && !PRODUCT_RULES.isShortEmpty(String(row.description || "")) && !PRODUCT_RULES.isLongTitle(String(row.title || ""));
  if (!ok) {
    try { await prisma.practice.update({ where: { id: row.id }, data: { stale: true, staleReason: "V3 格式不合规 (task-resolved-scanner soft validation)", updatedAt: new Date() } }); } catch {}
  }
  return row;
}

const PRODUCT_RULES = require("./lib/product-format-rules.cjs");
import { calcQualityScore } from "./db-writer";
// 2026-10-10 round 57 G4: 统一写入出口(store 投影 + qualityScore 兜底 + 标题归一); 本地 wrapper 保留 V3 stale 标记
import { safeCreateMemory, safeCreateKnowledge as storeCreateKnowledge, safeCreatePractice as storeCreatePractice } from "./safe-create";
import { projectCategory } from "./enum-projection"; // 2026-10-08 round 54: category 受控投影 // 2026-10-08 round 54
import { writeSkillDeduped } from "./skill-dedup"; // 2026-10-09 round 68: Skill 写入唯一去重入口(归一 + keep-existing)

const ROUTE_KEYWORDS: Record<string, string[]> = {
  SKILL: ["skill", "能力", "tool"],
  KNOWLEDGE: ["knowledge", "知识", "概念"],
  PRACTICE: ["practice", "实践", "动手"],
};

function inferTargetType(
  explicit: string | null,
  tags: string | null
): "MEMORY" | "KNOWLEDGE" | "SKILL" | "PRACTICE" {
  // 1. 显式优先
  if (
    explicit &&
    ["MEMORY", "KNOWLEDGE", "SKILL", "PRACTICE"].includes(explicit)
  ) {
    return explicit as "MEMORY" | "KNOWLEDGE" | "SKILL" | "PRACTICE";
  }

  // 2. tags 推
  if (tags) {
    const lower = tags.toLowerCase();
    for (const [tgt, keywords] of Object.entries(ROUTE_KEYWORDS)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        return tgt as "MEMORY" | "KNOWLEDGE" | "SKILL" | "PRACTICE";
      }
    }
  }

  return "MEMORY"; // 默认落 memory
}

interface ScanResult {
  scanned: number;
  routed: Record<string, number>;  // {MEMORY: n, KNOWLEDGE: n, SKILL: n, PRACTICE: n}
  skipped: number;
  tasks: Array<{
    taskId: string;
    title: string;
    targetType: string;
    writtenId: string;
  }>;
}

export async function runTaskResolvedScanner(options: {
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<ScanResult> {
  const limit = options.limit ?? 50;
  const dryRun = options.dryRun ?? false;

// 1. 拉 DONE 状态的 task (排除已回填过的, 通过 sourceReflectionIds + resolved_at 时间戳兜底)
  const tasks = await prisma.task.findMany({
    where: {
      status: "DONE",
    },
    select: {
      id: true,
      title: true,
      description: true,
      theme: true, // monorepo: theme 替代 Phase 0 的 targetType
      sourceReflectionIds: true,
      completedAt: true,
    },
    orderBy: { completedAt: "desc" },
    take: limit,
  });

  const routed: Record<string, number> = {
    MEMORY: 0,
    KNOWLEDGE: 0,
    SKILL: 0,
    PRACTICE: 0,
  };
  const written: ScanResult["tasks"] = [];
  let skipped = 0;

  for (const t of tasks) {
    // 防重复: 检查 4 类任一表是否已存在该 task 的回填 (用 sourceReflectionId / tags 含 task.id 串匹配)
    // 简化: 直接看 task.description 里是否已有 "[task:taskId]" 标记
    const tag = `[task:${t.id}]`;
    if (t.description && t.description.includes(tag)) {
      skipped++;
      continue;
    }

        // 从 description meta 提取 tags (bridge 编码: [tags:xxx])
    const tagsMatch = t.description?.match(/\[tags:([^\]]*)\]/);
    const tagsStr = tagsMatch ? tagsMatch[1] : null;
    const targetType = inferTargetType(t.theme, tagsStr);

    if (dryRun) {
      routed[targetType]++;
      written.push({ taskId: t.id, title: t.title, targetType, writtenId: "(dry-run)" });
      continue;
    }

    // 2. 按 targetType 写不同表
    const stampedDesc = `${tag} ${t.description || ""}`.trim();
    let writtenId = "";

    switch (targetType) {
      case "MEMORY":
        const mem = await safeCreateMemory(prisma, {
          data: {
            title: t.title,
            content: stampedDesc,
            type: "INSIGHT",
            tier: "WARM",
            importance: 0.7,
            tags: tagsStr,
            agentSource: "TASK_RESOLVED_HERMES",
            // 2026-10-09 round 72-B: 补 qualityScore(此前漏写 -> 列默认 0 -> 行"看起来有分"却隐形于质量门;
            //   与 skill/practice 两个分支同口径, 由 check-enum-write-sites 棘轮抓出)
            qualityScore: calcQualityScore({ type: "memory", content: stampedDesc, title: t.title, tags: tagsStr }),
          },
          select: { id: true },
        });
        writtenId = mem?.id ?? "";
        break;

      case "KNOWLEDGE":
        // 2026-10-06 修(与 execute-improving-task.ts 同一 bug 类, 由新增守门 check-prisma-create-shape 抓出):
        //   原来传成 { data: {...} }, 而 safeCreateKnowledge 自身已加 data -> prisma 收到 data:{data:{...}}
        //   -> "Invalid prisma.knowledge.create()" -> 该任务产物落库失败。这里同样去掉外层 data。
        const kn = await safeCreateKnowledge({
          title: t.title,
          content: stampedDesc,
          sourceType: "TASK_RESOLVED",
          sourceId: t.id,
          category: projectCategory("derived", "knowledge") ?? "OTHER", // 2026-10-08 round 54: derived -> DERIVED
          tags: tagsStr,
          agentSource: "TASK_RESOLVED_HERMES",
        });
        // 2026-10-09 round 72-I: 认知闸切 enforce 后 store 可能返回 null -> `kn.id` 会抛 TypeError
        //   把整轮扫描打崩。显式判空: 拒收就当作"没写成", 由调用方按既有 writtenId=null 语义处理。
        if (!kn || !kn.id) { console.warn("[task-resolved-scanner] 认知闸拒收 Knowledge: " + String(t.title).slice(0, 40)); break; }
        writtenId = kn.id;
        break;

      case "SKILL": {
        // 2026-10-09 round 68: 收敛到 writeSkillDeduped —— 原实现有**两个**缺陷:
        //   ① `name: t.title` **完全没归一** (这里正是 Skill 超长名的产地: 859 条超长名里 829 条 source=LEARNED);
        //   ② 只做**逐字** findUnique, 归一后同义的名字照样各建一行 —— 每轮扫描都能再造一批同义行。
        //   现策略 keep-existing: 归一后撞名就复用(只补空字段), 不再造新行 —— 重复运行必须收敛到 1 行。
        const category = projectCategory("derived", "skill") ?? "OTHER";
        const w = await writeSkillDeduped(prisma, {
          name: t.title,
          description: stampedDesc,
          category,
          level: "AWARENESS",
          source: "LEARNED",
          qualityScore: calcQualityScore({ type: "skill", content: stampedDesc, name: t.title, level: "AWARENESS", category }), // 2026-08-27 补齐 5 表覆盖
        }, { onConflict: "keep-existing", actor: "task-resolved-scanner" });
        // 2026-10-09 round 72-C2: 本路径**没有 steps 素材**(只有任务标题+描述),
        //   按人类裁决"无 steps 不成 skill", writeSkillDeduped 会返回 REJECTED_NO_STEPS 且不落库。
        //   这里如实记录(不再静默) —— 需要沉淀的话应该走 Knowledge 而不是 Skill。
        if (w.outcome === "REJECTED_NO_STEPS") {
          console.warn("[task-resolved-scanner] SKILL 跳过(无 steps 不成 skill): " + w.rejectedReason);
        }
        writtenId = w.skill?.id ?? null;
        break;
      }

      case "PRACTICE":
        const pr = await safeCreatePractice({
          title: t.title,
          description: stampedDesc,
          type: "TASK_DERIVED",
          outcome: "SUCCESS", // 2026-10-07 P4: 原 "RESOLVED" 不在受控枚举(types.ts outcome: SUCCESS|PARTIAL|FAILED); 任务闭环即成功 -> 直接写规范值
          difficulty: 0.5,
          startedAt: t.completedAt || new Date(),
          completedAt: t.completedAt || new Date(),
          // 2026-10-07 同类补漏: 本路径原先也没写 qualityScore(与 global-organizer 同一 bug 类),
          //   产物以 NULL 混进表里: 既不进质量读数, 也无法被质量闸门判定。
          qualityScore: calcQualityScore({ type: "practice", content: stampedDesc, title: t.title, type2: "TASK_DERIVED", outcome: "SUCCESS", difficulty: 0.5 }),
        });
        if (!pr || !pr.id) { console.warn("[task-resolved-scanner] 认知闸拒收 Practice: " + String(t.title).slice(0, 40)); break; }
        writtenId = pr.id;
        break;
    }

    // 3. 把 task.description 加 [task:taskId] 标记, 防止下次重扫重复
    if (writtenId) {
      await prisma.task.update({
        where: { id: t.id },
        data: { description: stampedDesc },
      });
      routed[targetType]++;
      written.push({ taskId: t.id, title: t.title, targetType, writtenId });

      // 4. 飞轮事件
      await prisma.flywheelEvent.create({
        data: {
          stage: "TASK_TO_FILL",
          sourceType: "Task",
          sourceId: t.id,
          sourceTitle: t.title,
          targetStage: targetType,
          targetType,
          targetId: writtenId,
          taskId: t.id,
        },
      });
    } else {
      skipped++;
    }
  }

  return { scanned: tasks.length, routed, skipped, tasks: written };
}

/** 把指定 task 标记为 DONE (用于演示 + 端到端测试) */
export async function markTaskDone(taskId: string): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
  await prisma.$transaction([
    prisma.task.update({
      where: { id: taskId },
      data: { status: "DONE", completedAt: new Date() },
    }),
    prisma.taskStateTransition.create({
      data: {
        taskId,
        fromStatus: task?.status || null,
        toStatus: "DONE",
        actor: "task-resolved-scanner:markTaskDone",
        reason: "manual mark done",
      },
    }),
  ]);
}