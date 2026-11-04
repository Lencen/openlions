/**
 * human-card-dedup.ts — 人类决策卡「已开过/已处理过就不再放出来」去重判据 (2026-09-17)
 *
 * 事故(平台库现拉, 待办 todo_ev100om8bj5didak / 落地待办 todo_land_48ss626noke4):
 *   人类回复: "B，这个是不是之前处理过了，已处理过的为什么还是放出来给我决策？"
 *   实测不是错觉 —— 同一张业务卡在已决策后仍被重新开出:
 *     · businessKey = 「平台的一个环节|stuck-flow」:
 *         todo_card_mfo3r5ie3zud (2026-09-16T07:56 开, 07:57 人类回复 DONE)
 *         todo_ev100om8bj5didak (2026-09-17T10:15 又开, 13:07 人类再回复 DONE)
 *     · businessKey = 「自动处理对话的流水线|generic」:
 *         todo_ioxibuijq150454c (09-17T04:00 开, 13:09 DONE) -> todo_bf3yge70a95qwmjk (16:30 又开, 至今 OPEN)
 *     · 同一批 (2026-09-17T10:15:03) 还开出两条完全同 businessKey 的「网页界面|missing-config」卡。
 *
 * 根因(机制, 非一次特判):
 *   1) reconcile-findings.ts 的 HUMAN_TYPES 分支**每轮扫描都无脑 createTodo()**, 没有任何幂等/去重;
 *   2) 它依赖的 finding.status=NEEDS_REVIEW 写在 FlywheelReflection.structuredFindings JSON 里, 而该 JSON
 *      **每次反思都被 buildStructuredFindings 整体重算**(不携带上一轮状态, 见 finding-closure-store.ts 根因),
 *      于是已处理过的 finding 下一轮又变回 NEW/RECURRING -> 再开一张卡;
 *   3) reflect.ts 把「上次反思发现」注入 LLM 提示(reflect.ts:646), LLM 会产出**回顾型元 finding**
 *      (what 形如 "上次发现 10 项(dedupHash a/b/c…)" / "上次[hash/hash]标记为RESOLVED的…"),
 *      其 actionType 缺省时被 reflect.ts:595 兜底成 MARK_REVIEW(属 HUMAN_TYPES)-> 又变成人类决策卡。
 *      实测 2026-09-17T16:30 两张 OPEN 卡 (todo_wfkvmykek25qwmid / todo_bf3yge70a95qwmjk) 的 originalTitle
 *      都是这种回顾型元 finding。
 *
 * 修法(治本, 用**持久**的 Todo 表/登记表判据, 不依赖会被重算抹掉的 JSON 状态):
 *   A. findingCardKey(theme, finding): 同一 finding 身份(优先 dedupHash, 退化 id+what)永远只开一张;
 *   B. businessCardKey(domain, cueKind): 同一「业务域 + 事件类型」= 同一类人类决策问题;
 *      若该类问题已有卡(终态 DONE/DROPPED, 或仍在等人类回复的 OPEN/DOING/BLOCKED),
 *      本轮只落一张 DROPPED 卡存档, **不再打扰人类/不再重复刷屏**;
 *   C. isRecapFinding(): 回顾型元 finding 不再开人类决策卡(它回顾的那些 finding 本身会被逐条处置);
 *   D. 已由 FindingClosure 登记裁决的 finding 不再开卡(复用 finding-closure-store 的权威登记)。
 *
 * 诚实边界:
 *   - 只抑制「同一 finding / 同一业务问题 / 回顾型元 finding」三类; 新 finding + 新业务身份照常开卡。
 *   - 业务身份是 decision-card-language 的 (业务域, 事件类型) —— 粒度可能偏粗(如同一「平台的一个环节|failure」
 *     会合并不同具体故障)。被抑制的 finding 仍会落一张 DROPPED 存档卡(带 findingKey/dedupReason 可追溯),
 *     不丢信息; 但**不会再主动呈现在人类待办里**。这是为"同题反复问人"付的代价, 已在报告里如实标注。
 *   - 回顾型识别只认**两个强文本标记**(上次发现的 hash 列表 / "上次…N 项(条)" 计数), 不做语义猜测;
 *     刻意不把裸词 `dedupHash`、`上次反思发现` 当标记 —— 实测会误伤真实复发型 finding(回归有负样本)。
 */
import { todoRepoFor } from "@/server/lib/todo-repo";
import { prisma } from "@/lib/prisma";

import { createHash } from "crypto";

const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");

/** 稳定 finding 身份键(主题 + 内容指纹): 优先 dedupHash(内容稳定), 退化到 id|what。 */
export function findingCardKey(theme: string, finding: any): string {
  const content = String(finding?.dedupHash || "").trim()
    || `${String(finding?.id || "")}|${String(finding?.what || finding?.requirement || "")}`;
  return sha256(`${String(theme || "")}|finding|${content}`).slice(0, 32);
}

/** 业务身份键: 同一「业务域 + 事件类型」= 同一类人类决策问题。 */
export function businessCardKey(domain: string, cueKind: string): string {
  return sha256(`${String(domain || "")}|cue|${String(cueKind || "")}`).slice(0, 32);
}

