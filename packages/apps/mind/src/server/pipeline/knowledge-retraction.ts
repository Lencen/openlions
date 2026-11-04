/**
 * knowledge-retraction.ts — 被推翻结论的撤回流程 (2026-09-15, 由待办 todo_c4869259208d4a748fb9 升级)
 *
 * 问题(实测, 2026-09-14):
 *   Knowledge/Skill 早就有 stale / staleReason / supersededBy / supersededAt 四个字段(通道存在),
 *   但**没有任何流程**:
 *     ① 谁在什么条件下撤回 —— 没有入口, 只能人肉 UPDATE;
 *     ② 同一会话后续显式推翻前结论 —— 提炼器只做 contentHash 去重, 后出现的"我收回刚才那条"被当成
 *        一条新知识(或直接 dup 跳过), **前一条错误结论继续留在活性集合并污染检索/注入**;
 *     ③ 撤回后是否立即生效 —— 检索口(portal)有过滤, 但注入(context-seed Skill)与去重强化
 *        (resolver / execute-improving-task 的 `stale: false`)**没有过滤**, 撤回的结论会被重新强化甚至复活。
 *
 * 本模块提供:
 *   - 纯函数 `detectRetractionCues()`  : 从有序会话消息中识别"显式推翻/撤回"的语句(带否定语境护栏)
 *   - 纯函数 `matchRetractionsToKnowledge()` : 把撤回语句匹配到**同一会话来源**的知识行(id 优先, 其次词元重叠)
 *   - 副作用函数 `retractKnowledge()`   : 落 stale + staleReason + supersededBy(校验目标存在) + verification=REJECTED,
 *                                          并写 AuditLog(action=RETRACT) 与 FlywheelEvent(stage=RETRACTION); 幂等
 *   - 编排函数 `planSessionRetractions()`: 会话消息 + 该会话知识行 -> 匹配 -> 撤回(供提炼器/扫描器调用)
 *
 * 设计边界(诚实声明):
 *   - 规则法只认**显式**撤回措辞(撤回/收回/更正/我错了/不成立 ...)。
 *   - **自动改库**只有两条路: ① 句子显式点名 Knowledge id; ② 第一人称撤回(我收回/我撤回/我错了/
 *     我说错 —— SELF_VERB_RE, 即 `strongSelfRetraction`)。弱回指(那条/该结论/本通道/前述)只把命中
 *     作为候选返回人工入口, **不给自动权**。2026-09-15 实测: 放开弱回指时 500 会话干跑出 3 条
 *     auto=true 全是 taskexec 机器任务正文的假阳性("列出该结论不成立的 3 类反例路径")。
 *     宁可漏, 不可错杀 —— 无人值守的 timer 只能跑这条严格路径。
 *   - 会话内没有"知识行在原文中的位置"索引, 因此无法严格证明"撤回发生在结论之后"; 只按同一会话 + 显式
 *     撤回措辞判定。需要位置级溯源时用人工入口点名 id。
 */

// ============================================================
// 0. 最小 DB 接口 (兼容 better-sqlite3, 便于脚本/路由共用)
// ============================================================
export interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}
export interface SqliteLikeDb {
  prepare(sql: string): SqlStatement;
  transaction?<T extends (...args: never[]) => unknown>(fn: T): T;
}

// ============================================================
// 1. 类型
// ============================================================
export interface SessionMessage {
  role: string;
  content: string;
  /** epoch ms, 可选 */
  timestamp?: number | null;
  /** 会话内序号(升序), 可选 */
  seq?: number | null;
}

export interface RetractionCue {
  /** 在传入消息数组中的下标(升序) */
  msgIndex: number;
  seq: number | null;
  timestamp: number | null;
  role: string;
  /** 命中的撤回动词 */
  verb: string;
  /** 证据句(去空白, 截断 240 字) */
  sentence: string;
  /** 从证据句里抽出的被撤回对象线索 */
  targetHint: string;
  /** 句子中显式出现的 Knowledge id */
  explicitIds: string[];
  /** 是否自指式撤回(有回指词) —— 仅作**报告信号**, 不给自动权 */
  selfRetraction: boolean;
  /**
   * 第一人称撤回(我收回/我撤回/我错了/我说错...)。
   * 只有它(或显式点名 Knowledge id)才够格**自动**改库; 弱回指(那条/该结论/本通道)只进人工候选。
   * 2026-09-15 实测: `taskexec:` 会话的机器生成任务正文("【候选全文】…列出该结论不成立的 3 类反例路径",
   *   "…更新那条,另一条标 SUPERSEDED")靠"该结论/那条"被误判自指, 500 会话干跑出 3 条 auto=true
   *   全部是假阳性 —— 若挂上无人值守的 timer 会误杀正确知识。
   */
  strongSelfRetraction: boolean;
}

