/**
 * skill-dedup.ts — Skill 写入的**唯一去重入口** (2026-10-09 round 68)
 *
 * 业务问题(实测): Skill 表 39,543 行里, 超长名 859 条**全部**在归一后与另一行**已存在的 name 逐字相同**
 *   (520 组, 每组恰好 1 个"已合规占位行"); 这不是命名问题, 是**同义技能反复再生**。
 *   根因: 写路径不下十处 (API / THEME_IMPROVE / task-resolved-scanner / db-writer / global-organizer /
 *   modules/skill store / 若干一次性脚本), round 61 只在 **API 一处** 做了事务去重, 其余直连
 *   `prisma.skill.create` —— 每小时跑一次的飞轮提炼每次都能再造一个新行。
 *
 * 本模块把"归一 + 撞名处理"收成单一实现, 两种策略对应用户意图:
 *   - `new-wins`      : 调用方**明确要写入新内容**(人类/agent 走 API 提交技能) -> 旧行让位
 *                        (name 加 `__retired__<ts>` 后缀腾出 UNIQUE 槽, stale=true), 新行作主条,
 *                        旧行 supersededBy=新行。等价于 round 61 的 API 行为。
 *   - `keep-existing` : 调用方是**幂等的自动提炼**(飞轮每小时重跑同一主题) -> 撞名就**不建新行**,
 *                        只把空字段补上, 返回 REUSED。这是"防再生"的关键: 重复运行必须收敛到 1 行。
 *
 * 并发安全: 单次 `findUnique` + `create` 在并发下两个请求都能过检查 -> 撞 UNIQUE(P2002)。
 *   (round 61 的教训: Prisma 拦截器层做不了这件事 —— 拦截器里嵌 $transaction 会 P2028 事务超时,
 *    且步骤 A 已写盘留下脏行。hook 层只放纯函数。) 因此这里:
 *     ① new-wins 走调用方事务(与主写入同一原子单元);
 *     ② keep-existing 捕获 P2002 后**重读并返回 REUSED** —— 唯一索引才是最终裁判。
 *
 * 归一: 必须用 `@lions/product-contract` 的 `normalizeProductTitle(name, {max: SKILL_NAME_MAX})`
 *   (round 58 起的单一来源; 超长时"保头保尾压缩"会产出 `头…尾` 形式, 这是契约既定行为)。
 */
import { skillNameFields, findPublicSkillId } from "./skill-naming";
import {
  normalizeSkillName as contractNormalizeSkillName,
  normalizeSkillSummary,
  normalizeSkillTags,
  isSkillNameCompressionLossy,
  SKILL_NAME_MAX,
  SKILL_SUMMARY_MAX,
  SKILL_TAGS_MAX,
} from "@lions/product-contract";

export { SKILL_NAME_MAX, SKILL_SUMMARY_MAX, SKILL_TAGS_MAX };

export type SkillWriteInput = {
  name: string;
  description?: string | null;
  content?: string | null;
  trigger?: string | null;
  verification?: string | null;
  pitfalls?: string | null;
  platforms?: string | null;
  category?: string | null;
  level?: string | null;
  qualityScore?: number | null;
  source?: string | null;
  version?: number | null;
  /** 2026-10-09 round 70: 摘要(用于列表页快速判断要不要展开), <= SKILL_SUMMARY_MAX */
  summary?: string | null;
  /** 2026-10-09 round 70: 标签(用于匹配), string[] 或 "a,b、c" 形态均可 */
  tags?: string[] | string | null;
};

export type SkillConflictPolicy = "new-wins" | "keep-existing";
export type SkillWriteOutcome = "CREATED" | "SUPERSEDED_AND_CREATED" | "REUSED" | "NO_NAME" | "REJECTED_NO_STEPS";

/**
 * 2026-10-09 round 72-C2(人类裁决): **无 steps 不成 skill** —— SKILL-SPEC 的既定铁律
 *   (docs/SKILL-SPEC.md: "无 steps 不成 skill"), API 路由 POST /api/v1/skill 一直在校验
 *   (steps.length < 30 -> 400)。但**流水线写路径从来没有校验**, 于是产出了 24,725 条
 *   "只有 description、没有 content" 的骷髅 skill(实测: 全部 totalUsageCount=0、零引用、
 *   零 PracticeSkillLink、无人当 parent —— 纯死数据)。
 *   危害: (a) 表被撑大到 39,545, 真实可用只有 ~14,820; (b) 拉低所有"平均质量/平均使用"口径;
 *   (c) 它们是 legacy=1 不进注入, 但会让任何按表行统计的指标失真。
 *   人类裁决: "没有 step 的 skill 都是不可用的, 这种 skill 留着没有意义"。
 *   故在**唯一写入口**加这道闸: 创建时若 steps 缺失或不足 SKILL_STEPS_MIN, 直接拒绝(不落库)。
 *   更新/复用已有行不受影响(策略 keep-existing 时会走 REUSED, 不会建新行)。
 */
