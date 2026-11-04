/**
 * transient-resource-alert.ts — 上游额度/限流告警「5h 自愈的瞬态资源事件」分类闸门 (2026-09-24)
 *
 * 事故与人类决定(平台库只读复算, sqlite3 -readonly …/dev.db):
 *   待办 todo_token429_1790055363894 「[需您拍板][P1] MiniMax Token Plan 用量上限 (deepseek 429)」
 *     · source=token-plan, createdBy=agent-operator, ownerType=human ownerId=operator, detail 不以【开头(**旧格式**),
 *       meta=NULL(没有 kind/cueKind, 因此绕过了 human-card-dedup 与 todo-writeback-guard 的结构化判据);
 *     · detail 原文: "[平台级告警 2026-09-22] agent-d 执行体 HTTP 429: Token Plan 用量上限. … 选项: A) 升级 …"
 *     · 人类 operator 决定(note/evidence 原文): 「为什么还有旧格式，minimax的额度每5小时会自动恢复，不需要再报这个问题」
 *
 * 根因(机制, 非一次特判):
 *   ① 上游额度/限流(HTTP 402/429, "Token Plan 用量上限", rate limit/quota)是**瞬态资源事件**:
 *      MiniMax 配额按 5 小时窗口滚动恢复(人类明确口径), 到点自愈, 不需要人做任何事;
 *   ② 但告警生产方把它当成"要不要升级套餐/买积分"的**人类决策**, 直接以旧格式(writer 自拟标题 `[需您拍板][P1]…`
 *      + 自由文本 detail + 无 meta)POST 进 Todo 单一入口 —— 因为没有 meta.kind, 既命中不了冷却去重,
 *      也命中不了回写守卫, 于是「同一个到点自愈的问题」可以反复开卡打扰人类。
 *   ③ 这同时回答了人类「为什么还有旧格式」: 写入入口**只按结构化 meta 判类, 不按内容判类**;
 *      旧格式写入方不带 meta, 任何结构化闸门都对它失明。
 *
 * 修法(治本, 装在**单一入口**上, 与调用方格式无关):
 *   在 POST /api/v1/flywheel/todos 建单前按**内容**判类: 若这条记录是"上游额度/限流瞬态告警"且形态上
 *   要变成人类决策卡(ownerType=human, 或标题是 [需您拍板]/[决策]…), 则**不把它当人类决策**——
 *   不打断人类, 而是以 status=DROPPED + 结构化 meta 存档(信息不丢, 只不呈现), 并写事件便于复算。
 *   判据抽成纯函数(本模块), 可单测; 与调用方是否使用新格式、是否带 meta.kind 无关。
 *
 * 诚实边界(刻意收窄, 防误吞):
 *   - 只在**同时**满足「命中瞬态资源标记」+「形态是人类决策卡」时抑制; 普通人类待办、真实采购决策(不带额度/限流标记)照常创建。
 *   - 只是不"上报", 不是删除: 落一张 DROPPED 存档卡(meta.kind=TRANSIENT_RESOURCE_ALERT, 带 matched 标记与自愈窗口),
 *     可被审计/复算找回。
 *   - 标记词只用**确定性文本**(英文 token + 中文额度/限流短语), 不做语义猜测; 不把裸 "429" 当唯一依据。
 */

/**
 * 「主体就是额度/限流事件」的强标记 —— 用于判定这条记录的**主题**是不是额度/限流, 而不是"正文里顺带提到"。
 * 刻意**不含**裸 `Token Plan` / 裸 `额度` / 裸 `配额`: 实测存在真实人类卡标题带 "Token Plan"
 * 但主题是 finding 冲突(如 todo_s3set25bec0wrcgs), 用弱词会误吞真问题。
 */
