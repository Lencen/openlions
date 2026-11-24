/**
 * human-card-retire.ts — 已开人类决策卡的「回收/作废」扫描 (2026-09-18 机制修复第二段)
 *
 * 背景 / 实测(平台库只读复算, UTC):
 *   · 10:15:03  reconcile 开出决策卡 todo_t3nwlm0mkw5didai(主题「文档管理」finding f-002 Memory 容量)
 *   · 11:15:01  同一条 finding f-002 被平台 FW-GROW 口径闸门自动结单(PREMISE_SATISFIED)
 *               —— 但那张已开的人类卡**没有任何机制回收**
 *   · 13:08:37  人类看到卡后质问: "这个是不是之前已经处理过了，已处理过的为什么还是会出任务让我决策？"
 *   另一路: 16:30:03 的两张 OPEN 卡(todo_wfkvmykek25qwmid / todo_bf3yge70a95qwmjk)是**回顾型元 finding**
 *          开出的人类卡(本模块开卡判据本会 SKIP_RECAP_FINDING, 但它们是既存 OPEN 卡)。
 *
 * 判据见 human-card-dedup.ts 的 decideCardRetraction()(纯函数, 已单测):
 *   R1 回顾型元 finding / R2 finding 已由 FindingClosure 登记结单 / R3 引用 finding 已 RESOLVED。
 * 本模块只做 IO:
 *   - loadOpenHumanDecisionCards(): 读 OPEN/DOING 的人类决策卡(better-sqlite3, Todo 是运行期自建表);
 *   - loadReflectionFindings(): 读卡的源反思 structuredFindings(只读);
 *   - sweepStaleHumanCards({apply}): apply=false 时 **纯只读 dry-run**(绝不写库), apply=true 才 UPDATE 为 DROPPED。
 *   作废是**存档**: status=DROPPED + note/meta 留痕(retiredBy/retiredReason/retiredAt), 不删行、不丢信息。
 */
import { todoRepoFor } from "@/server/lib/todo-repo";
import { prisma } from "@/lib/prisma";
import { parseStructuredFindings } from "./findings-parse";
import {
  findingRefFromCardRow, matchCardFinding, decideCardRetraction, isRecapFinding, findDecidedTopicMatch,
  decideCueCooldown, recentDecisionCardsSql, CARD_COOLDOWN_MS,
  type CardFindingRef, type DecidedTopic,
} from "./human-card-dedup";

export interface OpenCardRow {
  id: string; status: string; title: string | null; detail: string | null;
  sourceRefId: string | null; meta: unknown;
}

export interface SweepResult {
  scanned: number;
  retired: number;
  kept: number;
  actions: Record<string, number>;
  details: Array<{ id: string; action: string; findingId: string | null; reason: string }>;
  errors: string[];
}

/** 读仍在等人类回复(OPEN/DOING)的人类决策卡。只读; 失败抛错由调用方转统计。 */
export async function loadOpenHumanDecisionCards(dbPath?: string): Promise<OpenCardRow[]> {
  const repo = todoRepoFor(dbPath);
  const rows: any[] = (await repo.all(
    "SELECT id,status,title,detail,sourceRefId,meta FROM Todo WHERE status IN ('OPEN','DOING')")) as any[];
  return rows.filter((r) => {
    try { return JSON.parse(String(r.meta || "{}"))?.kind === "HUMAN_DECISION_CARD"; } catch { return false; }
  }).map((r) => ({ id: String(r.id), status: String(r.status), title: r.title, detail: r.detail, sourceRefId: r.sourceRefId, meta: r.meta }));
}

/** 按 reflection id 批量读 structuredFindings。只读。 */
export async function loadReflectionFindings(ids: string[], dbPath?: string): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const rows: any[] = (await prisma.flywheelReflection.findMany({
    where: { id: { in: uniq } },
    select: { id: true, structuredFindings: true },
  })) as any[];
  for (const row of rows) out.set(String(row.id), parseStructuredFindings(row.structuredFindings));
  return out;
}