export const SKILL_STEPS_MIN = 30;

export interface SkillWriteResult<T = any> {
  outcome: SkillWriteOutcome;
  skill: T | null;
  /** 归一后的名字(便于调用方记录/复算) */
  normalizedName: string;
  /**
   * 2026-10-09 round 70: 归一后名字仍超过 SKILL_NAME_MAX(确定性路径不做有损截断, 见 normalizeSkillName 注释)。
   *   true 时调用方**不应**把该行当作"已合规", 而应排入语义命名队列(LLM)或人工处理。
   *   注意: 这不影响去重判定 —— 超长名照常按"逐字相同"去重, 只是不该拿它去和别人"合并"。
   */
  nameTooLong?: boolean;
  /** new-wins 下被顶替的旧行 id */
  retiredId?: string;
  /** keep-existing 下补写过的字段名 */
  enriched?: string[];
  /** REJECTED_NO_STEPS 时的拒绝原因(便于调用方记录/降级为 Knowledge) */
  rejectedReason?: string;
}

/**
 * 归一技能名(空 -> 空串, 由调用方决定是拒写还是落 NO_NAME)。
 *
 * **默认安全模式**: 只做"净化 + 去省略号", **不做有损截断** —— 若净化后仍 >20, 原样返回(可能超长),
 * 并把 `lossy` 标出来。理由见 @lions/product-contract 里 normalizeSkillName 的注释:
 * 头部截断会把 'Prisma schema设计与migration' / 'Prisma ORM与DateTime处理' 一起塌成 "Prisma",
 * 而本层判据是"同名即同技能" —— 用截断结果判同名会**把不同技能合并掉**。
 * 真正的短名要靠语义压缩(LLM, 见 /api/v1/flywheel/title-refine 与 round 71 的批量命名)。
 */
export function normalizeSkillName(raw: unknown): { name: string; lossy: boolean; tooLong: boolean } {
  const s = String(raw ?? "").trim();
  if (!s) return { name: "", lossy: false, tooLong: false };
  const name = contractNormalizeSkillName(s, { max: SKILL_NAME_MAX }) || s;
  return {
    name,
    lossy: isSkillNameCompressionLossy(s, { max: SKILL_NAME_MAX }),
    tooLong: name.length > SKILL_NAME_MAX,
  };
}

/**
 * 纯函数: 给定"撞名处理策略 + 是否已存在同名行", 决定动作。
 *   抽出来是为了可单测 —— 真实写库路径无法在 CI 里反复跑。
 */
export function decideSkillWrite(existingId: string | null, policy: SkillConflictPolicy): SkillWriteOutcome {
  if (!existingId) return "CREATED";
  return policy === "new-wins" ? "SUPERSEDED_AND_CREATED" : "REUSED";
}

/** keep-existing 时只补**空字段**(绝不覆盖非空值 —— 自动提炼不该改写已有内容)。 */
export function pickEnrichableFields(
  existing: Record<string, any>,
  input: SkillWriteInput,
): Record<string, string> {
  const out: Record<string, string> = {};
  const cand: Array<keyof SkillWriteInput> = ["description", "content", "trigger", "verification", "pitfalls", "platforms", "summary", "tags"];
  for (const k of cand) {
    const cur = existing?.[k as string];
    const next = input[k];
    const curEmpty = cur == null || String(cur).trim() === "";
    const nextHas = next != null && String(next).trim() !== "";
    if (curEmpty && nextHas) out[k as string] = String(next).trim();
  }
  return out;
}

function isUniqueViolation(e: any): boolean {
  return !!e && (e.code === "P2002" || /Unique constraint failed/i.test(String(e.message || "")));
}

/**
 * 落库一个 Skill(归一 + 撞名处理)。`client` 传 `tx` 时并入调用方事务(推荐 new-wins)。
 *
 * 语义边界(重要): 本函数**不**做"同义判定"(不判断两个不同名是否指同一技能) —— 那只认
 *   **归一后逐字相同**。跨语言的同义(如 'MCP 协议…' vs 'MCP Protocol…')不在本函数职责内,
 *   需要靠写入侧的归类或人工裁决, 不能靠字符串归一假装解决。
 */