/**
 * 同类问题冷却(2026-09-18, 用户实测反馈「重复问题，一直问没有意思」)。
 *
 * 为什么需要(实测): 「反复出问题——要不要先停下处理」这一模式共开出 **8 张卡**(每张还衍生 2-3 条待办)。
 *   原去重只覆盖『同标题且仍 OPEN』-> ① 已裁决后再命中会再开一张; ② 领域名是**自由文本**(实测出现过
 *   「把对话自动整理成平台记忆的流程」/「平台自检与验收」/占位词「平台的一个环节」, 以及 **域名空** 的卡),
 *   换个措辞就换了 businessKey, 同标题去重完全看不见。
 *   而 cueKind(问题**类型**)是收敛的 -> 用它在冷却窗口内判"这类问题是不是刚问过"。
 *
 * 语义(纯函数, 只看入参): 窗口内存在同 cueKind 的**曾示人**卡 -> 命中; 命中卡为终态(DONE / 示人后被归档) ->
 *   连来源都不必并入, 直接不打扰; 未结 -> 由调用方并入 meta.alsoFrom(一卡多源)。
 *   cueKind 为空则**不命中**(宁可多问一次, 也不误吞)。
 *
 * 2026-10-08 round 67 修复(#自续期, 实测): 上一版把 **建卡即存档** 的 DROPPED 卡也当终态锚点 —— 而这类卡
 *   正是冷却规则**自己**产出的(meta.dedupAction = SKIP_CUE_COOLDOWN / CREATE_AS_DROPPED_*)。它的
 *   createdAt 永远比上一张新, 于是"7 天窗口"每次都被自己的存档行刷新 -> **该类问题被永久静音**。
 *   实测(dev.db, 7 天): 带 cueKind 的卡 **839/839 全是 DROPPED**, 其中 839 张全是 dedupAction=SKIP_CUE_COOLDOWN
 *   (0 张是 retire 归档、0 张有 doneAt), 无一张曾进入 OPEN —— 即 7 天内没有任何一类问题真正摆到人类面前。
 *   30 天口径同样成立: missing-config 271 存档 / 3 已裁决, stuck-flow 228 / 3, duplication 219 / 5。
 *   判据修正: **从未示人的存档卡不作锚点**(跳过继续找下一张), 人类真的拍过板(DONE)或真的见过后被归档
 *   (meta 带 retiredReason) 才继续按终态静音。
 */
export type CueCooldownDecision =
  | { hit: false }
  | { hit: true; existingTodoId: string; existingStatus: string; terminal: boolean; reason: string };

/**
 * 2026-09-18 安全性修正(实测**我自己的修复有误吞**): 首版只比 cueKind —— 但 generic 是**兜底类型**,
 *   多个互不相关的问题共用它。实测: 一个全新问题(域名「知识地图分组」, cueKind=generic)因为在 7 天内有一张
 *   无关的 generic 卡已裁决, 被**静默吞掉**(POST 返回 deduped、未落库)。这比它要治的"重复问"更糟:
 *   重复问只是烦, 吞掉新问题会让人类**永远不会被问到**。
 *   修正: **兜底类型必须域名也相同**才算同类; 语义明确的类型(failure/duplication/missing-config/stuck-flow/
 *   missing-verify/record-conflict)仍按 cue-only —— 那才是"换个措辞的同一个问题"。
 */
const CATCH_ALL_CUES = new Set(["generic", "other", ""]);

/**
 * 2026-10-08 round 67: 这张卡是不是"建卡那一刻就是存档"(人类从未见过)?
 *
 * 判据: status=DROPPED **且** meta 带 dedupAction —— 所有产卡路径在"不打扰人类、只留档"时都会写
 *   dedupAction(SKIP_CUE_COOLDOWN / SKIP_FINDING_ALREADY_RAISED / CREATE_AS_DROPPED / CREATE_AS_DROPPED_TOPIC /
 *   CREATE_AS_DROPPED_NOTICE / CREATE_AS_DROPPED_CUE_COOLDOWN / ARCHIVE_AS_DROPPED), 而**曾示人**的卡
 *   (OPEN/DOING/BLOCKED -> 后续归档)由 human-card-retire 写 retiredReason/retiredBy, 不写 dedupAction。
 * meta 解析失败 -> 返回 false(宁可当锚点继续静音, 也不放行重复打扰; 与 decideCueCooldown 其余兜底一致)。
 */
export function isNeverPresentedCardMeta(status: unknown, metaObj: any): boolean {
  if (String(status) !== "DROPPED") return false;
  return !!metaObj && typeof metaObj === "object" && !!metaObj.dedupAction;
}

/** 同上, 入参为**原始 meta 字符串**(给单测/调用方直接判一行卡用)。 */
export function isNeverPresentedCard(card: { status: string; meta?: string | null }): boolean {
  let m: any = {};
  try { m = JSON.parse(String(card?.meta || "{}")); } catch { return false; }
  return isNeverPresentedCardMeta(card?.status, m);
}

export function decideCueCooldown(input: {
  cueKind?: string | null;
  /** 本次要开的卡的业务域(供兜底类型的同类判定) */
  domain?: string | null;
  /** 窗口内的既有卡(调用方按 createdAt 倒序给出) */
  recentCards: Array<{ id: string; status: string; meta?: string | null }>;
  windowDays?: number;
}): CueCooldownDecision {
  const cue = String(input.cueKind || "").trim();
  if (!cue) return { hit: false };
  const days = Number(input.windowDays || 7);
  const needDomain = CATCH_ALL_CUES.has(cue.toLowerCase());
  const dom = String(input.domain || "").trim();
  for (const c of input.recentCards || []) {
    let m: any = {};
    try { m = JSON.parse(String(c.meta || "{}")); } catch { m = {}; }
    if (String(m.cueKind || "") !== cue) continue;
    // 兜底类型: 域名也须一致; 本次域名空 -> 视为不同域(宁可多问一次, 也不误吞新问题)
    if (needDomain && (!dom || String(m.businessDomain || "").trim() !== dom)) continue;
    // 2026-10-08 round 67 (#自续期): 建卡即存档的 DROPPED 卡人类从未见过, 既不是"问过"也不是"已裁决";
    //   放它当锚点会让冷却窗被自己的存档行无限刷新 -> 该类问题永久静音。跳过, 继续找真正的先例。
    if (isNeverPresentedCardMeta(c.status, m)) continue;
    const decided = String(c.status) === "DONE";
    const terminal = decided || String(c.status) === "DROPPED";
    return {
      hit: true, existingTodoId: String(c.id), existingStatus: String(c.status), terminal,
      reason: terminal
        ? (decided
          ? "同类问题(问题类型 " + cue + ")已在 " + days + " 天内问过并已裁决(" + c.id + "), 不再重复打扰人类"
          // 慎重措辞: 该卡曾向人类示人, 但**没有裁决记录**(是过期归档/被判重作废), 不能写成"已裁决"。
          : "同类问题(问题类型 " + cue + ")已在 " + days + " 天内问过并归档(" + c.id + ", 人类未回应 -> 视同已问过), 不再重复打扰人类")
        : "同类问题(问题类型 " + cue + ")已有未结卡 " + c.id + ", 本次仅并入来源(一卡多源)",
    };
  }
  return { hit: false };
}