/** 把一张人类决策卡作废为 DROPPED(存档留痕)。写库; 返回是否命中 1 行。 */
export async function retireHumanDecisionCard(
  todoId: string, action: string, reason: string, findingId: string | null, dbPath?: string,
  // 2026-09-18 cue 冷却兜底(待办 todo_12fd4ee07e6b41998b77): 若未结同类卡作为归宿, 把自身
  //   来源并入归宿卡的 meta.alsoFrom(一卡多源, 信息不丢) —— 与 todos POST 入口 195-202 行口径同。
  mergeIntoTodoId?: string | null): Promise<boolean> {
  const repo = todoRepoFor(dbPath);
  {
    const row: any = await repo.get("SELECT meta FROM Todo WHERE id = ?", todoId);
    if (!row) return false;
    let meta: any = {};
    try { meta = JSON.parse(String(row.meta || "{}")); } catch { meta = {}; }
    meta.retiredBy = "reconcile-findings";
    meta.retiredAction = action;
    meta.retiredReason = reason;
    meta.retiredAgainstFindingId = findingId;
    meta.retiredAt = new Date().toISOString();
    // 未结同类卡的归宿: 把自身关键字段并入归宿卡的 meta.alsoFrom, 信息不丢。
    if (mergeIntoTodoId) {
      try {
        const dest: any = await repo.get("SELECT meta FROM Todo WHERE id = ?", mergeIntoTodoId);
        if (dest) {
          let dm: any = {};
          try { dm = JSON.parse(String(dest.meta || "{}")); } catch { dm = {}; }
          dm.alsoFrom = Array.isArray(dm.alsoFrom) ? dm.alsoFrom : [];
          dm.alsoFrom.push({
            via: "retire-cue-cooldown-merge",
            at: new Date().toISOString(),
            retiredTodoId: todoId,
            retiredAction: action,
            retiredReason: reason.slice(0, 200),
            title: String(meta?.originalTitle || row.title || "").slice(0, 200),
          });
          await repo.run("UPDATE Todo SET meta=?, updatedAt=? WHERE id=?", JSON.stringify(dm), Date.now(), mergeIntoTodoId);
          meta.retiredMergedIntoTodoId = mergeIntoTodoId;
        }
      } catch { /* 并入失败不影响自身作废 */ }
    }
    const info = await repo.run(
      "UPDATE Todo SET status='DROPPED', note=COALESCE(note,'')||?, meta=?, updatedAt=? WHERE id=? AND status IN ('OPEN','DOING')",
      " [2026-09-18 自动作废: " + reason + "]", JSON.stringify(meta), Date.now(), todoId);
    return info.changes === 1;
  }
}

/**
 * 扫描并(可选)作废陈旧的已开人类决策卡。
 * @param apply false = 只读 dry-run(默认安全); true = 真正 UPDATE 为 DROPPED。
 * @param closures 可选的 FindingClosure 登记行(由调用方传入, 避免本模块依赖 prisma); 不传则跳过 R2。
 */