export interface RetractionCandidate {
  id: string;
  title: string;
  content: string;
  createdAt?: number | null;
}

export interface RetractionMatch {
  cue: RetractionCue;
  knowledgeId: string;
  title: string;
  score: number;
  matchedTerms: string[];
  /** 自动应用资格: 自指式 或 点名 id; 否则仅作为人工候选 */
  autoApplicable: boolean;
  reason: string;
}

export interface RetractTarget {
  id: string;
  title: string;
  staleBefore: boolean;
  staleReasonBefore: string | null;
  supersededByBefore: string | null;
  verificationBefore: string | null;
}

export interface RetractParams {
  /** 精确点名要撤回的 Knowledge id */
  ids?: string[];
  /** 追加匹配: 标题/正文 LIKE */
  query?: string;
  /** 追加匹配: 只撤回该来源会话产出的知识 */
  sourceId?: string;
  /** 撤回原因(必填, 会写进 staleReason) */
  reason: string;
  /** 撤回人(agent id / human id) */
  actor: string;
  actorType?: string;
  /** 取代者 id; 提供时必须真实存在, 否则整体拒绝(避免悬空指针) */
  supersededBy?: string | null;
  /** 是否把 verification 置 REJECTED(与库内既有 3 条手工撤回口径一致, 默认 true) */
  markVerification?: boolean;
  dry?: boolean;
  now?: number;
}

export interface RetractOutcome {
  id: string;
  title: string;
  action: "RETRACTED" | "WOULD_RETRACT" | "SKIPPED";
  why: string;
}

export interface RetractResult {
  retracted: RetractOutcome[];
  skipped: RetractOutcome[];
  supersededBy: string | null;
  auditIds: string[];
  eventIds: string[];
}

// ============================================================
// 2. 显式撤回措辞
// ============================================================
/** 撤回动词(命中其一即候选); 顺序不影响结果 */
export const RETRACTION_VERBS: Array<{ name: string; re: RegExp }> = [
  { name: "撤回", re: /撤回/ },
  { name: "收回", re: /收回/ },
  { name: "作废", re: /作废/ },
  { name: "撤销", re: /撤销/ },
  { name: "推翻", re: /推翻/ },
  { name: "更正", re: /更正/ },
  { name: "纠正", re: /纠正/ },
  { name: "勘误", re: /勘误/ },
  { name: "改口", re: /改口/ },
  { name: "自证伪", re: /证伪/ },
  { name: "我错了", re: /我(?:错|说错|判断错|搞错|弄错)了/ },
  { name: "结论不成立", re: /(?:结论|判断|说法|前提)[^。！？!?\n]{0,12}不成立/ },
  { name: "是错的", re: /(?:结论|判断|说法|前提|理解)[^。！？!?\n]{0,8}(?:是错|有误|错误|不对|站不住)/ },
  { name: "以此为准", re: /以[^。！？!?\n]{0,20}(?:为准|为对)/ },
  { name: "retract", re: /\bretract(?:ed|ion|s)?\b/i },
  { name: "supersede", re: /\bsupersede[sd]?\b/i },
  { name: "i-was-wrong", re: /\b(?:i\s+was\s+wrong|that\s+was\s+wrong|my\s+mistake)\b/i },
  { name: "correction", re: /\bcorrection\s*[::]/i },
];

/** 否定语境护栏: 这些说法里的"撤回"不是撤回行为本身 */
const NEGATED_CUE_RE =
  /(?:不能|不可|无法|不会|不得|禁止|拒绝|不予|尚未|未曾|没有|并未|未)\s*(?:撤回|收回|作废|撤销|推翻|更正|纠正)|(?:撤回|收回|撤销|更正)(?:功能|入口|按钮|接口|流程|机制|测试)/;