// =====================================================================================
// 2026-09-28 机制修复: recentCards **过滤条件合并**(单一来源)
//
// 触发(收件箱待办 todo_18b7e59cb88144c2a6a2, agent-i -> agent-d):
//   `docs/8DIM-CHANGELOG-GATE-FIX-2026-09-28.md` 第 5 节诚实标注"三处 recentCards 过滤条件仍分叉
//   (ownerType='human' 1,995 张 vs meta LIKE 1,656 张, 差集 339 张), 未落地"; workbuddy 复审要求
//   "339 张差集先做条件合并 PR 再合"。
//
// 根因(不是"数字对不上", 而是**判据口径按调用点分叉**):
//   同一件事(7 天窗内的既有决策卡)在四处各写各的 SQL:
//     · execute-improving-task.ts finding 分支: `ownerType='human'`            -> 多 339 张(含非决策卡人类待办)
//     · execute-improving-task.ts SLA 分支    : `meta LIKE '%HUMAN_DECISION_CARD%'`
//     · apps/api/v1/flywheel/todos/route.ts   : `meta LIKE '%HUMAN_DECISION_CARD%'`
//     · scripts/reconcile-findings.ts         : `meta LIKE '%HUMAN_DECISION_CARD%'` (且漏改 LIMIT 50)
//     · human-card-retire.ts                  : `meta LIKE '%HUMAN_DECISION_CARD%'` (三路并入)
//   分叉的后果不是"多查/少查几行"这么轻: 一条路径把**旧格式/缺 kind 标记但有 cueKind 的卡**排除在外时,
//   `decideCueCooldown` 就看不见那个 prior -> 冷却闸门静默失效(与 448ab79 的 LIMIT 截断同一种病)。
//
// 修法(治本): 把谓词收成**唯一常量 + 唯一 SQL 构造函数**, 所有闸门调用点必须引用它。
//   谓词取**并集**(最大召回): 显式 kind 标记 ∪ 带 cueKind 的卡 ∪ 人类待办。
//   精确性由下游 `decideCueCooldown` 保证(它要求 `meta.cueKind` 逐字相等; 兜底类型还要求域名相同),
//   故并集多出来的 2 行无 cueKind 的人类待办**不会**造成误命中(复算见 probe)。
//
// 诚实边界:
//   - 并集口径下, 差集 339 张(ownerType='human' 独有的非决策卡人类待办, 如 knowledge_dedupe 卡)
//     会进入候选池; 它们 meta 无 cueKind -> 不参与冷却判定, 仅多 ~0.1% 扫描行。
//   - 本改动只统一"看哪些卡", 不改"怎么判"(判据仍是 decideCueCooldown / decideCardRetraction)。
// =====================================================================================

/** 决策卡 meta 里的 kind 标记字面量(所有产卡路径写的是这个值)。 */
export const DECISION_CARD_KIND = "HUMAN_DECISION_CARD";

/**
 * 权威 recentCards 过滤谓词 —— **全部闸门调用点必须引自此处**, 不得就地拼字符串。
 * 并集三项: ① 显式 kind 标记 ② 带 cueKind 的卡(旧格式/迁移卡无 kind 但有 cueKind) ③ 人类待办。
 * 三者取并集保证"同 cueKind 的 prior 在任何一处都查得到"; 精确性由 decideCueCooldown 兜。
 */
export const RECENT_DECISION_CARDS_PREDICATE =
  "(meta LIKE '%HUMAN_DECISION_CARD%' OR meta LIKE '%\"cueKind\"%' OR ownerType = 'human')";

/** 冷却窗(与 decideCueCooldown 的 windowDays 默认 7 天同口径)。 */
export const CARD_COOLDOWN_DAYS = 7;
export const CARD_COOLDOWN_MS = CARD_COOLDOWN_DAYS * 24 * 3600 * 1000;

/**
 * 窗口内 recentCards 查询上限。
 * 实测口径(2026-09-28, 只读 dev.db): 7 天窗并集 = 1,269 行 -> 4,000 有约 3x 余量。
 * 448ab79 曾把三处 LIMIT 50 提到 4000, 但 **reconcile-findings.ts 这第四处漏改**(仍 50) —— 本次一并收口。
 */
export const RECENT_DECISION_CARDS_LIMIT = 4000;

/**
 * 构造"窗口内既有决策卡"查询(唯一构造函数, 调用方只传表名/列/上限/附加条件)。
 * 返回的 SQL **恰好一个 `?` 占位符**(createdAt 窗口下界, 毫秒), 追加条件排在它之前。
 */