export async function writeSkillDeduped<T = any>(
  client: any,
  input: SkillWriteInput,
  opts: {
    onConflict?: SkillConflictPolicy;
    actor?: string;
    retireReason?: string;
    /** 显式放行"没有 steps 的 skill"(默认 false —— 人类裁决: 无 steps 不成 skill) */
    allowNoSteps?: boolean;
  } = {},
): Promise<SkillWriteResult<T>> {
  const policy = opts.onConflict || "new-wins";
  const nm = normalizeSkillName(input.name);
  const name = nm.name;
  if (!name) return { outcome: "NO_NAME", skill: null, normalizedName: "" };

  const data: Record<string, any> = { name, ...skillNameFields(name) };
  for (const k of ["description", "content", "trigger", "verification", "pitfalls", "platforms"] as const) {
    if (input[k] !== undefined) data[k] = input[k] == null ? null : String(input[k]).trim();
  }
  // 2026-10-09 round 70: 摘要 + 标签(名称/摘要/标签三件套 —— 列表页靠它们做初筛, 详情页才展开 steps)
  if (input.summary !== undefined) data.summary = normalizeSkillSummary(input.summary);
  if (input.tags !== undefined) {
    const tags = normalizeSkillTags(input.tags);
    data.tags = tags.length > 0 ? JSON.stringify(tags) : null;
  }
  if (input.category !== undefined) data.category = input.category;
  if (input.level !== undefined) data.level = input.level;
  if (input.qualityScore !== undefined) data.qualityScore = input.qualityScore;
  if (input.source !== undefined) data.source = input.source;
  if (input.version !== undefined) data.version = input.version;

  // 2026-10-26: 查公共技能改走技术名（findPublicSkillId：technicalName 优先，name 兜底）
  const existingId = await findPublicSkillId(client, name);
  const existing = existingId ? { id: existingId } : null;
  const outcome = decideSkillWrite(existing?.id ?? null, policy);

  // 2026-10-09 round 72-C2: **无 steps 不成 skill** 闸(只拦"新建", 不拦复用/补写已有行)。
  //   实测存量 24,725 条无 steps 的骷髅 skill 全部零引用零使用, 是人类裁定要清掉的死数据;
  //   这道闸保证**不再产生新的**。调用方若确需落一条"暂缺 steps"的行, 必须显式 allowNoSteps。
  if (outcome === "CREATED" && !opts.allowNoSteps) {
    const steps = input.content == null ? "" : String(input.content).trim();
    if (steps.length < SKILL_STEPS_MIN) {
      return {
        outcome: "REJECTED_NO_STEPS",
        skill: null,
        normalizedName: name,
        rejectedReason: "SKILL-SPEC: 无 steps(或 <" + SKILL_STEPS_MIN + " 字)不成 skill; 实际 steps 长度=" + steps.length + " actor=" + (opts.actor || "?"),
      };
    }
  }

  if (outcome === "REUSED") {
    const full = await client.skill.findUnique({ where: { id: existing!.id } });
    const enrich = pickEnrichableFields(full || {}, input);
    const keys = Object.keys(enrich);
    if (keys.length > 0) {
      await client.skill.update({ where: { id: existing!.id }, data: enrich as any });
      return { outcome: "REUSED", skill: { ...(full || {}), ...enrich } as T, normalizedName: name, enriched: keys };
    }
    return { outcome: "REUSED", skill: full as T, normalizedName: name, enriched: [] };
  }

  if (outcome === "CREATED") {
    try {
      const skill = await client.skill.create({ data });
      return { outcome: "CREATED", skill: skill as T, normalizedName: name, nameTooLong: nm.tooLong };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // 并发下被别人抢先建了同名行: 唯一索引是最终裁判 -> 按撞名规则重走一次
      const againId = await findPublicSkillId(client, name);
      const again = againId ? { id: againId } : null;
      if (!again?.id) throw e;
      const o2 = decideSkillWrite(again.id, policy);
      if (o2 === "REUSED") {
        const full = await client.skill.findUnique({ where: { id: again.id } });
        return { outcome: "REUSED", skill: full as T, normalizedName: name, enriched: [] };
      }
      return await retireAndCreate(client, name, data, again.id, opts);
    }
  }

  return await retireAndCreate(client, name, data, existing!.id, opts);
}

async function retireAndCreate<T>(
  client: any,
  name: string,
  data: Record<string, any>,
  existingId: string,
  opts: { actor?: string; retireReason?: string },
): Promise<SkillWriteResult<T>> {
  const now = Date.now();
  const retiredName = name + "__retired__" + now;
  await client.skill.update({
    where: { id: existingId },
    data: {
      name: retiredName,
      stale: true,
      staleReason: (opts.retireReason || "[round 68] skill 写端 dedup: pending retire").slice(0, 200),
    },
  });
  const skill = await client.skill.create({ data });
  await client.skill.update({
    where: { id: existingId },
    data: {
      supersededBy: skill.id,
      supersededAt: new Date(now),
      staleReason: ("[round 68] 撞名原 name=\"" + name + "\" (id=" + existingId + "), 新行 id=" + skill.id +
        " 作主条, 旧行 name 永久加 __retired__" + now + " 后缀避 UNIQUE" +
        (opts.actor ? " by " + opts.actor : "")).slice(0, 400),
    },
  });
  return { outcome: "SUPERSEDED_AND_CREATED", skill: skill as T, normalizedName: name, retiredId: existingId };
}