const STRONG_SUBJECT_RE = /(用量上限|额度(?:耗尽|上限|用完|不足|已满)|配额(?:耗尽|上限|用完|不足)|rate\s*limit|too\s*many\s*requests|限流|quota\s*(?:exceeded|exhausted)|\b(?:402|429)\b)/i;
/** 弱词(仅用于「决策卡标题 + 强标记出现在正文开头」的组合判据, 不单独触发)。 */
const QUOTA_WORD_RE = /(Token\s*Plan|额度|配额|rate\s*limit|quota)/i;
/** 形态: 这条记录是(或将被当作)人类决策卡。 */
const DECISION_TITLE_RE = /^\s*[\[【]?\s*(需您拍板|需要人类决策|人类决策|决策|需人拍板|请拍板)/;
/** 正文开头窗口: 告警卡会把"上游 429/额度"写在首行摘要里, 埋在中段的只是证据引用。 */
const LEAD_CHARS = 160;
/**
 * 已知的「上游告警类」来源前缀。刻意收窄(只放已确认的告警来源), 不把 system:/platform: 全量纳入 ——
 * 那些来源里存在大量**只把 429 当正文证据提及**的普通待办, 全量纳入会误吞。
 * 判类主力是「标题形态 + ownerType=human」, 本列表只是补一条旧格式写入方可能用的来源通道。
 */
const ALERT_SOURCE_PREFIXES = ["token-plan", "alert:"];

/** 自愈窗口: MiniMax 配额每 5 小时滚动恢复(人类口径), 窗口仅作证据留档, 不用于判重(判重走 DROPPED 存档)。 */
export const TRANSIENT_SELF_HEAL_WINDOW_HOURS = 5;

export interface TransientResourceAlertInput {
  title?: string | null;
  detail?: string | null;
  source?: string | null;
  ownerType?: string | null;
  /** Todo.meta(JSON 字符串或已解析对象; 旧格式写入方通常为 null)。 */
  meta?: unknown;
}

export type TransientResourceAlertDecision =
  | { transient: false; action: "ALLOW"; matched: string[]; reason: string }
  | {
      transient: true;
      action: "ARCHIVE_AS_DROPPED";
      matched: string[];
      selfHealWindowHours: number;
      reason: string;
    };

function metaKind(meta: unknown): string {
  if (meta == null) return "";
  try {
    const m = typeof meta === "object" ? (meta as any) : JSON.parse(String(meta));
    return String(m?.kind || "").trim();
  } catch {
    return "";
  }
}

/**
 * 判定一条即将写入的 Todo 是否为「上游额度/限流瞬态告警的人类决策卡」。
 * 纯函数: 只看入参, 不读库、不产生副作用。
 */
export function classifyTransientResourceAlert(input: TransientResourceAlertInput): TransientResourceAlertDecision {
  const title = String(input.title || "");
  const detail = String(input.detail || "");
  const source = String(input.source || "").trim();

  // 记录形态: 只有"会打扰人类(决策卡标题 + 标题点明额度/限流)"或"来自专门告警通道"的记录才需要抑制。
  const kind = metaKind(input.meta);
  const alreadyArchived = kind === "TRANSIENT_RESOURCE_ALERT";
  const titleDecision = DECISION_TITLE_RE.test(title);
  const alertSource = ALERT_SOURCE_PREFIXES.some((p) => source.startsWith(p));
  const titleStrongHit = STRONG_SUBJECT_RE.exec(title);
  const titleSubject = !!titleStrongHit;
  const titleWeak = QUOTA_WORD_RE.test(title);
  const humanFacing =
    alreadyArchived
    || (titleDecision && titleWeak)
    || alertSource;
  if (!humanFacing) {
    return { transient: false, action: "ALLOW", matched: [], reason: "非人类决策卡/告警通道形态, 不判定" };
  }

  const blob = title + "\n" + detail;
  const leadStrongHit = STRONG_SUBJECT_RE.exec(detail.slice(0, LEAD_CHARS));
  const matched: string[] = [];
  if (titleStrongHit) matched.push("title:" + titleStrongHit[0]);
  if (!titleSubject && alertSource && leadStrongHit) matched.push("lead:" + leadStrongHit[0]);

  // 主题必须是额度/限流事件 —— 且必须在**标题**上成立(标题即主题)。
  // 依据(真实库全量复算, scripts/probes/probe-transient-resource-alert-recompute.ts):
  //   只按"正文开头命中"会误吞 9 张真实业务决策卡(todo_apply_oi31*/todo_ckhnfrifuxd6tr8j 等
  //   "【需您拍板】关于「…」的一件事" —— 它们只是**在正文引用 429/额度作为证据**, 主题并非额度事件)。
  //   因此收窄为: 标题命中强标记; 或来源是专门告警通道(alert:/token-plan)且正文开头命中。
  const subjectIsTransient = alreadyArchived || titleSubject || (alertSource && !!leadStrongHit);
  if (!subjectIsTransient) {
    return { transient: false, action: "ALLOW", matched, reason: "主题非额度/限流事件(仅正文提及), 按常规处理" };
  }
  // 带长期/非自愈语义(套餐到期/持续 N 天/封号)时不抑制 —— 保留人工兜底口子
  if (/(持续\s*\d+\s*(?:天|日|小时)|套餐(?:到期|失效)|永久|长期无法|账号被封|已停服)/i.test(blob)) {
    return { transient: false, action: "ALLOW", matched, reason: "带长期/非自愈语义, 不作为瞬态事件抑制" };
  }

  return {
    transient: true,
    action: "ARCHIVE_AS_DROPPED",
    matched,
    selfHealWindowHours: TRANSIENT_SELF_HEAL_WINDOW_HOURS,
    reason:
      "上游额度/限流告警属 5h 自愈的瞬态资源事件(命中 " + matched.join(", ") +
      "), 按人类 operator 决定不作为人类决策上报 -> 存档 DROPPED, 不打扰人类",
  };
}
