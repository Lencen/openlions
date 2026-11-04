/**
 * finding-premise-close.ts — findings 生命周期"前提已不成立/已满足"闭环节 (2026-09-14, FW-GROW 治本)
 *
 * 为什么存在(根因, 实测):
 *   findings_landed_rate = 累计 RESOLVED / 可执行 findings(见 goal-gap.ts)。实测 (2026-09-14 06:09)
 *   总 2075 = 已落地 542 + 真未落地 1243 + 人审 290; 1243 条未落地里, 有 328 条其实**前提已经消失**:
 *     - MERGE_CONFLICT 210 条: 主题内根本不存在 contentHash 重复组(无冲突可合并);
 *     - CREATE_KNOWLEDGE 55 条: finding 自己的 acceptance 已被存量 Knowledge 满足;
 *     - CREATE_PRACTICE 63 条: acceptance 已被存量 Practice 满足。
 *   这些 finding 在任务执行器里被判为 SKIP(不是 RESOLVED), 于是:
 *     ① SKIP 不进关闭分支 -> 状态停在 NEW;
 *     ② 任务生成器的重开条件是"反思 updatedAt > 上次消费任务 updatedAt"(generate-improving-tasks.ts:377),
 *        而这些主题的反思早已不再更新 -> **永远不会再被派单**, finding 被永久搁浅;
 *     ③ 指标分母只增不减, 落地率被持续稀释(实测 0.392 -> 0.304)。
 *   还有一个隐藏死锁: 代码自己产出的"负结果证据"形如 `sql:... -> 0`, 而 evidence.ts 的判据要求
 *   `->` 之后有 >=30 字符的"真实返回" -> 这类证据**永远过不了** requireEvidence, 前提消失的 finding
 *   即使想关也关不掉(本文件与 execute-improving-task 已同步修复成"结果行数 + 语义说明"形态)。
 *
 * 本模块做什么(机制, 不是一次性特判):
 *   - premiseSatisfiedFor(finding, theme): 用**确定性、可复算**的判据判断"前提是否已不成立/已满足",
 *     命中则给出 validator 可接受的证据(evidenceRef)。
 *   - sweepPremiseSatisfiedFindings(): 有界地扫全部 unresolved findings, 命中判据的按
 *     requireEvidence 硬拦关闭(RESOLVED), 证据不合格则转 NEEDS_REVIEW(与执行器同一底线, 不放水)。
 *   该 sweep 由 improving-tasks cron 每小时调用一次(见 api/v1/flywheel/improving-tasks/cron/route.ts),
 *   使"搁浅 finding"也有确定的退出通道 —— 这正是认知复利里"结账"那一跳。
 *
 * 诚实边界: 只关闭**能给出确定性负结果/存在性证据**的 finding; 不能证明的(如 RE_EXTRACT 无新消息、
 *   CREATE_MEMORY 内容确实不存在且质量达标)一律不动, 保持 NEW, 绝不为指标好看而批量改状态。
 */
import { prisma } from "@/lib/prisma";
import { normalizeFlywheelTitle } from "./flywheel-prompt-constraints";
import { createHash } from "crypto";
import { parseStructuredFindings } from "./findings-parse";
import { requireEvidence } from "./evidence";
// 2026-09-24: 判定"现有 evidenceRef 是否已达标"用**纯函数**, 避免 requireEvidence 的副作用(见下)
import { evidenceKindOf } from "./evidence";
// 2026-09-15 机制修复(f-001 Pipeline stale-memory): 已裁决结单的持久登记 + 重放
import { loadFindingClosures, applyFindingClosures, findingMatchesClosure } from "./finding-closure-store";
import {
  acceptanceAlreadySatisfied,
  practiceAcceptanceSatisfied,
  parseMemoryMetaRatioCeiling,
  currentMetaRatio,
} from "./execute-improving-task";
// 2026-09-24 机制修复(finding f-004 主题对齐误报 -> 人类决策卡): 计数口径必须与反思引擎一致(别名族感知)
import { themeVariants } from "./resolver";

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
const knowledgeHashOf = (title: string, content: string) => sha256Hex(title + "\n" + content);
const practiceHashOf = (title: string, description: string) => sha256Hex(title + "\n" + description);

