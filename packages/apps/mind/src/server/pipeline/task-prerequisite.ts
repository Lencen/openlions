/**
 * task-prerequisite.ts — 任务前置依赖闸门 (2026-09-18)
 *
 * 规范: docs/platform-logic/task-decomposition-spec-2026-09-18.md §4 / G5
 *
 * 立规原因(实测): Task.prerequisiteTaskIds 自建表起**全库无人写、也无人读**(只在
 *   improving-tasks DTO 里被回显一次)。于是"前置没做完就可以抢着做" —— 并发执行体在同一批
 *   文件上互相踩。粒度规范要求依赖显式化, 这里给出**唯一**的判定实现, 所有认领路径共用,
 *   避免"三个入口三份口径"的老病(见 claim/route.ts 白名单单一来源的同款修法)。
 *
 * 语义(刻意保守, 宁可放行也不静默饿死队列):
 *   - prerequisiteTaskIds 为空 / 非 JSON 数组 / 数组里全是空串 -> 视为无前置, **放行**;
 *   - 前置任务 id 在库里**已不存在**(被删/幽灵) -> 视为**已作废**, 放行(否则一条脏依赖会永久卡死任务);
 *   - 只有"前置存在且状态 != DONE"才算未满足 -> 不可认领, 并如实回报缺哪几条。
 *   - 查询异常 -> 放行并让调用方记账(不因依赖查询失败把整条队列变成不可认领)。
 */

export type PrereqDb = { $queryRawUnsafe: (sql: string, ...args: any[]) => Promise<any> };

/** 解析 prerequisiteTaskIds 字段(容错异形值: null/''/字符串/非数组 JSON)。 */
export function parsePrerequisiteIds(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean);
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    if (Array.isArray(a)) return a.map((x) => String(x)).filter(Boolean);
    if (typeof a === "string" && a.trim()) return [a.trim()]; // 异形: 单个字符串
    return [];
  } catch {
    return []; // 不可解析 -> 不当作依赖(保守放行), 由粒度体检负责把脏值报出来
  }
}

/**
 * 返回 taskId -> 未满足的前置 id 列表(只包含"仍存在且非 DONE"的前置)。
 * @param rows 至少含 { id, prerequisiteTaskIds }
 */
export async function missingPrerequisites(db: PrereqDb, rows: any[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const pairs: Array<{ id: string; need: string[] }> = [];
  for (const r of rows || []) {
    const need = parsePrerequisiteIds(r?.prerequisiteTaskIds);
    if (need.length) pairs.push({ id: String(r.id), need });
  }
  if (!pairs.length) return out;
  const all = Array.from(new Set(pairs.flatMap((p) => p.need)));
  const done = new Set<string>();
  const alive = new Set<string>();
  try {
    const rs: any[] = await db.$queryRawUnsafe(
      "SELECT id, status FROM Task WHERE id IN (" + all.map(() => "?").join(",") + ")",
      ...all
    );
    for (const r of rs || []) {
      const id = String(r.id);
      alive.add(id);
      if (String(r.status) === "DONE") done.add(id);
    }
  } catch {
    return out; // 查询失败 -> 放行(见文件头"刻意保守")
  }
  for (const p of pairs) {
    const miss = p.need.filter((id) => alive.has(id) && !done.has(id));
    if (miss.length) out.set(p.id, miss);
  }
  return out;
}

/** 单条任务的便捷判定(供 claim-by-id 之类的按 id 认领路径使用)。 */
export async function prerequisiteBlocked(db: PrereqDb, task: any): Promise<string[]> {
  const m = await missingPrerequisites(db, task ? [task] : []);
  return m.get(String(task?.id)) || [];
}

export const PREREQUISITE_SKIP = {
  skipped: "PREREQUISITE_PENDING",
  taskKindLabel: "前置依赖未完成",
  hint:
    "先完成前置任务, 或由派单侧核对 prerequisiteTaskIds 是否写错; " +
    "前置确实已作废请走显式流程作废该前置, 不要手改依赖字段(依赖是粒度规范 §4/G5 的硬声明)。",
} as const;