/**
 * 回指词: 说明撤回的是"我刚才/上面那条"结论。
 *
 * ⚠️ 2026-09-15 实测假阳性修复: `本通道` 必须排除"文**本通道**" —— 真实 VERIFY_AGENT_OUTPUT
 *   会话里 "候选承重断言「文本通道抢到需工具任务会『认领即失败』」—— 证伪" 因 "文本通道" 被
 *   当成自指, 该 cue 升级为 autoApplicable, 差点自动撤回**被它佐证的正确结论**
 *   (cmu21070100f1fpk7z9 "认领后超时而非认领即失败")。加负向后顾后该 cue 降级为人工候选。
 */
const SELF_REF_RE =
  /(?:本人|本会话|(?<!文)本通道|前述|之前|前面|上面|刚才|刚刚|上一条|上面那(?:条|个)|刚才那(?:条|个)|那条|该条|此条|这条|原结论|该结论|此结论|此判断|我(?:说|判断|给出|列|写)的)/;

/** 动词本身就是第一人称自指(我错了/我收回...) -> 也算自指撤回 */
const SELF_VERB_RE = /我(?:撤回|收回|更正|纠正|作废|撤销|说错|判断错|搞错|弄错|错)/;

const CUID_RE = /\bc[a-z0-9]{15,}\b/g;
const QUOTED_RE = /[「『“"《]([^」』”"》]{2,120})[」』”"》]/g;
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g;
const ASCII_TOKEN_RE = /[a-z0-9][a-z0-9_.\-/]{2,}/gi;

const STOP_TOKENS = new Set([
  "the", "and", "for", "with", "that", "this", "was", "are", "not", "但是", "而且",
  "所以", "因为", "这个", "那个", "我们", "他们", "结论", "问题", "没有", "不是",
]);

// ============================================================
// 3. 纯函数: 分句 / 词元
// ============================================================
function splitSentences(text: string): Array<{ s: string; at: number }> {
  const out: Array<{ s: string; at: number }> = [];
  const re = /[^。！？!?\n;；]+[。！？!?\n;；]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw.trim()) out.push({ s: raw.trim(), at: m.index });
  }
  return out;
}

/** 词元: ASCII 词(len>=3) + 中文 2-gram; 去停用词 */
export function tokenize(text: string): Set<string> {
  const toks = new Set<string>();
  const t = String(text || "");
  for (const m of t.match(ASCII_TOKEN_RE) || []) {
    const w = m.toLowerCase();
    if (!STOP_TOKENS.has(w)) toks.add(w);
  }
  for (const run of t.match(CJK_RUN_RE) || []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!STOP_TOKENS.has(g)) toks.add(g);
    }
  }
  return toks;
}