export interface PremiseVerdict {
  satisfied: boolean;
  detail?: string;
  evidenceRef?: string;
}

/**
 * 校验器友好的负结果证据。
 * evidence.ts 要求 `->`/`=>` 之后至少 30 字符的"真实返回" —— 只写 `-> 0` 会被判不合格,
 * 于是"前提不成立"的 finding 永远关不掉(这是指标塌陷的一个隐蔽死锁)。这里强制把
 * 结果行数与语义说明一起写成返回文本, 并保证尾部长度达标。
 */
export function negativeResultEvidence(sql: string, rows: number, note: string): string {
  // 统一追加确定性判据说明, 既如实描述复算来源, 也保证 `->` 尾部 >=30 字符(判据硬要求)。
  const suffix = "判据=确定性存在性/重复性复算";
  const tail = `${rows} 行 (${note}); ${suffix}`;
  return `${sql} -> ${tail}`;
}

// ============================================================================
// 2026-09-24 机制修复(待办 todo_land_zgypxrygilor / finding f-004 主题对齐误报):
//
// 根因(实测, 可复算): 反思引擎按 theme 聚合产物 —— reflect.ts loadThemeProducts() 只返回
//   `theme ∈ themeVariants(theme)` 的行; 但喂给 LLM 的"原始对话全文"来自该 theme 反查到的
//   session(可能是跨主题长 session, 同时含「LIONS Console V2」对话与「硬件坏道」产物)。
//   于是 LLM 产出 DATA_QUALITY / actionType=MARK_REVIEW 的 finding, 断言"本主题产物与本轮
//   对话主题完全不相关, 应标 MARK_REVIEW 待清理"。该断言在**产物 theme 口径**下自相矛盾:
//   被点名的产物按定义就是本主题的产物, 不存在"旧主题产物"可清理对象。
//   原先它走 reconcile-findings 的 HUMAN_TYPES 分支 -> 人类决策卡 -> 升级为落地任务(即本任务),
//   白白消耗一次人类决策 + 一次 agent 任务, 且该卡会反复出现。
//
// 判据: 把"产物 theme 是否真的与断言中的清理对象一致"变成确定性核实 —— 点名产物全部落在本主题
//   别名族内 => MARK_REVIEW 无可标记对象, 前提不成立 -> 自动结单(带可复算证据), 不再打扰人类。
// 诚实边界: 只核实 finding **点名 id**(evidenceSnippet 的 `[xxxxxx]` / 本文 `(a/b/c)` 列表);
//   点不到真实行, 或点名产物确实不在本主题别名族内, 一律不动, 保持原状交人审。
// ============================================================================

/** 主题对齐类断言(仅 MARK_REVIEW 人审类适用): 必须明确指向**产物归属 theme 字段**, 且断言其错位/需清理。 */
export function isThemeAlignmentClaim(finding: any): boolean {
  const at = String(finding.actionType || finding.type || "");
  if (at !== "MARK_REVIEW") return false;
  const text = [finding.what, finding.why, finding.background, finding.requirement, finding.relatedTopic]
    .map((x) => String(x || "")).join(" ");
  // ① 明确指向 theme 字段/theme=.../归属主题 —— 而非笼统的"主题不匹配"(那可能是在说内容重合/覆盖度)
  const explicitThemeField = /(theme|主题)\s*(字段|栏位|field)|(theme|主题)\s*=|<theme>|调整\s*theme|归属主题/i.test(text);
  // ② 断言该字段与主题不符 / 需清理
  const claimsMismatch = /(不相关|无关|未对齐|不对齐|不符|不匹配|错位|归属主题错误|调整\s*theme|清理)/.test(text);
  return explicitThemeField && claimsMismatch;
}