export function recentDecisionCardsSql(input: {
  table?: string;
  columns?: string;
  limit?: number;
  /** 附加 WHERE 片段(不得重复谓词); 其占位符排在 createdAt 之前 */
  extraWhere?: string;
}): string {
  const table = String(input.table || "Todo").replace(/[^A-Za-z0-9_.]/g, "");
  const columns = String(input.columns || "id, status, meta").replace(/[^A-Za-z0-9_,\s]/g, "");
  const rawLimit = Number(input.limit ?? RECENT_DECISION_CARDS_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : RECENT_DECISION_CARDS_LIMIT;
  const extra = input.extraWhere ? " AND (" + String(input.extraWhere) + ")" : "";
  return "SELECT " + columns + " FROM " + table
    + " WHERE " + RECENT_DECISION_CARDS_PREDICATE + extra
    + " AND createdAt > ? ORDER BY createdAt DESC LIMIT " + limit;
}

/**
 * 回顾型元 finding 的确定性文本标记(命中任一即判回顾)。
 * 只保留**两个强信号**(都指向"一批上次发现", 而不是某条具体问题):
 *   ① `上次[<hex>/<hex>…]` —— 把上次发现的 dedupHash 列表回显出来;
 *   ② `上次…<N>项/条/个` —— 按条数回顾上次发现。
 * 刻意**不**把裸词 `dedupHash` 或 `上次反思发现` 当标记: 实测存在真实复发型 finding 形如
 *   "上次发现的Cron静默重复条目问题(dedupHash=07a9d2e271ba)依然存在, 未解决"
 *   "上次反思发现 BLOCKED 任务堆积问题在本次对话中部分得到解决…"
 * 它们引用的是**单条**具体问题, 属可执行 finding, 不能误伤(见回归负样本)。
 */
const RECAP_MARKERS: Array<[RegExp, string]> = [
  // 上次发现被以 hash 列表回显: "上次[66544bcbd901/6dd3aa7123d7]" / "上次发现[aaaaaa/bbbbbb/cccccc]"
  [/上次[^。；\n]{0,12}[\[【(（]\s*[0-9a-f]{6,}(?:\s*[\/、,]\s*[0-9a-f]{6,})+\s*[\]】)）]/, "正文回显上次发现的 hash 列表"],
  // 按条数回顾: "上次发现 10 项" / "上次反思的 10 条发现" / "上次的 10 个遗漏"
  [/上次[^。；\n]{0,10}\d+\s*(?:项|条|个)/, "正文按条数回顾上次发现"],
];

/** 判断 finding 是否为「回顾上次发现」的元 finding。返回命中的标记(便于审计)。 */
export function isRecapFinding(finding: any): { recap: boolean; marker: string } {
  const text = [finding?.what, finding?.background, finding?.requirement, finding?.evidenceSnippet]
    .map((x) => String(x ?? ""))
    .join("\n");
  if (!text) return { recap: false, marker: "" };
  for (const [re, label] of RECAP_MARKERS) {
    if (re.test(text)) return { recap: true, marker: label };
  }
  return { recap: false, marker: "" };
}

// =====================================================================================
// 2026-09-18 追加: 「同一主题已被处理过」跨反思判据 (机制修复第三段)
//
// 待办 todo_land_9jpxehcbq01m / 源卡 todo_e5bil1bz2x5did9n 实测:
//   人类回复 "B，这个是不是之前已经处理过了，已处理过的为什么还是会出任务让我决策？"
//   该卡主题 = finding「agent-h 硬件迁移继承」(dedupHash 7861df63, theme「功能验证」, MARK_REVIEW)。
//   平台库只读复算: 同一 relatedTopic 的 finding 在历史反思里已 RESOLVED **至少 8 次**
//     (cmt2rhagn…「agent-h 硬件迁移与数据继承」/ cmt41bb4f…「agent跨终端硬件继承」/
//      cmt4mshiy…「agent-h 继承」/ cmt6o7y0…「agent-h 跨终端迁移」/ cmt6ya5sh…「agent-h硬件迁移」/
//      cmt8dzvks…「agent-h 硬件继承」/ cmt9gfk4w…「agent-h 硬件迁移」/ cmtchryjs…「agent-h 硬件迁移」),
//   且人类 09-11/09-14/09-15 已就 agent-h 退役回捞、硬件迁移继承三次拍板 —— 却仍新开一张人类决策卡。
//
// 根因: 判据 A~D 只按 (finding 身份 / 业务域+事件类型) 去重, **不按「主题」去重**。而 finding 的
//   `relatedTopic` 是反思抽取出的**结构化**主题(非自由文本), 同一主题在不同反思里反复出现(措辞轻微漂移)。
//
// 修法(确定性, 只用结构化字段 relatedTopic, 不猜自由文本):
//   topicSimilarity(): 主题归一为「ASCII 实体(去 连字符/下划线/空格 后小写) + CJK 二元组」token 集, 取 Jaccard。
//     安全闸: 两主题必须共享至少一个 ASCII 实体(如 `agent-h`)才可能有分, 否则 0 分 —— 避免两个只共享
//     CJK 词(如「硬件迁移」)的不同主题被误判同一。主题无 ASCII 实体 -> 一律不抑制(保守)。
//   findDecidedTopicMatch(): 与「已 RESOLVED 的历史主题登记」比对, >= 0.65 记为"该主题已处理过"。
//
// 诚实边界:
//   - 只认 relatedTopic(结构化) + ASCII 实体闸; 纯中文主题(无 ASCII 实体)不参与 -> 宁可不抑制。
//   - 命中时只把卡开成 DROPPED 存档(带 matchedTopic/score/count/sampleFinding), 不静默丢弃; 新主题照常开卡。
// =====================================================================================
const TOPIC_MATCH_MIN_SCORE = 0.65;

/** ASCII 实体: 连续 ASCII 词(可含 空格/连字符/下划线)去分隔后小写, 长度>=3。如「agent-h」-> `agentut`。 */
export function topicEntities(topic: unknown): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z][A-Za-z0-9]*(?:[\s\-_][A-Za-z0-9]+)*/g;
  let m: RegExpExecArray | null;
  const s = String(topic ?? "");
  while ((m = re.exec(s)) !== null) {
    const e = m[0].replace(/[\s\-_]/g, "").toLowerCase();
    if (e.length >= 3) out.add(e);
  }
  return out;
}