// ============================================================
// 4. 纯函数: 撤回线索识别
// ============================================================
export function detectRetractionCues(messages: SessionMessage[]): RetractionCue[] {
  const cues: RetractionCue[] = [];
  if (!Array.isArray(messages)) return cues;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = String(msg?.content || "");
    if (!content.trim()) continue;
    // 只认**参与者说的话**(user/assistant)。tool/toolResult/system 里是工具回显、任务材料、
    //   文档正文 —— 实测: 一个 challenge 文档里的"结论不成立的情形"会被当成撤回线索并误命中。
    const role = String(msg.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    for (const sent of splitSentences(content)) {
      const s = sent.s;
      if (NEGATED_CUE_RE.test(s)) continue;
      let hit: { name: string; re: RegExp } | null = null;
      for (const v of RETRACTION_VERBS) {
        if (v.re.test(s)) {
          hit = v;
          break;
        }
      }
      if (!hit) continue;

      const quoted: string[] = [];
      QUOTED_RE.lastIndex = 0;
      let qm: RegExpExecArray | null;
      while ((qm = QUOTED_RE.exec(s)) !== null) quoted.push(qm[1].trim());

      CUID_RE.lastIndex = 0;
      const ids = Array.from(new Set((s.match(CUID_RE) || []).map((x) => x.trim())));

      const verbMatch = hit.re.exec(s);
      let after = "";
      if (verbMatch) after = s.slice(verbMatch.index + verbMatch[0].length);
      after = after
        .replace(/^[\s:：,，、\-—一(（]+/, "")
        .replace(/^(?:我的|我)?(?:刚才|之前|前面|上面|前面那|上面那|原|该|此|这条|那条|这|那)?(?:条|个|句|结论|判断|说法|话)?/, "")
        .replace(/[\s]+/g, " ")
        .trim();
      const hintParts = [...quoted, after.slice(0, 60)].filter(Boolean);
      const targetHint = hintParts.join(" | ").trim();
      const selfRetraction = SELF_REF_RE.test(s) || SELF_VERB_RE.test(s);
      const strongSelfRetraction = SELF_VERB_RE.test(s);

      // 过滤: 既没有回指/引文/id, 又抽不出任何线索 -> 不认为是撤回
      if (!selfRetraction && !quoted.length && !ids.length && targetHint.length < 4) continue;

      cues.push({
        msgIndex: i,
        seq: msg.seq ?? null,
        timestamp: msg.timestamp ?? null,
        role: String(msg.role || ""),
        verb: hit.name,
        sentence: s.replace(/\s+/g, " ").slice(0, 240),
        targetHint: targetHint.slice(0, 160),
        explicitIds: ids,
        selfRetraction,
        strongSelfRetraction,
      });
    }
  }
  return cues;
}

// ============================================================
// 5. 纯函数: 撤回对象匹配
// ============================================================
export interface MatchOptions {
  /** 词元命中率下限, 默认 0.34 */
  minScore?: number;
  /** 至少命中的词元数, 默认 3 */
  minTerms?: number;
  /** 是否要求至少命中标题里的一个词元, 默认 true */
  requireTitleHit?: boolean;
}

export function matchRetractionsToKnowledge(
  cues: RetractionCue[],
  candidates: RetractionCandidate[],
  opts: MatchOptions = {}
): RetractionMatch[] {
  const minScore = opts.minScore ?? 0.34;
  const minTerms = opts.minTerms ?? 3;
  const requireTitleHit = opts.requireTitleHit !== false;
  const cand = (candidates || []).filter((c) => c && c.id);
  const out: RetractionMatch[] = [];

  for (const cue of cues) {
    const explicit = cue.explicitIds
      .map((id) => cand.find((c) => c.id === id))
      .filter((c): c is RetractionCandidate => !!c);
    if (explicit.length) {
      for (const c of explicit) {
        out.push({
          cue,
          knowledgeId: c.id,
          title: c.title,
          score: 1,
          matchedTerms: ["<explicit-id>"],
          autoApplicable: true,
          reason: `语句显式点名 Knowledge id=${c.id}`,
        });
      }
      continue;
    }

    // 只用"撤回对象线索"做匹配(引文 + 动词后的短语), **不**把整句拿进来 ——
    //   实测: 长 agent 消息里"更正/撤回"句整句 tokenize 会和任何候选共享泛词(读数/文件/结论),
    //   造成大量假阳性(真实会话实测 3 条全假)。线索太短就不匹配, 宁缺毋滥。
    const targetText = cue.targetHint;
    const tToks = tokenize(targetText);
    if (tToks.size < 2) continue;

    let best: { c: RetractionCandidate; terms: string[]; score: number; titleHit: boolean } | null = null;
    for (const c of cand) {
      const cToks = tokenize(`${c.title || ""} ${String(c.content || "").slice(0, 1600)}`);
      const titleToks = tokenize(c.title || "");
      const terms: string[] = [];
      let titleHit = false;
      for (const t of tToks) {
        if (cToks.has(t)) {
          terms.push(t);
          if (titleToks.has(t)) titleHit = true;
        }
      }
      if (terms.length === 0) continue;
      const denom = Math.max(1, Math.min(tToks.size, 12));
      const score = terms.length / denom;
      if (requireTitleHit && !titleHit) continue;
      if (!best || score > best.score || (score === best.score && terms.length > best.terms.length)) {
        best = { c, terms, score, titleHit };
      }
    }
    if (!best) continue;
    if (best.terms.length < minTerms || best.score < minScore) continue;

    out.push({
      cue,
      knowledgeId: best.c.id,
      title: best.c.title,
      score: Number(best.score.toFixed(3)),
      matchedTerms: best.terms.slice(0, 12),
      // 注意(2026-09-15 收紧): 词元路径**只有第一人称撤回**才可自动应用。
      //   - 句子里的无关 cuid(proposalId/taskId) 不赋予自动权(否则材料 JSON 里任一 id 就能升级成自动撤回);
      //   - 弱回指(那条/该结论/本通道)也不再给自动权 —— 500 会话真实干跑证明它们全是 taskexec
      //     机器任务正文的假阳性("列出该结论不成立的 3 类反例路径"/"另一条标 SUPERSEDED"), 挂 timer 会误杀。
      autoApplicable: cue.strongSelfRetraction,
      reason:
        `同会话显式撤回(${cue.verb}), 词元命中 ${best.terms.length} 个${best.titleHit ? "(含标题)" : ""}` +
        `${cue.strongSelfRetraction ? " [第一人称自指]" : cue.selfRetraction ? " [弱回指: 需人工确认]" : " [非自指: 需人工确认]"}`,
    });
  }
  return out;
}

// ============================================================
// 6. 落库: 撤回
// ============================================================
let idSeq = 0;
function genId(prefix: string): string {
  idSeq = (idSeq + 1) % 0xffff;
  return (
    prefix +
    Date.now().toString(36) +
    idSeq.toString(36).padStart(3, "0") +
    Math.floor(Math.random() * 0xffffffff)
      .toString(36)
      .padStart(6, "0")
  );
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function ensureAuditTable(db: SqliteLikeDb): void {
  db.prepare(
    "CREATE TABLE IF NOT EXISTS AuditLog (" +
      "id TEXT NOT NULL PRIMARY KEY, entityType TEXT NOT NULL, entityId TEXT NOT NULL, action TEXT NOT NULL, " +
      "actor TEXT, actorType TEXT, before TEXT, after TEXT, metadata TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ).run();
}

/** 解析要撤回的目标行(显式 id + query/sourceId 匹配) */
export function resolveRetractTargets(db: SqliteLikeDb, params: RetractParams): RetractTarget[] {
  const found = new Map<string, RetractTarget>();
  const select = (id: string): RetractTarget | null => {
    const r = db
      .prepare("SELECT id, title, stale, staleReason, supersededBy, verification FROM Knowledge WHERE id = ?")
      .get(id) as
      | {
          id: string;
          title: string;
          stale: number | null;
          staleReason: string | null;
          supersededBy: string | null;
          verification: string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      staleBefore: Number(r.stale) === 1,
      staleReasonBefore: r.staleReason ?? null,
      supersededByBefore: r.supersededBy ?? null,
      verificationBefore: r.verification ?? null,
    };
  };

  for (const id of params.ids || []) {
    const t = select(id);
    if (t) found.set(t.id, t);
  }
  if (params.query || params.sourceId) {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (params.query) {
      clauses.push("(title LIKE ? OR content LIKE ?)");
      args.push(`%${params.query}%`, `%${params.query}%`);
    }
    if (params.sourceId) {
      clauses.push("sourceId = ?");
      args.push(params.sourceId);
    }
    const rows = db
      .prepare(`SELECT id FROM Knowledge WHERE ${clauses.join(" AND ")} LIMIT 500`)
      .all(...args) as Array<{ id: string }>;
    for (const r of rows) {
      const t = select(r.id);
      if (t) found.set(t.id, t);
    }
  }
  return Array.from(found.values());
}

/**
 * 撤回 Knowledge 行。幂等: 已 stale 的行不重复写(除非 supersededBy 需要补写)。
 * supersededBy 提供时必须真实存在, 否则抛错 —— 防止制造悬空指针(实测已有 1 条悬空: cmu1cbbl8... -> cmu1enk0n...)。
 */
export function retractKnowledge(db: SqliteLikeDb, params: RetractParams): RetractResult {
  const reason = String(params.reason || "").trim();
  const actor = String(params.actor || "").trim();
  if (!reason) throw new Error("retractKnowledge: reason 必填");
  if (!actor) throw new Error("retractKnowledge: actor 必填");

  const now = params.now ?? Date.now();
  const markVerification = params.markVerification !== false;
  const supersededBy = params.supersededBy ? String(params.supersededBy) : null;

  if (supersededBy) {
    const exists = db.prepare("SELECT id FROM Knowledge WHERE id = ?").get(supersededBy);
    if (!exists) {
      throw new Error(
        `retractKnowledge: supersededBy=${supersededBy} 在 Knowledge 中不存在 -> 拒绝写入(避免悬空指针)`
      );
    }
  }

  const targets = resolveRetractTargets(db, params);
  const result: RetractResult = { retracted: [], skipped: [], supersededBy, auditIds: [], eventIds: [] };

  ensureAuditTable(db);
  const upd = db.prepare(
    "UPDATE Knowledge SET stale = 1, staleReason = ?, supersededBy = COALESCE(?, supersededBy), " +
      "supersededAt = CASE WHEN ? IS NOT NULL THEN ? ELSE supersededAt END, " +
      "verification = CASE WHEN ? = 1 THEN 'REJECTED' ELSE verification END, updatedAt = ? WHERE id = ?"
  );
  const insAudit = db.prepare(
    "INSERT INTO AuditLog (id, entityType, entityId, action, actor, actorType, before, after, metadata, createdAt) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  const insEvent = db.prepare(
    "INSERT INTO FlywheelEvent (id, stage, sourceType, sourceId, sourceTitle, targetStage, targetType, targetId, createdAt) " +
      "VALUES (?,?,?,?,?,?,?,?,?)"
  );

  const applyOne = (t: RetractTarget): void => {
    const staleReason = `${fmtTs(now)} 撤回(${actor}): ${reason}`.slice(0, 1000);
    const needSupersede = !!supersededBy && t.supersededByBefore !== supersededBy;
    if (t.staleBefore && !needSupersede) {
      result.skipped.push({ id: t.id, title: t.title, action: "SKIPPED", why: "already_stale" });
      return;
    }
    if (params.dry) {
      result.retracted.push({
        id: t.id,
        title: t.title,
        action: "WOULD_RETRACT",
        why: t.staleBefore ? "补写 supersededBy" : "未失效 -> 将置 stale",
      });
      return;
    }
    const before = JSON.stringify({
      stale: t.staleBefore,
      staleReason: t.staleReasonBefore,
      supersededBy: t.supersededByBefore,
      verification: t.verificationBefore,
    });
    const auditId = genId("audit_");
    const eventId = genId("evt_");
    const run = (): void => {
      upd.run(
        staleReason,
        supersededBy,
        supersededBy,
        supersededBy ? now : null,
        markVerification ? 1 : 0,
        now,
        t.id
      );
      insAudit.run(
        auditId,
        "Knowledge",
        t.id,
        "RETRACT",
        actor,
        params.actorType || "AGENT",
        before,
        JSON.stringify({ stale: true, staleReason, supersededBy, verification: markVerification ? "REJECTED" : t.verificationBefore }),
        JSON.stringify({ verb: "retractKnowledge", reason, supersededBy }),
        now
      );
      insEvent.run(
        eventId,
        "RETRACTION",
        "KNOWLEDGE_RETRACTION",
        actor,
        `撤回 ${t.id}: ${reason}`.slice(0, 400),
        "KNOWLEDGE",
        "Knowledge",
        t.id,
        now
      );
    };
    if (typeof db.transaction === "function") {
      (db.transaction(run) as () => void)();
    } else {
      run();
    }
    result.retracted.push({
      id: t.id,
      title: t.title,
      action: "RETRACTED",
      why: t.staleBefore ? "补写 supersededBy" : "置 stale + REJECTED + AuditLog + FlywheelEvent",
    });
    result.auditIds.push(auditId);
    result.eventIds.push(eventId);
  };

  for (const t of targets) applyOne(t);
  return result;
}

// ============================================================
// 7. 会话内自动撤回编排
// ============================================================
export interface PlanSessionRetractionsInput {
  sessionUid: string;
  messages: SessionMessage[];
  candidates: RetractionCandidate[];
  actor: string;
  dry?: boolean;
  now?: number;
  matchOptions?: MatchOptions;
}

export interface PlanSessionRetractionsResult {
  cues: RetractionCue[];
  matches: RetractionMatch[];
  /** 仅自指/id 命中的匹配会被自动应用 */
  appliedMatches: RetractionMatch[];
  /** 命中但需人工确认(非自指), 不自动改库 */
  pendingHuman: RetractionMatch[];
  retract?: RetractResult;
}

export function planSessionRetractions(input: PlanSessionRetractionsInput): PlanSessionRetractionsResult {
  const cues = detectRetractionCues(input.messages || []);
  const matches = matchRetractionsToKnowledge(cues, input.candidates || [], input.matchOptions);
  const appliedMatches = matches.filter((m) => m.autoApplicable);
  const pendingHuman = matches.filter((m) => !m.autoApplicable);

  const out: PlanSessionRetractionsResult = { cues, matches, appliedMatches, pendingHuman };
  if (!appliedMatches.length) return out;
  return out;
}

/** 把会话内自动撤回应用到 DB(直接按 id 撤回, 每条带证据句) */
export function applySessionRetractions(
  db: SqliteLikeDb,
  input: PlanSessionRetractionsInput
): PlanSessionRetractionsResult {
  const plan = planSessionRetractions(input);
  if (!plan.appliedMatches.length) return plan;

  const byId = new Map<string, RetractionMatch>();
  for (const m of plan.appliedMatches) {
    if (!byId.has(m.knowledgeId)) byId.set(m.knowledgeId, m);
  }
  const retracted = planSessionRetractionsRetract(db, Array.from(byId.values()), input);
  return { ...plan, retract: retracted };
}

function planSessionRetractionsRetract(
  db: SqliteLikeDb,
  matches: RetractionMatch[],
  input: PlanSessionRetractionsInput
): RetractResult {
  const byReason = new Map<string, string[]>();
  for (const m of matches) {
    const reason =
      `同一会话(${input.sessionUid})后续显式推翻: "${m.cue.sentence}" (${m.reason})`;
    const list = byReason.get(reason) || [];
    list.push(m.knowledgeId);
    byReason.set(reason, list);
  }
  const merged: RetractResult = { retracted: [], skipped: [], supersededBy: null, auditIds: [], eventIds: [] };
  for (const [reason, ids] of byReason) {
    const r = retractKnowledge(db, {
      ids,
      reason,
      actor: input.actor,
      actorType: "SESSION_EXTRACT",
      dry: input.dry,
      now: input.now,
    });
    merged.retracted.push(...r.retracted);
    merged.skipped.push(...r.skipped);
    merged.auditIds.push(...r.auditIds);
    merged.eventIds.push(...r.eventIds);
  }
  return merged;
}

// ============================================================
// 8. 会话扫描编排(提炼器 inline / 扫描 cron / CLI 共用)
// ============================================================
export interface ScanTarget {
  sessionUid: string;
  sessionId: string;
}

export interface ScanTargetDetail {
  sessionUid: string;
  sessionId: string;
  messages: number;
  cues: number;
  matches: number;
  applied: string[];
  pendingHuman: string[];
  /** verbose 时的线索/命中明细(便于人工核对, 不进日志默认输出) */
  cueSamples?: Array<{ verb: string; self: boolean; sentence: string }>;
  matchSamples?: Array<{ knowledgeId: string; title: string; score: number; auto: boolean; cue: string }>;
}

export interface ScanResult {
  scanned: number;
  cues: number;
  matches: number;
  applied: number;
  pendingHuman: number;
  errors: Array<{ sessionUid: string; error: string }>;
  details: ScanTargetDetail[];
}

export function buildScanTargets(
  mindDb: SqliteLikeDb,
  sessionDb: SqliteLikeDb,
  opts: { days?: number; limit?: number; sessionUid?: string | null; now?: number } = {}
): ScanTarget[] {
  const now = opts.now ?? Date.now();
  const days = Math.max(1, opts.days ?? 14);
  const limit = Math.max(1, opts.limit ?? 50);
  let rows: Array<{ sessionUid: string }>;
  if (opts.sessionUid) {
    rows = [{ sessionUid: opts.sessionUid }];
  } else {
    rows = mindDb
      .prepare(
        "SELECT s.sessionUid AS sessionUid FROM SessionExtractionState s " +
          "WHERE s.status IN ('OK','EMPTY') AND COALESCE(s.extractedAt,0) >= ? " +
          "AND EXISTS (SELECT 1 FROM Knowledge k WHERE k.sourceId = s.sessionUid AND COALESCE(k.stale,0) = 0) " +
          "ORDER BY s.extractedAt DESC LIMIT ?"
      )
      .all(now - days * 86400 * 1000, limit) as Array<{ sessionUid: string }>;
  }
  const stmt = sessionDb.prepare("SELECT id FROM Session WHERE sessionUid = ? LIMIT 1");
  const stmtMsg = sessionDb.prepare("SELECT 1 x FROM Message WHERE sessionId = ? LIMIT 1");
  const targets: ScanTarget[] = [];
  for (const r of rows) {
    const row = stmt.get(r.sessionUid) as { id: string } | undefined;
    if (row?.id) {
      targets.push({ sessionUid: r.sessionUid, sessionId: row.id });
      continue;
    }
    // 兜底: 会话行已被清理/未同步, 但 Message 仍在(实测 agent-x 会话就是这样) ——
    //   sessionId 的编码规则是 sessionUid 的 ':' -> '_'。没有消息就跳过, 避免空转。
    const derived = r.sessionUid.replace(/:/g, "_");
    if (stmtMsg.get(derived)) targets.push({ sessionUid: r.sessionUid, sessionId: derived });
  }
  return targets;
}

export function scanSessionsForRetractions(
  mindDb: SqliteLikeDb,
  sessionDb: SqliteLikeDb,
  targets: ScanTarget[],
  opts: { actor: string; dry?: boolean; now?: number; matchOptions?: MatchOptions; verbose?: boolean } = { actor: "session-extract" }
): ScanResult {
  const out: ScanResult = {
    scanned: 0, cues: 0, matches: 0, applied: 0, pendingHuman: 0, errors: [], details: [],
  };
  for (const t of targets) {
    try {
      const messages = loadSessionMessagesAsc(sessionDb, t.sessionId);
      const candidates = loadKnowledgeBySource(mindDb, t.sessionUid);
      const plan = applySessionRetractions(mindDb, {
        sessionUid: t.sessionUid,
        messages,
        candidates,
        actor: opts.actor,
        dry: opts.dry,
        now: opts.now,
        matchOptions: opts.matchOptions,
      });
      const applied = (plan.retract?.retracted || []).map((r) => r.id);
      out.scanned++;
      out.cues += plan.cues.length;
      out.matches += plan.matches.length;
      out.applied += applied.length;
      out.pendingHuman += plan.pendingHuman.length;
      out.details.push({
        sessionUid: t.sessionUid,
        sessionId: t.sessionId,
        messages: messages.length,
        cues: plan.cues.length,
        matches: plan.matches.length,
        applied,
        pendingHuman: plan.pendingHuman.map((m) => m.knowledgeId),
        ...(opts.verbose
          ? {
              cueSamples: plan.cues.slice(0, 40).map((c) => ({ verb: c.verb, self: c.selfRetraction, sentence: c.sentence })),
              matchSamples: plan.matches.map((m) => ({ knowledgeId: m.knowledgeId, title: m.title, score: m.score, auto: m.autoApplicable, cue: m.cue.sentence })),
            }
          : {}),
      });
    } catch (e) {
      out.errors.push({ sessionUid: t.sessionUid, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// ============================================================
// 9. DB 读取辅助(better-sqlite3)
// ============================================================
export function loadKnowledgeBySource(db: SqliteLikeDb, sourceId: string): RetractionCandidate[] {
  const rows = db
    .prepare(
      "SELECT id, title, content, createdAt FROM Knowledge WHERE sourceId = ? AND stale IS NOT TRUE " +
        "ORDER BY createdAt ASC LIMIT 500"
    )
    .all(sourceId) as Array<{ id: string; title: string; content: string; createdAt: number | null }>;
  return rows.map((r) => ({ id: r.id, title: r.title || "", content: r.content || "", createdAt: r.createdAt ?? null }));
}

/** 读会话消息(升序); 传入的是 session 库的连接 */
export function loadSessionMessagesAsc(db: SqliteLikeDb, sessionId: string, limit = 600): SessionMessage[] {
  const rows = db
    .prepare(
      "SELECT role, content, timestamp FROM Message WHERE sessionId = ? AND role IN ('user','assistant','tool','toolResult') " +
        "ORDER BY timestamp DESC, id DESC LIMIT ?"
    )
    .all(sessionId, limit) as Array<{ role: string; content: string | null; timestamp: number | null }>;
  return rows
    .reverse()
    .map((r, i) => ({ role: r.role, content: r.content || "", timestamp: r.timestamp ?? null, seq: i }));
}