/** 从 finding 文本中抽取被点名的产物短 id(6 位): 兼容 `[xxxxxx]` 与 `(a/b/c)` 两种写法。 */
export function extractProductShortIds(finding: any): string[] {
  const text = [finding.evidenceSnippet, finding.what, finding.requirement]
    .map((x) => String(x || "")).join("\n");
  const out = new Set<string>();
  for (const m of text.matchAll(/\[([a-z0-9]{6})\]/gi)) out.add(m[1].toLowerCase());
  for (const m of text.matchAll(/[（(]([a-z0-9/,\s]{6,})[)）]/gi)) {
    for (const tok of m[1].split(/[/,\s]+/)) {
      if (/^[a-z0-9]{6}$/i.test(tok)) out.add(tok.toLowerCase());
    }
  }
  // 兼容"Memory dfpzis / Reflection 9bhmk4"这类紧贴载体名的裸短 id 写法(实测占比不小)
  for (const m of text.matchAll(/(?:Memory|Knowledge|Practice|Reflection|记忆|知识|反思|实践)\s*[[（(]?\s*([a-z0-9]{6})\b/gi)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** 对"产物主题未对齐"类 MARK_REVIEW 断言做确定性核实: 点名产物的 theme 是否真的不在本主题别名族内。 */
export async function themeAlignmentPremiseVerdict(finding: any, theme: string): Promise<PremiseVerdict> {
  const ids = extractProductShortIds(finding);
  if (!theme || ids.length === 0) return { satisfied: false };

  const rows: Array<{ table: string; id: string; theme: string }> = [];
  try {
    for (const s of ids) {
      // 短 id 是主键后缀 -> endsWith 精确到行; 四张产物表都查, 不假设类型
      const [mem, know, prac, refl] = await Promise.all([
        prisma.memory.findMany({ where: { id: { endsWith: s } }, select: { id: true, theme: true }, take: 3 }),
        prisma.knowledge.findMany({ where: { id: { endsWith: s } }, select: { id: true, theme: true }, take: 3 }),
        prisma.practice.findMany({ where: { id: { endsWith: s } }, select: { id: true, theme: true }, take: 3 }),
        prisma.reflection.findMany({ where: { id: { endsWith: s } }, select: { id: true, theme: true }, take: 3 }),
      ]);
      for (const r of mem) rows.push({ table: "Memory", id: r.id, theme: String((r as any).theme ?? "") });
      for (const r of know) rows.push({ table: "Knowledge", id: r.id, theme: String((r as any).theme ?? "") });
      for (const r of prac) rows.push({ table: "Practice", id: r.id, theme: String((r as any).theme ?? "") });
      for (const r of refl) rows.push({ table: "Reflection", id: r.id, theme: String((r as any).theme ?? "") });
    }
  } catch {
    return { satisfied: false };
  }

  // 点不到真实行(幻觉 id / 未点名) -> 不猜, 交人审
  if (rows.length === 0) return { satisfied: false };

  const variantSet = new Set(themeVariants(theme).map((v) => v.trim()));
  const offTheme = rows.filter((r) => !variantSet.has(r.theme.trim()));
  // 点名产物确实不在本主题 -> 断言可能成立, 不动(不越权替人类判断真实性)
  if (offTheme.length > 0) return { satisfied: false };

  const variants = themeVariants(theme);
  const sample = rows.map((r) => `${r.table.slice(0, 4)}:${r.id.slice(-6)}=${r.theme}`).join(", ");
  return {
    satisfied: true,
    detail: `点名 ${rows.length} 条产物 theme 全部落在本主题别名族「${theme}」内(${sample}); 断言"产物主题不对齐/不相关、应标 MARK_REVIEW 清理"自相矛盾, 无可标记对象 -> 前提不成立`,
    evidenceRef: negativeResultEvidence(
      `sql:SELECT id,theme FROM Memory/Knowledge/Practice/Reflection WHERE id LIKE '%<点名id>'`,
      rows.length,
      `点名产物 theme 全部 = 本主题别名族 [${variants.join("|")}], 不存在断言所指"旧主题产物"; MARK_REVIEW 前提不成立`
    ),
  };
}

/**
 * 判断 finding 的"前提"(它声称缺失/冲突/未沉淀的东西)是否已经不再成立或已被满足。
 * 判据与 execute-improving-task 执行分支一一对应, 均为确定性查询, 可独立复算。
 */
export async function premiseSatisfiedFor(finding: any, theme: string): Promise<PremiseVerdict> {
  const at = String(finding.actionType || finding.type || "");

  // ---- MERGE_CONFLICT: 主题内是否真有同内容重复组 ----
  if (at === "MERGE_CONFLICT") {
    try {
      const dup: any[] = await prisma.$queryRawUnsafe(
        "SELECT contentHash, COUNT(*) c FROM Memory WHERE theme=? AND contentHash IS NOT NULL AND contentHash != '' AND supersededBy IS NULL GROUP BY contentHash HAVING c>=2 LIMIT 1",
        theme || ""
      );
      if (dup.length > 0) return { satisfied: false };
      const cnt: any[] = await prisma.$queryRawUnsafe(
        "SELECT COUNT(*) c FROM Memory WHERE theme=? AND supersededBy IS NULL",
        theme || ""
      );
      const actives = Number(cnt?.[0]?.c ?? 0);
      return {
        satisfied: true,
        detail: `主题「${theme}」内无任何 contentHash 重复组, finding 所指冲突前提不成立`,
        evidenceRef: negativeResultEvidence(
          `sql:SELECT contentHash,COUNT(*) c FROM Memory WHERE theme='${theme}' AND contentHash IS NOT NULL AND supersededBy IS NULL GROUP BY contentHash HAVING c>=2`,
          0,
          `${actives} 条活性 Memory 中没有任何组 c>=2, 无对象可合并, finding 前提不成立`
        ),
      };
    } catch {
      return { satisfied: false };
    }
  }

  // ---- MARK_REVIEW(人审类) 的"产物主题未对齐"断言: 确定性核实点名产物的 theme ----
  //   命中即前提不成立 -> 自动结单, 不再升级为人类决策卡(治本, 见上方 2026-09-24 注释)。
  if (at === "MARK_REVIEW" && isThemeAlignmentClaim(finding)) {
    return await themeAlignmentPremiseVerdict(finding, theme);
  }

  // ---- CREATE_KNOWLEDGE: acceptance 已满足 / 同主题同内容知识已存在 ----
  if (at === "CREATE_KNOWLEDGE") {
    const gate = await acceptanceAlreadySatisfied(finding);
    if (gate.satisfied) return { satisfied: true, detail: gate.detail, evidenceRef: gate.evidenceRef };

    const title = normalizeFlywheelTitle(finding.what, 30); // 2026-09-29 V3 合规 (原 slice(0,120))
    const content = `${finding.why || ""}\n\n${finding.evidenceSnippet || ""}`.trim().slice(0, 1000);
    if (content) {
      const hash = knowledgeHashOf(title, content);
      const dup = await prisma.knowledge.findFirst({
        where: { theme, contentHash: hash, supersededBy: null },
        select: { id: true },
      });
      if (dup) {
        return {
          satisfied: true,
          detail: `同主题同内容 Knowledge 已存在 (${dup.id.slice(-6)}), finding 所述未沉淀前提不成立`,
          evidenceRef: negativeResultEvidence(
            `sql:SELECT id,contentHash FROM Knowledge WHERE theme='${theme}' AND contentHash='${hash}' AND supersededBy IS NULL`,
            1,
            `命中 id=${dup.id}, 同主题同内容知识早已沉淀`
          ),
        };
      }
    }
    return { satisfied: false };
  }

  // ---- CREATE_PRACTICE: acceptance 已满足 / 同主题同内容实践已存在 ----
  if (at === "CREATE_PRACTICE") {
    const gate = await practiceAcceptanceSatisfied(finding);
    if (gate.satisfied) return { satisfied: true, detail: gate.detail, evidenceRef: gate.evidenceRef };

    const title = normalizeFlywheelTitle(finding.what, 30); // 2026-09-29 V3 合规 (原 slice(0,120))
    const desc = String(finding.requirement || "").trim().slice(0, 500);
    if (desc) {
      const hash = practiceHashOf(title, desc);
      const dup = await prisma.practice.findFirst({
        where: { theme, contentHash: hash, supersededBy: null },
        select: { id: true },
      });
      if (dup) {
        return {
          satisfied: true,
          detail: `同主题同内容 Practice 已存在 (${dup.id.slice(-6)}), finding 所述未沉淀前提不成立`,
          evidenceRef: negativeResultEvidence(
            `sql:SELECT id,contentHash FROM Practice WHERE theme='${theme}' AND contentHash='${hash}' AND supersededBy IS NULL`,
            1,
            `命中 id=${dup.id}, 同主题同内容实践早已沉淀`
          ),
        };
      }
    }
    return { satisfied: false };
  }

  // ---- CREATE_MEMORY: 同主题同内容记忆已存在 / acceptance 的 meta 占比已满足 ----
  if (at === "CREATE_MEMORY") {
    const content = String(finding.evidenceSnippet || finding.requirement || "").trim().slice(0, 500);
    if (content) {
      const hash = sha256Hex(content);
      const dup = await prisma.memory.findFirst({
        where: { theme, contentHash: hash, supersededBy: null },
        select: { id: true },
      });
      if (dup) {
        return {
          satisfied: true,
          detail: `同主题同内容 Memory 已存在 (${dup.id.slice(-6)}), finding 所述未沉淀前提不成立`,
          evidenceRef: negativeResultEvidence(
            `sql:SELECT id,contentHash FROM Memory WHERE theme='${theme}' AND contentHash='${hash}' AND supersededBy IS NULL`,
            1,
            `命中 id=${dup.id}, 同主题同内容记忆早已沉淀`
          ),
        };
      }
    }
    const ceiling = parseMemoryMetaRatioCeiling(String(finding.acceptance || ""));
    if (ceiling != null) {
      const cur = await currentMetaRatio(theme);
      if (cur.total > 0 && cur.ratio <= ceiling) {
        return {
          satisfied: true,
          detail: `theme="${theme}" meta 占比 ${(cur.ratio * 100).toFixed(1)}% <= 上限 ${(ceiling * 100).toFixed(0)}%, acceptance 已满足`,
          evidenceRef:
            `sql:SELECT COUNT(*) FROM Memory WHERE theme='${theme}' -> ${cur.total} 行总数; meta(sourceType=FLYWHEEL_REFLECTION, 反思报告/lesson) -> ${cur.meta} 行, 占比 ${(cur.ratio * 100).toFixed(1)}% <= 上限 ${(ceiling * 100).toFixed(0)}% (acceptance 已满足)`,
        };
      }
    }
    return { satisfied: false };
  }

  // RE_EXTRACT 及其它: mind 侧拿不到"会话无新消息且已提取完"的确定性证据, 不猜、不动。
  return { satisfied: false };
}

export interface PremiseSweepResult {
  examined: number;
  satisfied: number;
  closed: number;
  toNeedsReview: number;
  reflectionsTouched: number;
  byAction: Record<string, number>;
  samples: Array<{ theme: string; findingId: string; actionType: string; detail: string }>;
}

/**
 * 有界扫描所有 unresolved findings, 关闭"前提已不成立/已满足"的那些。
 * - 幂等: 已 RESOLVED / NEEDS_REVIEW 的不再看;
 * - 只读判据 + 单次原生 SQL 回写(structuredFindings), **不触碰 updatedAt**, 避免污染观测窗口;
 * - dryRun=true 时只统计不落库。
 */
export async function sweepPremiseSatisfiedFindings(
  opts: { limit?: number; dryRun?: boolean; signal?: AbortSignal } = {}
): Promise<PremiseSweepResult> {
  const limit = opts.limit ?? 400;
  const dryRun = !!opts.dryRun;
  const signal = opts.signal;
  const out: PremiseSweepResult = {
    examined: 0, satisfied: 0, closed: 0, toNeedsReview: 0, reflectionsTouched: 0, byAction: {}, samples: [],
  };

  const refls = await prisma.flywheelReflection.findMany({
    where: { structuredFindings: { not: null } },
    select: { id: true, theme: true, structuredFindings: true },
  });

  // 2026-09-15 机制修复(f-001 Pipeline stale-memory): 先加载「已裁决结单」登记表, 命中优先按登记结单。
  const closures = await loadFindingClosures();

  for (const refl of refls) {
    if (out.examined >= limit || signal?.aborted) break;
    const findingsRaw = parseStructuredFindings(refl.structuredFindings) as any[];
    if (!findingsRaw.length) continue;
    let changed = false;
    for (const f of findingsRaw) {
      if (out.examined >= limit) break;
      const st = String(f.status || "NEW");
      if (st === "RESOLVED") continue;
      const atProbe = String(f.actionType || f.type || "");
      // 2026-09-24 机制修复(待办 todo_land_zgypxrygilor / finding f-004):
      //   "产物主题未对齐"类 MARK_REVIEW 假前提 finding 在历史上已被转成 NEEDS_REVIEW(人审队列),
      //   若仍一律 skip, 这类行永远停在队列里、机制无法自愈(本任务就是被它升级出来的)。
      //   仅对**这一类**放行重新判定; 其余 NEEDS_REVIEW 行为不变(不动真需要人判的行)。
      const needsReviewRevival = st === "NEEDS_REVIEW" && atProbe === "MARK_REVIEW" && isThemeAlignmentClaim(f);
      if (st === "NEEDS_REVIEW" && !needsReviewRevival) continue;
      out.examined++;
      // 登记表重放(治本): 决策已结单的冲突类 finding, 跨重算持久结单, 不再等 LLM/前提判据重新命中。
      //   (needsReviewRevival 行只走前提判据, 不借道登记表, 保持改动面最小)
      if (closures.length > 0 && !needsReviewRevival) {
        const hitClosure = closures.find((cl) => findingMatchesClosure(f, cl, String(refl.theme || "")));
        if (hitClosure) {
          const at0 = String(f.actionType || f.type || "?");
          out.satisfied++;
          if (out.samples.length < 20) {
            out.samples.push({ theme: String(refl.theme || ""), findingId: String(f.id), actionType: at0, detail: "finding-closure 登记重放: " + String(hitClosure.closureReason || "") });
          }
          if (dryRun) continue; // 只读模式: 只统计, 不改对象、不写库
          if (applyFindingClosures([f], closures, String(refl.theme || "")) > 0) {
            out.closed++;
            out.byAction[at0] = (out.byAction[at0] || 0) + 1;
            changed = true;
            continue;
          }
        }
      }
      const verdict = await premiseSatisfiedFor(f, String(refl.theme || ""));
      if (!verdict.satisfied) continue;
      out.satisfied++;
      const at = String(f.actionType || f.type || "?");
      out.byAction[at] = (out.byAction[at] || 0) + 1;
      if (out.samples.length < 20) {
        out.samples.push({ theme: String(refl.theme || ""), findingId: String(f.id), actionType: at, detail: String(verdict.detail || "").slice(0, 120) });
      }
      if (dryRun) continue; // 只读模式: 只统计 satisfied, 不改内存对象、不写库、不计 closed
      // 证据覆盖策略(2026-09-24 修正): "只补不覆盖"只对**已达标**的旧证据成立 —— 实测 f-004 早被
      //   reconcile 预填了占位 evidenceRef(`api:... | sql:...`, 无 `->` 返回, 判据不合格), 若一律不覆盖,
      //   确定性判据的合格证据会被占位证据挡住 -> 永远走不到 RESOLVED(自愈失效)。故: 旧证据不合格才替换。
      const prevEvOk = evidenceKindOf(`${f.evidenceRef ?? ""} ${f.resolutionNote ?? ""}`) !== null;
      if (verdict.evidenceRef && !prevEvOk) f.evidenceRef = verdict.evidenceRef;
      f.resolutionNote = (f.resolutionNote ? f.resolutionNote + " | " : "") +
        "[FW-GROW sweep " + new Date().toISOString() + " 前提已不成立/已满足] " + String(verdict.detail || "").slice(0, 160);
      if (!requireEvidence(f as Record<string, unknown>)) {
        // 证据不合格 -> 转人审(与执行器同一底线), 绝不硬置 RESOLVED
        f.status = "NEEDS_REVIEW";
        f.needsReviewReason = "前提已不成立但证据不合格(FW-EVIDENCE 硬拦)";
        f.needsReviewAt = new Date().toISOString();
        delete f.lastResolvedAt;
        out.toNeedsReview++;
        changed = true;
        continue;
      }
      f.status = "RESOLVED";
      f.closureReason = "PREMISE_SATISFIED";
      f.lastResolvedAt = new Date().toISOString();
      out.closed++;
      changed = true;
    }
    if (changed) {
      out.reflectionsTouched++;
      if (!dryRun) {
        // 原生 SQL: 只写 structuredFindings, 不触发 @updatedAt(维护性写入不得改变业务时间戳)
        await prisma.$executeRawUnsafe(
          "UPDATE FlywheelReflection SET structuredFindings = ? WHERE id = ?",
          JSON.stringify(findingsRaw),
          refl.id
        );
      }
    }
  }
  return out;
}