/** 主题 token 集: ASCII 实体 + CJK 二元组。 */
export function topicTokens(topic: unknown): Set<string> {
  const tokens = new Set<string>(topicEntities(topic));
  const runs = String(topic ?? "").match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    if (run.length === 1) { tokens.add(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** 两主题相似度(Jaccard); 两主题都有 ASCII 实体但无交集 -> 0(安全闸, 防跨实体误判)。 */
export function topicSimilarity(a: unknown, b: unknown): number {
  const ea = topicEntities(a), eb = topicEntities(b);
  if (ea.size && eb.size) {
    let shared = false;
    for (const e of ea) { if (eb.has(e)) { shared = true; break; } }
    if (!shared) return 0;
  }
  const A = topicTokens(a), B = topicTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/** 主题聚合 key: 小写、去空白与常见标点(CJK 保留)。 */
export function topicKey(topic: unknown): string {
  return String(topic ?? "").toLowerCase().replace(/[\s,，。.；;：:「」『』“”"'（）()【】\[\]\-_/、]/g, "");
}

/** 「已 RESOLVED 的历史主题」登记行(loadResolvedTopics 聚合产物)。 */
export interface DecidedTopic {
  key: string;
  topic: string;
  count: number;
  sampleFindingId: string | null;
  sampleReflectionId: string | null;
}

/** 主题是否已被处理过的判据结果(纯数据, 便于写进卡 meta 审计)。 */
export interface DecidedTopicMatch {
  matched: boolean;
  score: number;
  topic?: string;
  count?: number;
  sampleFindingId?: string | null;
}

/**
 * 纯判据: 本 finding 的主题是否已由历史 RESOLVED finding 处理过。
 * 主题为空 / 无 ASCII 实体 / 无登记 -> matched=false(保守, 不抑制新问题)。
 */
export function findDecidedTopicMatch(
  topic: unknown, decided: DecidedTopic[] | undefined, minScore = TOPIC_MATCH_MIN_SCORE): DecidedTopicMatch {
  const t = String(topic ?? "").trim();
  if (!t || !Array.isArray(decided) || !decided.length) return { matched: false, score: 0 };
  if (!topicEntities(t).size) return { matched: false, score: 0 };
  let best: DecidedTopic | null = null;
  let bestScore = 0;
  for (const d of decided) {
    const s = topicSimilarity(t, d.topic);
    if (s > bestScore) { bestScore = s; best = d; }
  }
  if (best && bestScore >= minScore) {
    return { matched: true, score: Number(bestScore.toFixed(3)), topic: best.topic, count: best.count, sampleFindingId: best.sampleFindingId };
  }
  return { matched: false, score: Number(bestScore.toFixed(3)) };
}

/**
 * 读全库 FlywheelReflection.structuredFindings, 聚合「已 RESOLVED 且带 relatedTopic」的主题登记。
 * 只读; 失败返回 [] (非致命, 与 finding-closure-store 同口径)。
 */
export async function loadResolvedTopics(dbPath?: string): Promise<DecidedTopic[]> {
  try {
    const { parseStructuredFindings } = await import("./findings-parse");
    const rows: any[] = (await prisma.flywheelReflection.findMany({
      where: { structuredFindings: { not: null } },
      select: { id: true, structuredFindings: true },
    })) as any[];
    const agg = new Map<string, DecidedTopic>();
    for (const r of rows) {
      const findings = parseStructuredFindings(r.structuredFindings) as any[];
      for (const f of findings) {
        if (String(f?.status || "").toUpperCase() !== "RESOLVED") continue;
        const topic = String(f?.relatedTopic || "").trim();
        if (!topic) continue;
        const key = topicKey(topic);
        const prev = agg.get(key);
        if (prev) prev.count++;
        else agg.set(key, { key, topic, count: 1, sampleFindingId: f?.id ? String(f.id) : null, sampleReflectionId: String(r.id) });
      }
    }
    return [...agg.values()];
  } catch (e: any) {
    console.warn("[human-card-dedup] 读取已结单主题登记失败(非致命): " + String(e?.message || e).slice(0, 120));
    return [];
  }
}

/** 既有卡片的持久身份(从 Todo 表读出; 跨反思重算不丢)。 */
export interface ExistingCardIdentity {
  id: string;
  status: string;
  findingKey?: string | null;
  businessKey?: string | null;
  /**
   * 2026-10-09 round 73: 这张卡是不是"建卡即存档"(人类从未见过)? 由 identityFromTodoRow 从
   *   (status, meta.dedupAction) 读出, 与 isNeverPresentedCardMeta 同口径。
   *   decideHumanCard 的 sameFinding/sameBiz 命中时必须跳过 neverPresented=true 的锚点,
   *   否则同 finding/同业务问题会被自己的存档行永久静音(与 decideCueCooldown 同一缺陷)。
   */
  neverPresented?: boolean;
}

export type CardDecisionAction =
  | "CREATE"
  | "SKIP_FINDING_CLOSED"
  | "SKIP_RECAP_FINDING"
  | "SKIP_FINDING_ALREADY_RAISED"
  | "CREATE_AS_DROPPED"
  | "CREATE_AS_DROPPED_TOPIC"
  | "CREATE_AS_DROPPED_NOTICE"
  // 2026-09-18: cueKind 冷却命中(7 天内同 cueKind 已裁决或未结), 与 SKIP_FINDING_ALREADY_RAISED 等
  //   跳过类不同, 仍落一张 DROPPED 存档卡(留 dedupAction / dedupReason / dedupAgainstTodoId 可追溯)。
  | "CREATE_AS_DROPPED_CUE_COOLDOWN";

export interface CardDecision {
  action: CardDecisionAction;
  reason: string;
  existingTodoId?: string;
}

/**
 * 纯判据: 给定本 finding 的身份 + 既有卡片身份, 决定这张人类决策卡该不该开。
 * 顺序: 登记已裁决 > 回顾型 > 同 finding 已开 > 同业务问题已有卡 > 同主题已处理过 > 非决策通报 > 新建。
 */
export function decideHumanCard(input: {
  findingKey: string;
  businessKey: string;
  recap?: boolean;
  recapMarker?: string;
  closedByRegistry?: boolean;
  decidedTopic?: DecidedTopicMatch;
  /** 2026-09-18 (待办 todo_land_wf707ayvqbjp): 内容只是自纠/更正通报(见 self-correction-notice.ts) -> 不建卡。 */
  nonDecisionNotice?: boolean;
  existing: ExistingCardIdentity[];
}): CardDecision {
  const existing = Array.isArray(input.existing) ? input.existing : [];

  if (input.closedByRegistry) {
    return { action: "SKIP_FINDING_CLOSED", reason: "finding 已由 FindingClosure 登记表裁决结单, 不再开人类决策卡" };
  }
  if (input.recap) {
    return {
      action: "SKIP_RECAP_FINDING",
      reason: "回顾型元 finding(" + (input.recapMarker || "text marker") + "), 其回顾的各条 finding 会被逐条处置, 不另开人类决策卡",
    };
  }
  // 2026-10-09 round 73 (#自续期第二轴, todo_2982d542f9a948bd952f): 与 decideCueCooldown 同口径 ——
  //   建卡即存档的 DROPPED 卡(meta.dedupAction)人类从未见过, 不能当"已开过同 finding"的锚点, 否则
  //   同 finding/同业务问题会被自己的存档行永久静音。跳过它继续找真正的先例。
  const sameFinding = existing.find((c) => c.findingKey && c.findingKey === input.findingKey && !c.neverPresented);
  if (sameFinding) {
    return {
      action: "SKIP_FINDING_ALREADY_RAISED",
      reason: "同一 finding 已开过卡 " + sameFinding.id + "(" + sameFinding.status + "), 不重复开卡(跨反思重算持久去重)",
      existingTodoId: sameFinding.id,
    };
  }
  const sameBiz = existing.find((c) => c.businessKey && c.businessKey === input.businessKey && !c.neverPresented);
  if (sameBiz) {
    const terminal = sameBiz.status === "DONE" || sameBiz.status === "DROPPED";
    return {
      action: "CREATE_AS_DROPPED",
      reason: terminal
        ? "同一业务问题已有终态卡 " + sameBiz.id + "(" + sameBiz.status + "), 本轮只存档不再打扰人类"
        : "同一业务问题已有未决卡 " + sameBiz.id + "(" + sameBiz.status + ") 正在等人类回复, 本轮只存档避免重复刷屏",
      existingTodoId: sameBiz.id,
    };
  }
  if (input.decidedTopic?.matched) {
    return {
      action: "CREATE_AS_DROPPED_TOPIC",
      reason: "同一主题「" + String(input.decidedTopic.topic || "") + "」已被处理过: 历史上有 "
        + Number(input.decidedTopic.count || 1) + " 条已结单(RESOLVED) finding"
        + (input.decidedTopic.sampleFindingId ? "(如 " + input.decidedTopic.sampleFindingId + ")" : "")
        + ", 主题相似度 " + String(input.decidedTopic.score) + " -> 本轮只存档, 不再拿已处理过的主题打扰人类",
    };
  }
  // 2026-09-18 第四段(待办 todo_land_wf707ayvqbjp / 源卡 todo_35b447f57bf5408a8c6e):
  //   内容只是一条**自纠/更正通报**(agent 在更正自己上一条消息), 不是给人类的决策请求。
  //   证据: 人类早在该卡讨论区写过"这个任务需要我做什么，我没看出需要我决策的信息呀"。
  //   这类内容不该建【需您拍板】卡; 与前三段一致, 只落一张 DROPPED 存档(可追溯, 不打扰人类)。
  if (input.nonDecisionNotice) {
    return {
      action: "CREATE_AS_DROPPED_NOTICE",
      reason: "内容是一条自纠/更正通报(无决策请求: 无「要不要/是否/选项/请拍板」等), 人类无从拍板 -> 只落 DROPPED 存档, 不开人类决策卡",
    };
  }
  return { action: "CREATE", reason: "新 finding + 新业务身份 + 新主题" };
}

// =====================================================================================
// 2026-09-18 追加: 已开卡「作废/回收」判据 (机制修复第二段)
//
// 待办 todo_land_hd0898espkps / 源卡 todo_t3nwlm0mkw5didai 实测:
//   人类回复 "B，这个是不是之前已经处理过了，已处理过的为什么还是会出任务让我决策？"
//   上面 A~D 的判据只解决「**开卡时**去重」; 但它治不了已经躺在人类待办里的旧卡 ——
//   实测时间线(平台库只读复算, 均为 UTC):
//     · 10:15:03  reconcile 从 finding 「文档管理/f-002 Memory 容量」开出决策卡 todo_t3nwlm0mkw5didai
//     · 10:57:37  该卡由 legacy 格式迁移为业务语言决策卡
//     · 11:15:01  平台 FW-GROW 口径闸门把同一条 finding f-002 自动结单 PREMISE_SATISFIED
//                 (acceptance 已满足), 但**没有任何机制回收那张已开的人类卡**
//     · 13:08:37  人类才看到这张卡 -> 质问"已处理过为什么还出任务"
//   另一路实证: 16:30:03 开出的两张 OPEN 卡(todo_wfkvmykek25qwmid / todo_bf3yge70a95qwmjk)
//     其 originalTitle 都是**回顾型元 finding**(见 isRecapFinding) —— 本模块登记时本就会判
//     SKIP_RECAP_FINDING, 但它们是既存 OPEN 卡, 同样没人回收。
//
// 所以补第二段:**每次 reconcile 结束时扫一遍仍在 OPEN/DOING 的人类决策卡**, 命中以下任一即
//   把卡置 DROPPED(存档留痕, 不删除、不丢信息), 不再占着人类待办:
//     R1 回顾型元 finding(RECAP)          —— 与开卡判据 C 同口径;
//     R2 finding 已由 FindingClosure 登记  —— 与开卡判据 D 同口径(需 meta.theme 才判);
//     R3 卡所引用的 finding 平台侧已 RESOLVED —— 本卡(t3nwlm)正是这一类(晚结单)。
//   诚实边界: R3 只在**能唯一定位**到那条 finding 时才作废(dedupHash 精确匹配, 或 id+what 前缀
//   唯一命中); 定位不到 / 同名 id 多条且无法唯一定位 -> KEEP, 不误伤仍在等人类回复的真问题。
// =====================================================================================

export interface CardFindingRef {
  findingId: string | null;
  reflectionId: string | null;
  dedupHash: string | null;
  whatHint: string | null;
  theme: string | null;
}

const toStr = (v: unknown) => String(v ?? "");
/** 归一化用于「what 前缀」匹配: 去掉空白与常见中英标点, 避免排版差异造成假不匹配。 */
const hintNorm = (s: unknown) => toStr(s).replace(/\s+/g, "").replace(/[，,。.；;：:「」『』“”"'（）()【】\[\]]/g, "");

const FINDING_TITLE_RE = /finding\s+(f-[A-Za-z0-9_-]+)\s*[:：]\s*([\s\S]{0,200})/;
const THEME_RE = /主题\s*[「『"]([^」』"]+)[」』"]/;
const REFLECTION_RE = /reflection:([A-Za-z0-9_-]+)/;

/**
 * 从一张人类决策卡 Todo 行解析它引用的 finding 身份(兼容新旧 meta)。
 *  - 新卡: 直接读 meta.findingId / meta.reflectionId / meta.dedupHash / meta.theme;
 *  - legacy 迁移卡(实测 todo_t3nwlm0mkw5didai 就是): meta 里没有 findingId,
 *    从 meta.originalTitle / title 的 "finding f-00Y: <what…>" 回退解析, reflectionId 取 sourceRefId。
 */
export function findingRefFromCardRow(row: {
  id?: string; title?: string | null; detail?: string | null; sourceRefId?: string | null; meta?: unknown;
}): CardFindingRef {
  let m: any = {};
  try { m = row?.meta ? (typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta) : {}; } catch { m = {}; }
  const title = toStr(m?.originalTitle || row?.title);
  const detail = toStr(row?.detail);
  const hay = title + "\n" + detail;
  const tm = hay.match(FINDING_TITLE_RE);
  const findingId = toStr(m?.findingId) || (tm ? tm[1] : "") || null;
  const whatHint = tm ? tm[2].trim() : null;
  const srcRef = toStr(row?.sourceRefId);
  const reflectionId = toStr(m?.reflectionId) || (hay.match(REFLECTION_RE)?.[1] ?? "") || (srcRef.startsWith("cmr") ? srcRef : "") || null;
  const theme = toStr(m?.theme) || (title.match(THEME_RE)?.[1] ?? "") || null;
  const dedupHash = toStr(m?.dedupHash) || null;
  return { findingId, reflectionId, dedupHash, whatHint, theme };
}

/**
 * 在一条 reflection 的 findings 里唯一定位卡引用的那条 finding。
 * 定位不到 / 非唯一 -> null(宁可 KEEP 也不误伤)。
 */
export function matchCardFinding(ref: CardFindingRef, findings: any[]): any | null {
  if (!ref?.findingId || !Array.isArray(findings)) return null;
  const byId = findings.filter((f) => toStr(f?.id) === ref.findingId);
  if (!byId.length) return null;
  if (ref.dedupHash) {
    return byId.find((f) => toStr(f?.dedupHash) === ref.dedupHash) || null;
  }
  if (ref.whatHint) {
    const h = hintNorm(ref.whatHint).slice(0, 30);
    if (h.length < 6) return null;   // 前缀太短不足以唯一定位
    const hits = byId.filter((f) => hintNorm(f?.what || f?.requirement).startsWith(h));
    return hits.length === 1 ? hits[0] : null;
  }
  return null;
}

export type RetireAction = "KEEP" | "RETIRE_REGISTRY_CLOSED" | "RETIRE_RECAP" | "RETIRE_FINDING_RESOLVED" | "RETIRE_TOPIC_ALREADY_DECIDED" | "RETIRE_CUE_COOLDOWN";

export interface RetireDecision { retire: boolean; action: RetireAction; reason: string }

/**
 * 纯判据: 一张**已开**的人类决策卡该不该回收作废。
 * 顺序: 登记已裁决 > 回顾型 > 引用 finding 已 RESOLVED > 同主题已处理过 > 同 cueKind 已冷却 > 保留。
 */
export function decideCardRetraction(input: {
  recap?: boolean; recapMarker?: string;
  closedByRegistry?: boolean;
  findingMatched?: boolean; findingStatus?: string | null;
  decidedTopic?: DecidedTopicMatch;
  // 2026-09-18(待办 todo_12fd4ee07e6b41998b77 / 升级任务 "spec:no-repeat-decision-cards"):
  //   此前只覆盖了 finding 状态 / 主题 / 回顾型 / FindingClosure 四类 ——
  //   漏装 cueKind 冷却这一段, 结果同 cueKind 的卡可绕过开卡期 decideCueCooldown 反复开出。
  //   现统一收口: 同 cueKind(7 天内已有已裁决的同类卡)也要作废, 与开卡期 decideCueCooldown 同口径。
  cueCooldownHit?: boolean;
  cueCooldownReason?: string;
}): RetireDecision {
  if (input.closedByRegistry) {
    return { retire: true, action: "RETIRE_REGISTRY_CLOSED",
      reason: "卡所引用的 finding 已由 FindingClosure 登记表裁决结单, 该卡作废(不再占人类待办)" };
  }
  if (input.recap) {
    return { retire: true, action: "RETIRE_RECAP",
      reason: "回顾型元 finding 开出的人类决策卡(" + (input.recapMarker || "text marker") + "), 其回顾的各条 finding 会被逐条处置, 该卡作废" };
  }
  const st = toStr(input.findingStatus).toUpperCase();
  if (input.findingMatched && st === "RESOLVED") {
    return { retire: true, action: "RETIRE_FINDING_RESOLVED",
      reason: "卡所引用的 finding 平台侧已结单(RESOLVED), 该卡已成马后炮, 自动作废" };
  }
  if (input.findingMatched && input.decidedTopic?.matched) {
    return { retire: true, action: "RETIRE_TOPIC_ALREADY_DECIDED",
      reason: "卡所引用的 finding 主题「" + String(input.decidedTopic.topic || "") + "」已被处理过(历史 "
        + Number(input.decidedTopic.count || 1) + " 条已结单, 相似度 " + String(input.decidedTopic.score) + "), 该卡作废" };
  }
  // 2026-09-18 cue 冷却兜底(待办 todo_12fd4ee07e6b41998b77): 与开卡期 decideCueCooldown 同口径,
  //   命中即作废(DROPPED 存档), 不再占人类待办。原因同 29 轮 decision-card-cooldown-gap 文档
  //   第 1 节: 闸门只装在一条路径上 -> 漏装路径新开的卡只能事后抑制。
  if (input.cueCooldownHit) {
    return { retire: true, action: "RETIRE_CUE_COOLDOWN",
      reason: String(input.cueCooldownReason || "同类问题(同 cueKind)已在 7 天内问过, 该卡作废").slice(0, 240) };
  }
  return { retire: false, action: "KEEP",
    reason: "finding 仍未结单且非回顾型, 保留该卡继续等人类回复" };
}

/** 从一张 Todo 行解析出持久身份(兼容新旧 meta 形态; 解析不出对应键则为 null)。 */
export function identityFromTodoRow(row: { id: string; status: string; sourceRefId?: string | null; meta?: unknown }): ExistingCardIdentity {
  if (!row || row.id == null) return { id: "", status: "", findingKey: null, businessKey: null, neverPresented: false };
  let m: any = {};
  try {
    m = row?.meta ? (typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta) : {};
  } catch { m = {}; }
  const theme = String(m?.theme || "");
  const findingId = String(m?.findingId || "");
  let findingKey: string | null = null;
  if (m?.findingKey) findingKey = String(m.findingKey);
  else if (theme && findingId) {
    // 兼容旧卡(无 meta.findingKey): 用 meta.theme + meta.findingId 反算(findings 无 dedupHash 时用 id 兜底)。
    findingKey = findingCardKey(theme, { id: findingId, dedupHash: m?.dedupHash || "" });
  }
  let businessKey: string | null = null;
  if (m?.businessKey) businessKey = String(m.businessKey);
  else {
    // 兼容两种 meta 形态: reconcile-findings 迁移卡写 `businessDomain`;
    // improving-tasks SLA 卡(2026-09-18 前)写的是 `domain` —— 两者都要能反算 businessKey,
    // 否则历史 SLA 卡在持久去重里"隐身", 同一业务问题会被反复开出来(见 execute-improving-task.ts 注释)。
    const bd = m?.businessDomain || m?.domain;
    if (bd && m?.cueKind) businessKey = businessCardKey(String(bd), String(m.cueKind));
  }
  return { id: String(row.id), status: String(row.status), findingKey, businessKey, neverPresented: isNeverPresentedCardMeta(row.status, m) };
}

/**
 * 读取既有决策卡的持久身份集合。
 * 走 better-sqlite3 原生(与 todo-store / human-decision-consumer 同套路: Todo 是运行期自建表)。
 * 只读; 失败返回 [] (非致命, 与 finding-closure-store 同口径)。
 */
export async function loadExistingCardIdentities(dbPath?: string): Promise<ExistingCardIdentity[]> {
  try {
    // 只取人类决策卡: 三个产卡来源, 或带 decision-card-language 产出的业务身份标记的卡。
    // 2026-09-17 独立复核 R1: 原实现还带 `meta LIKE '%"findingKey"%'`, 会把 13 条
    //   `agent:* 巡检反馈` 卡(agent-finding.ts 用**另一套算法**生成的 16 位 findingKey)也拉进来;
    //   实测 0 碰撞(长度都不同: 本模块 32 位 vs 巡检 16 位), 但语义不对 -> 去掉该 clause。
    // 2026-09-18 机制修复(待办 todo_land_55gli7ggjrny): 补 `platform:improving-tasks` 与 `"cueKind"` ——
    //   SLA 决策卡(source=platform:improving-tasks, meta 只写 domain+cueKind)此前**完全不在**加载范围,
    //   于是同 businessKey 的卡被反复开出。补上后 SLA 卡与 reconcile 卡进入同一张身份表, 跨产线去重。
    const rows: any[] = (await todoRepoFor(dbPath).all(
      "SELECT id,status,sourceRefId,meta FROM Todo " +
      "WHERE source IN ('human-decision:card','auto-review:human-only','platform:improving-tasks') " +
      "   OR meta LIKE '%\"businessDomain\"%' " +
      "   OR meta LIKE '%\"cueKind\"%'"
    )) as any[];
    return rows.map(identityFromTodoRow);
  } catch (e: any) {
    console.warn("[human-card-dedup] 读取既有卡身份失败(非致命): " + String(e?.message || e).slice(0, 120));
    return [];
  }
}