export async function sweepStaleHumanCards(opts: {
  apply?: boolean; dbPath?: string; closures?: any[]; decidedTopics?: DecidedTopic[];
  log?: (msg: string) => void;
} = {}): Promise<SweepResult> {
  const apply = !!opts.apply;
  const log = opts.log || (() => {});
  const result: SweepResult = { scanned: 0, retired: 0, kept: 0, actions: {}, details: [], errors: [] };
  const cards = await loadOpenHumanDecisionCards(opts.dbPath);
  result.scanned = cards.length;
  if (!cards.length) return result;

  const refs = new Map<string, CardFindingRef>();
  for (const c of cards) refs.set(c.id, findingRefFromCardRow(c));
  const findingsByRefl = await loadReflectionFindings(
    [...refs.values()].map((r) => r.reflectionId).filter(Boolean) as string[], opts.dbPath);

  for (const c of cards) {
    try {
      const ref = refs.get(c.id)!;
      const findings = ref.reflectionId ? (findingsByRefl.get(ref.reflectionId) || []) : [];
      const matched = matchCardFinding(ref, findings);
      const recap = isRecapFinding({ what: [c.title, c.detail, ref.whatHint].map((x) => String(x ?? "")).join("\n") });
      const closedByRegistry = !!matched && Array.isArray(opts.closures) && opts.closures.length > 0 && !!ref.theme &&
        opts.closures.some((cl) => {
          const sameTheme = String(cl?.theme || "") === String(ref.theme);
          const sameKey = String(cl?.subjectKey || "") === String(ref.findingId || "") ||
            String(cl?.subjectSuffix || "") === String(ref.findingId || "");
          return sameTheme && (sameKey || findingClosureTextMatch(cl, matched));
        });
      // 2026-09-21 cue 冷却兜底 LIMIT 漏洞修复(待办 todo_1224d063bdcd4226ab07 / spec:no-repeat-decision-cards):
      //   旧实现 recentCards 查询是 `LIMIT 100` 全库窗口拉卡, 当 7 天内 HUMAN_DECISION_CARD 超过 100 张时,
      //   早期同类已裁决卡(9/18 05:15 migration-stuck 那张)会被截断, sweeper 把所有同 cueKind OPEN 卡
      //   都 KEEP —— 闸门 hit=false -> spec FAIL.
      //   修法: recentCards **三路并入**确保同 cueKind 任何 7 天内同类卡都查得到:
      //     (a) 全库窗口 LIMIT 4000(2026-09-21 由 100 提到 1000; 2026-09-28 条件合并时统一到 4000 单一来源);
      //     (b) 同 cueKind 的卡锚定查(LIMIT 200, 不计 (a));
      //     (c) 兜底类型(cueKind ∈ {generic,other,''})同域名锚定查(LIMIT 200)。
      //   去重后交给 decideCueCooldown, 自身时间戳不在 others 里 -> 自然不会自我命中。
      let cueCooldownHit = false; let cueCooldownReason = "";
      let cueCooldownTerminal = true; let cueCooldownExistingId: string | null = null;
      try {
        let cm: any = {};
        try { cm = JSON.parse(String(c.meta || "{}")); } catch { cm = {}; }
        const cue = String(cm.cueKind || "").trim();
        const dom = String(cm.businessDomain || cm.domain || "").trim();
        if (cue) {
          // 2026-09-28 条件合并(收件箱待办 todo_18b7e59cb88144c2a6a2): 三路查询全部改用 human-card-dedup 的
          //   唯一谓词/构造函数(recentDecisionCardsSql) —— 原先三处各拼一次 `meta LIKE '%HUMAN_DECISION_CARD%'`,
          //   与另两条开卡路径的 `ownerType='human'` 口径分叉(全库差集 339 张)。上限同步用 4000(原 1000)。
          const recent: any[] = await (async () => {
            try {
              const repo = todoRepoFor(opts.dbPath);
              return (await repo.all(
                recentDecisionCardsSql({ table: "Todo", columns: "id, status, meta, createdAt" })
              , Date.now() - CARD_COOLDOWN_MS)) as any[];
            } catch { return []; }
          })();
          // 同 cueKind 锚定查询:不论全库窗口多拥挤, 同 cueKind 的卡都查回来(2026-09-21 修复)。
          const sameCue: any[] = await (async () => {
            try {
              const repo = todoRepoFor(opts.dbPath);
              return (await repo.all(
                  recentDecisionCardsSql({ table: "Todo", columns: "id, status, meta, createdAt", limit: 200, extraWhere: "meta LIKE ?" })
                , "%\\\"cueKind\\\":\\\"" + cue + "\\\"%", Date.now() - CARD_COOLDOWN_MS)) as any[];
            } catch { return []; }
          })();
          // 兜底类型(cueKind ∈ {generic,other,''})必须域名也一致(2026-09-18 误吞修正):
          //   同 cueKind 已查过, 这里只对 domains 短的兜底类型再补一道"同域名"查询避免截断。
          const CATCH_ALL = new Set(["generic", "other", ""]);
          const sameCueDom: any[] = (CATCH_ALL.has(cue.toLowerCase()) && dom) ? await (async () => {
            try {
              const repo = todoRepoFor(opts.dbPath);
              return (await repo.all(
                  recentDecisionCardsSql({ table: "Todo", columns: "id, status, meta, createdAt", limit: 200, extraWhere: "meta LIKE ? AND meta LIKE ?" })
                , "%\\\"cueKind\\\":\\\"" + cue + "\\\"%", "%" + dom.replace(/[\\\\%_]/g, "\\$&") + "%", Date.now() - CARD_COOLDOWN_MS)) as any[];
            } catch { return []; }
          })() : [];
          // 三路并入去重
          const merged = (() => {
            const m = new Map<string, any>();
            for (const r of (recent || [])) m.set(String(r.id), r);
            for (const r of (sameCue || [])) m.set(String(r.id), r);
            for (const r of (sameCueDom || [])) m.set(String(r.id), r);
            return [...m.values()];
          })();
          // 排除自身(否则自己跟自己比较一定命中)
          const others = merged.filter((r) => String(r.id) !== String(c.id));
          const dec = decideCueCooldown({ cueKind: cue, domain: dom, recentCards: others, windowDays: 7 });
          if (dec.hit) {
            cueCooldownHit = true;
            cueCooldownReason = dec.reason;
            cueCooldownTerminal = !!dec.terminal;
            cueCooldownExistingId = dec.existingTodoId ? String(dec.existingTodoId) : null;
          }
        }
      } catch { /* cue cooldown 检查失败按 KEEP 处理(不阻断) */ }
      const verdict = decideCardRetraction({
        recap: recap.recap, recapMarker: recap.marker,
        closedByRegistry,
        findingMatched: !!matched, findingStatus: matched ? String(matched.status || "") : null,
        // 2026-09-18 第三段: 卡引用的 finding 主题已被历史 RESOLVED finding 处理过 -> 作废。
        decidedTopic: matched ? findDecidedTopicMatch(matched.relatedTopic, opts.decidedTopics) : undefined,
        // 2026-09-18 cue 冷却兜底: 与开卡期 decideCueCooldown 同口径, 命中即作废。
        cueCooldownHit, cueCooldownReason,
      });
      if (!verdict.retire) { result.kept++; result.details.push({ id: c.id, action: "KEEP", findingId: ref.findingId, reason: verdict.reason }); continue; }
      if (apply) {
        // 2026-09-18 cue 冷却兜底: 若同类命中卡为未结(terminal=false), 把归宿卡 id 也带过去,
        //   retireHumanDecisionCard 会把自身来源并入归宿卡的 meta.alsoFrom(一卡多源)。
        const mergeInto = (verdict.action === "RETIRE_CUE_COOLDOWN" && cueCooldownHit && !cueCooldownTerminal) ? cueCooldownExistingId : null;
        const ok = await retireHumanDecisionCard(c.id, verdict.action, verdict.reason, ref.findingId, opts.dbPath, mergeInto);
        if (!ok) { result.errors.push(c.id + ": UPDATE 未命中(状态已变?)"); continue; }
      }
      result.retired++;
      result.actions[verdict.action] = (result.actions[verdict.action] || 0) + 1;
      result.details.push({ id: c.id, action: verdict.action, findingId: ref.findingId, reason: verdict.reason });
      log("[human-card-retire] " + (apply ? "作废" : "dry-run 拟作废") + " " + c.id + " -> " + verdict.action + ": " + verdict.reason);
    } catch (e: any) {
      result.errors.push(c.id + ": " + String(e?.message || e).slice(0, 160));
    }
  }
  return result;
}

/** 登记行的文本匹配兜底(与 finding-closure-store.findingMatchesClosure 同口径的轻量版)。 */
function findingClosureTextMatch(cl: any, finding: any): boolean {
  const suffix = String(cl?.subjectSuffix || "").trim();
  if (!suffix) return false;
  const hay = [finding?.what, finding?.requirement, finding?.evidenceSnippet].map((x) => String(x ?? "")).join("\n");
  return hay.includes(suffix);
}
