/**
 * decision-card-language.ts — 决策卡"业务语言"改写器 (2026-09-15)
 *
 * 背景(用户实测反馈, 待办 todo_953ed4cd92294a5d8a0d):
 *   human-decision-consumer 生成"只能人拍板"决策卡时, 直接把源 finding 标题拼在
 *   "【需您拍板】"后面, 于是用户看到的卡是:
 *     【需您拍板】[人审] 主题「HERMES落库」finding f-002: Memory [4x11za] 声称 35 个候选
 *     全部落库失败,但第二次 cron 中同样 session 20260728_195048_baef32 再次被报告失败...
 *   用户明确反馈"看不懂、处理不了"。根因是**文案层**把平台内部技术语言原样透传给人,
 *   而不是数据或逻辑问题 —— 所以修在生成入口(机制), 而不是逐张手工改字。
 *
 * 本模块把"源技术文本"确定性地转成**业务语言**:
 *   - 标题: 只讲"哪个业务环节出了什么事、要不要现在定", 由【业务域 + 事件类型】拼装,
 *           **不使用源标题原文** -> 结构上不可能把 finding/表名/字段名泄漏进标题;
 *   - 正文: ①背景 ②要您决定什么 ③选项与各自后果 ④推荐 ⑤不决定的后果;
 *   - 末尾单列【技术细节(可跳过)】段保存原文与内部 ID, 排查/追溯仍完整。
 *
 * 设计约束:
 *   - 纯函数, 无 IO、无 "@/..." 依赖 -> 可被 tsx 脚本直接 import 做回归
 *     (见 packages/apps/mind/scripts/test-decision-card-language.ts);
 *   - 正文业务段先经 deTechnicalize(), 再经 assertNoTechTokens() 守门: 一旦仍有技术词,
 *     就丢掉动态片段、退回纯模板句, 保证"用户只看标题+第一段就能决定"这一次原则不被破坏。
 */

// 2026-10-26: 对象/动作/期望的原样抽取与"可决策"审计(纯函数, 避免本文件继续膨胀规则)。
import { extractDecisionFacts, renderDecisionFacts } from "./decision-card-completeness";

// ===== 技术词识别 =====

/** 平台内部技术词(表名/字段名/文件名/finding 编号/环境变量/标识符...), 不应出现在业务段。 */
export const TECH_TOKEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /finding\s*[fF]-?\d+/g, label: "finding 编号" },
  { re: /\b[fF]-\d{2,4}\b/g, label: "finding 编号" },
  { re: /\b(Memory|Knowledge|Reflection|Practice|SyncLog|FindingClosure|FlywheelEvent|TaskExecution|AgentServicePermission|AutoRotationConfig|Todo|Task)\b\s*[\[【(（][^\]】)）]{1,24}[\]】)）]/g, label: "表名+行ID" },
  { re: /\b(Memory|Knowledge|Reflection|Practice|SyncLog|FindingClosure|FlywheelEvent|TaskExecution|AutoRotationConfig)\b/gi, label: "表名" },
  { re: /\b(sourcePath|filePath|sourceRefId|decisionTodoId|followUpTaskId|structuredFindings|ownerType|ownerId|createdAt|updatedAt|doneBy|doneAt|sessionIds|batchSize|maxSessions|humanOnly|note|meta|optionsText|recommended|priority)\b/gi, label: "字段名" },
  { re: /process\.env\.[A-Z0-9_]+/g, label: "环境变量" },
  { re: /\b[A-Za-z0-9_./-]+\.(tsx?|jsx?|cjs|mjs|json|prisma|sqlite|db|md)\b/gi, label: "文件名" },
  { re: /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, label: "驼峰标识符" },
  { re: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi, label: "下划线标识符" },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, label: "UUID" },
  { re: /\b[a-z0-9]{12,}\b/gi, label: "长匿名 ID" },
  // 2026-09-15 独立复核补漏(第二轮): 原 token 表漏报 pipeline/memory(小写表名)/hermes/console/
  //   session/server/auto-8d/v10 等真技术词。补上;并对正常业务词(ISO9001/Windows11 这类大写专有串)保持不误报
  //   —— 故"短内部ID"只用小写(去掉 i 标志)。
  { re: /\b(?=[a-z0-9]*[0-9])[a-z0-9]{6,}\b/g, label: "短内部ID" },
  { re: /\bv\d{1,4}\b/g, label: "版本号标识" },
  { re: /\b(trpc|prisma|sqlite|sql|cron|http|json|llm|ssr|cli|sdk|api|env|token|commit|bug|tsx|no-op|fallback|heuristic|claude|anthropic|pipeline|hermes|console|session|server|deploy|merge|branch|docker|npm|webhook|dashboard|yaml|auto-8d)\b/gi, label: "技术词" },
];

/** 业务段里绝对不能出现的技术词(用于守门断言)。 */
export function findTechnicalTokens(text: string | null | undefined): string[] {
  const s = String(text ?? "");
  const hits: string[] = [];
  for (const { re, label } of TECH_TOKEN_PATTERNS) {
    re.lastIndex = 0;
    const m = s.match(re);
    if (m && m.length) hits.push(label + ":" + m.slice(0, 3).join(","));
  }
  return hits;
}

export function hasTechnicalTokens(text: string | null | undefined): boolean {
  return findTechnicalTokens(text).length > 0;
}

/** 去掉技术痕迹, 只留业务语义(写给人看)。 */
export function deTechnicalize(input: string | null | undefined): string {
  let s = String(input ?? "");
  // 标记类: [人审] 【提案闭环】 (todo xxx) 主题「xxx」
  s = s.replace(/主题「[^」]*」/g, " ");
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/【[^】]*】/g, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/（[^）]*）/g, " ");
  // 表名+行 ID / finding 编号
  s = s.replace(/finding\s*[fF]-?\d+/gi, " ");
  s = s.replace(/\b[fF]-\d{2,4}\b/g, " ");
  s = s.replace(/\b(Memory|Knowledge|Reflection|Practice|SyncLog|FindingClosure|FlywheelEvent|TaskExecution|AutoRotationConfig)\b\s*[\[【(（][^\]】)）]{1,24}[\]】)）]/g, " ");
  s = s.replace(/\b(Memory|Knowledge|Reflection|Practice|SyncLog|FindingClosure|FlywheelEvent)\b/g, " ");
  // 配置/文件/标识符/环境变量
  s = s.replace(/process\.env\.[A-Z0-9_]+/g, "相关配置");
  s = s.replace(/\b[A-Za-z0-9_./-]+\.(tsx?|jsx?|cjs|mjs|json|prisma|sqlite|db|md)\b/gi, "相关程序文件");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/gi, " ");
  s = s.replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi, " ");
  s = s.replace(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, " ");
  // 业务语言里保留少量通用英文(如 AI), 其余拉丁词一律剔除, 保证"不出现技术词"
  s = s.replace(/[A-Za-z][A-Za-z0-9.\-]*/g, (m) => (/^(ai|AI)$/.test(m) ? "AI" : " "));
  s = s.replace(/\d{10,}/g, " "); // 时间戳/长数字
  s = s.replace(/[ \t\u3000]+/g, " ").replace(/\s*([,，。;；:：、])\s*/g, "$1").trim();
  s = s.replace(/^[，。;；:：、,]+/, "").trim();
  return s;
}

// ===== 业务域 / 事件类型 =====

/** 主题 -> 业务域说法(用户能听懂的"这是什么业务")。顺序敏感: 先具体后笼统。 */
const DOMAIN_RULES: Array<[RegExp, string]> = [
  [/HERMES|落库|入库/, "把对话自动整理成平台记忆的流程"],
  [/飞轮闭环|飞轮/, "平台自我改进的循环"],
  [/Pipeline|管道|流水线/i, "自动处理对话的流水线"],
  [/文档|代码/, "文档与代码文件管理"],
  [/前端|界面|UI/i, "网页界面"],
  [/提案闭环|提案/, "知识提案审批"],
  [/数据管理|数据同步|数据源/, "平台数据同步"],
  [/API|认证|鉴权/i, "系统之间的接口对接"],
  [/调度|定时|cron/i, "定时任务调度"],
  [/迁移|硬件/, "设备与数据搬迁"],
  [/记忆|Memory/i, "平台记忆库"],
  [/知识|Knowledge/i, "平台知识库"],
  [/验证|验收/, "平台自检与验收"],
  [/派单|产能|执行体|空转/, "任务派发与产能"],
];

export function businessDomain(source: string): string {
  const s = String(source ?? "");
  for (const [re, name] of DOMAIN_RULES) if (re.test(s)) return name;
  return "平台的一个环节";
}

/** 从源标题里提取主题名(仅用于匹配业务域, 不进入业务文案)。 */
export function extractTheme(title: string | null | undefined): string {
  const m = String(title ?? "").match(/主题「([^」]*)」/);
  if (m) return m[1].trim();
  const m2 = String(title ?? "").match(/\[(人审|提案闭环|挑战|复核)\]\s*([^:,，]{0,20})/);
  return m2 ? m2[2].trim() : "";
}

interface Cue { kind: string; title: (n: number) => string; background: string; }

/** 事件类型 -> 业务化的"要决定什么"+背景句。顺序敏感: 先具体后笼统。 */
const CUE_RULES: Array<[RegExp, Cue]> = [
  [/连续\s*(\d+)\s*轮(未判定|没人批|无人批|未决)/, {
    kind: "proposal-stuck",
    title: (n) => "有个知识提案连续 " + (n || 3) + " 轮没人批——要不要直接采纳",
    background: "平台的「知识提案」流程里有一条提案,系统连着好几轮提请您批,但一直没等到回复。它既没正式通过,也没被明确拒绝,后面的环节一直卡在等它。",
  }],
  [/迁移|搬迁/, {
    kind: "migration-stuck",
    title: () => "有件搬迁的事一直没进展——要不要先搁置",
    background: "之前提过要把一台机器上的 AI 助手连同它的会话记录、记忆和项目一起搬到新机器。这件事已经拖了好几轮,助手一直在做低风险的查看,真正搬运没有进展,也没跟您确认过要不要先放着。",
  }],
  [/冲突|矛盾|不一致|对不上|不符|打架/, {
    kind: "record-conflict",
    title: () => "记录跟实际情况对不上——要不要先纠正",
    background: "平台会自动写下一些结论性的记录(例如「某件事已经验证通过」)。最近的检查发现:这些记录跟后来的实际结果相反,而且反复出现,说明平台的「记笔记」环节可能一直在写错。",
  }],
  [/为空|未配置|没填|缺失|是空的|未设置/, {
    kind: "missing-config",
    title: () => "有项关键配置一直空着——要不要现在补上",
    background: "平台有一个需要配置才能启用的能力,这项配置目前是空的,导致相关功能只能用最基础的简化版本运行,效果比正常配置后差一截。",
  }],
  [/重复|冗余|套娃|同质|几乎完全相同/, {
    kind: "duplication",
    title: () => "平台里积了大量重复内容——要不要清理",
    background: "平台的记录里出现了大量内容几乎相同的重复条目,既占空间,也让后续检索和判断变难。",
  }],
  [/超时|卡住|积压|空转|死循环|停滞/, {
    kind: "stuck-flow",
    title: () => "一直卡着不动——要不要先停下处理",
    background: "平台上有一条流程反复卡住或空转,消耗资源却没有推进,继续放着会让问题越积越多。",
  }],
  [/失败|报错|异常|崩|挂掉|不行了|无法/, {
    kind: "failure",
    title: () => "反复出问题——要不要先停下处理",
    background: "平台的这个环节反复失败或报错,已经不是偶发,继续放着会影响后续流程的正确性。",
  }],
  [/未.*验证|验证.*缺|没.*验证|未做.*回归/, {
    kind: "missing-verify",
    title: () => "有改动没有认真验证——要不要补上验证",
    background: "平台有过「改完只说完成、没做真实验证」的情况,导致问题在下一轮又出现。这属于流程纪律问题,需要您定一下要不要强制补验证。",
  }],
];

function matchCue(source: string): { cue: Cue; n: number } | null {
  for (const [re, cue] of CUE_RULES) {
    const m = re.exec(String(source ?? ""));
    if (m) return { cue, n: m[1] ? Number(m[1]) : 0 };
  }
  return null;
}

// ===== 选项解析 =====

/**
 * 选项标记切分(2026-09-15 独立复核第二轮修正 + 第三轮补全):
 *   只在"真正的选项开头"切 —— 前面不是字母/数字/'+'(用负向后顾), 否则 "A+B)" 里的 "B)" 会被误切,
 *   把折中选项"A+B"劈坏(实测 "C) 生产写权限 A+B) 折中" 被切成 ["…A+","B) 折中"])。
 *   第三轮补全: 切分点本身要**认得出** "A+B)" 这个标签(可选 `+字母`), 否则 "A) x B) y A+B) z"
 *   只会切出 2 项、折中项被并进 B(实测: split -> ["A) 只读","B) 生产写权限 A+B) 折中"])。
 */
const OPTION_MARKER_SPLIT = /(?<![A-Za-z0-9+＋])(?=[A-Da-d](?:\s*[+＋]\s*[A-Da-d])?\s*[)）.、])/;
/** 选项标签: 单个 A~D, 或折中项 "A+B"。 */
const OPTION_LABEL_RE = /^\s*([A-Da-d](?:\s*[+＋]\s*[A-Da-d])?)\s*[)）.、]\s*([\s\S]*)$/;

/**
 * 把一段选项文本切成个体选项。支持两种真实形态:
 *   形态1: 分号分隔 "A) x; B) y; C) z"
 *   形态2: 空格分隔 "A) x B) y C) z" —— 消费者传入的 optionsText 常见这种(2026-09-15 独立复核实测:
 *          旧实现只按分号切, A/B/C 被合并成一行并污染①背景, 见回归 [8])。
 */
export function splitOptions(raw: string | null | undefined): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const bySemi = s.split(/[;；]/).map((x) => x.trim()).filter(Boolean);
  if (bySemi.length > 1) return bySemi;
  const byMarker = s.split(OPTION_MARKER_SPLIT).map((x) => x.trim()).filter(Boolean);
  return byMarker.length > 1 ? byMarker : bySemi;
}

/** 从决定文本里解析 A/B/C 选项(平台 8 维审视的既有格式: "选项: ... | 推荐: ...")。 */
export function parseOptions(decision: string | null | undefined): { options: string[]; recommended: string } {
  const d = String(decision ?? "");
  let options: string[] = [];
  // 形态1: "选项: A) ... B) ... C) ..."
  const optsSeg = d.match(/选项\s*[:：]\s*(.+?)(?:\|\s*推荐|$)/);
  if (optsSeg) options = splitOptions(optsSeg[1]);
  // 形态2: 直接出现 "A) ..." "B) ..." "C) ..." (按选项标记切段, 避免 [^A-D] 把正文里的字母也切掉)
  if (!options.length) {
    for (const part of d.split(OPTION_MARKER_SPLIT)) {
      const mm = part.match(OPTION_LABEL_RE);
      if (!mm) continue;
      const body = mm[2].split(/推荐\s*[:：]|不决定|技术细节|[|｜]/)[0].trim();
      if (body && body.length > 1) options.push(mm[1] + ") " + body.slice(0, 160));
    }
  }
  const rec = d.match(/推荐\s*[:：]\s*([^|]+)/);
  return { options: options.slice(0, 5), recommended: rec ? rec[1].trim().slice(0, 120) : "" };
}

// ===== 卡片构造 =====

export interface BusinessCardInput {
  sourceTitle: string;
  decision?: string | null;
  optionsText?: string;
  recommended?: string;
  reviewRef?: string;
  sourceTodoId?: string;
}

export interface BusinessCard {
  title: string;
  detail: string;
  /** 业务段(标题 + ①~⑤), 已断言无技术词 —— 供测试/探针直接校验 */
  businessText: string;
  domain: string;
  cueKind: string;
}

const SAFE_OPTIONS = [
  "A) 按平台建议执行——立刻推进, 短期见效",
  "B) 先补充信息再决定——多花一点时间把证据补齐, 期间事项继续挂着",
  "C) 判定无需处理, 直接关闭——不再追这件事, 接受现状",
];

/** 把业务段里可能残留的技术词做最后兜底; 若仍不干净, 返回 null 让调用方退回纯模板。 */
function sanitizeBusiness(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (hasTechnicalTokens(t)) return null;
  return t;
}

/**
 * 从决定文本里抽出"平台给出的业务理由", 去技术化后返回; 信息量不足(中文字符 < 8)则返回 ""。
 * 处理形态: "NEED_HUMAN_DECISION | recommended=B | reason=信息优先, 迁移前必须..." / 普通中文决定。
 */
export function extractReason(decision: string | null | undefined): string {
  let d = String(decision ?? "");
  const rm = d.match(/reason\s*[=:：]\s*([^|]+)/i);
  if (rm) d = rm[1];
  // 2026-09-15 独立复核补漏: 决定文本里没有显式 reason=, 又明显是"选项/推荐"段时, 不要把选项当成
  //   "平台梳理出的要点"塞进①背景(旧实现实测产出 "平台梳理出的要点:选项:) 立刻迁移… | 推荐:")。
  else if (/选项\s*[:：]/.test(d) || /[A-D]\s*[)）.、]/.test(d)) return "";
  d = d.replace(/^\s*(AUTO_DECISION|HUMAN_ONLY|NEED_HUMAN_DECISION|DEFER_TO_HUMAN|ESCALATE_TO_HUMAN)\b[\s:：|]*/i, "");
  d = d.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\s*[=:：]\s*/g, " "); // 去掉 key=value 残片
  const c = deTechnicalize(d);
  const cn = (c.match(/[\u4e00-\u9fff]/g) || []).length;
  return cn >= 8 ? c.slice(0, 160) : "";
}

/**
 * 由源技术文本构造一张业务语言决策卡(确定性, 无副作用)。
 */
export function buildBusinessDecisionCard(input: BusinessCardInput): BusinessCard {
  const sourceTitle = String(input.sourceTitle ?? "");
  const decision = String(input.decision ?? "");
  const theme = extractTheme(sourceTitle);
  const domain = businessDomain(sourceTitle || theme);
  const cueHit = matchCue(sourceTitle) || matchCue(decision);
  const cue = cueHit ? cueHit.cue : null;
  const cueKind = cue ? cue.kind : "generic";

  // ----- ① 背景 -----
  const bgParts: string[] = [];
  bgParts.push("平台在「" + domain + "」这条线上发现一个需要您定一下的问题。");
  if (cue) bgParts.push(cue.background);
  else bgParts.push("平台把这件事判定为「超出自动处理边界」, 需要您拍板; 自动流程已经停在这里, 不会自行往下走。");
  // 2026-10-26 根因修复(源待办 todo_5r9e4kcs0folv6en / 8 条占位卡):
  //   机器分级串(`平台自动分级: APPLY_IMPROVEMENT 优先级=P1。完整内容: …`) 里的条目 ID 会被
  //   extractReason -> deTechnicalize 全部删掉, 只剩 `优先级=。完整内容:为 增加…` ——
  //   这不是"要点", 是占位残片。这里对机器分级串**不再注入①背景**, 改为一句指向技术细节;
  //   原始建议(含对象 ID)由下方 techLines 原样保留, 审计见 decision-card-completeness.ts。
  const machineClassified = /平台自动分级\s*[:：]/.test(decision);
  const reason = machineClassified ? "" : extractReason(decision);
  if (reason) bgParts.push("平台梳理出的要点:" + reason);
  if (machineClassified) bgParts.push("具体对象与建议做法已原样列在文末的技术细节段(保留条目 ID), 请先核对再决定。");
  const background = sanitizeBusiness(bgParts.join("")) || ("平台在「" + domain + "」这条线上发现一个需要您定一下的问题, 已停止自动推进, 等您拍板。");

  // ----- 标题(不使用原文, 结构上无技术词) -----
  let titleBody = cue ? cue.title(cueHit ? cueHit.n : 0) : ("关于「" + domain + "」的一件事, 需要您定个方向");
  if (cue && (cueKind === "failure" || cueKind === "record-conflict") && !titleBody.includes(domain)) {
    titleBody = "「" + domain + "」" + titleBody; // 让标题直接说清"是哪条业务线"
  }
  const title = ("【需您拍板】" + titleBody).slice(0, 200);

  // ----- ② 要您决定什么 -----
  const parsed = parseOptions(decision);
  const optionsRaw = (input.optionsText && input.optionsText.trim()) || parsed.options.join("; ");
  // 2026-09-15 独立复核补漏: optionsText 常见"空格分隔的 A) B) C)", 旧实现只按分号切 -> 三项并成一项。
  //   统一走 splitOptions, 与 parseOptions 同一套切分。
  const cleanOptions = splitOptions(optionsRaw)
    .map((o) => {
      const mm = o.match(/^\s*([A-D])\s*[)）.、]\s*(.*)$/);
      const body = deTechnicalize(mm ? mm[2] : o).slice(0, 160);
      if (!body) return "";
      return mm ? mm[1] + ") " + body : body;
    })
    .filter((o) => o && o.length > 2)
    .slice(0, 5);
  const options = cleanOptions.length ? cleanOptions : SAFE_OPTIONS;
  const ask = cueKind === "proposal-stuck"
    ? "要不要直接采纳这条提案, 让它正式进入平台知识库?"
    : (optionsRaw ? "这件事接下来按哪个方向走?" : "要不要按平台建议直接处理?");

  // ----- ④ 推荐 -----
  const recRaw = (input.recommended && input.recommended.trim()) || parsed.recommended;
  const recClean = deTechnicalize(recRaw);
  const recommended = /^[A-D]$/.test(String(recRaw).trim())
    ? ("平台倾向选项 " + String(recRaw).trim() + ", 但请您确认。")
    : (recClean && recClean.length > 1
        ? recClean + " (平台按现有证据给出的倾向)"
        : "按选项 A 执行: 平台已按现有证据判断这是当前最省事、风险也最低的一步。");

  const businessText = [
    "①背景:" + background,
    "②要您决定什么:" + ask,
    "③选项与各自后果:",
    ...options.map((o) => "  " + o),
    "④推荐:" + recommended,
    "⑤不决定的后果:这张卡会一直挂在您的待办里, 相关流程不会自动往下走, 平台也会反复提醒您——直到您回复。",
  ].join("\n");

  // 守门: 业务段若仍有技术词, 整段退回纯模板(宁可少信息, 也不把技术词给人看)
  const safeBusiness = sanitizeBusiness(businessText) || [
    "①背景:平台在「" + domain + "」这条线上发现一个需要您定一下的问题, 已停止自动推进。",
    "②要您决定什么:" + ask,
    "③选项与各自后果:",
    ...SAFE_OPTIONS.map((o) => "  " + o),
    "④推荐:按选项 A 执行(平台按现有证据给出的倾向)。",
    "⑤不决定的后果:这张卡会一直挂着, 相关流程不会自动推进, 直到您回复。",
  ].join("\n");

  // ----- 技术细节(允许出现技术词, 单列在最后) -----
  // 2026-10-26: 原始建议必须**原样**保留(含条目 ID/表名), 它是人类核对"对什么做什么"的唯一锚点;
  //   旧实现只留 sourceTitle 前 400 字, 决定正文里的完整动作/期望直接被丢掉。
  const facts = extractDecisionFacts(decision);
  const factLines = renderDecisionFacts(facts);
  const techLines = [
    "【技术细节(可跳过)】",
    "- 原始来源: " + sourceTitle.replace(/\s+/g, " ").slice(0, 400),
    "- 原始建议(未改写): " + decision.replace(/\s+/g, " ").slice(0, 1800),
    ...factLines,
    input.sourceTodoId ? "- 来源待办: " + input.sourceTodoId : "",
    input.reviewRef ? "- 触发它的自动审视任务: " + input.reviewRef : "",
    input.optionsText ? "- 平台原始选项: " + String(input.optionsText).slice(0, 300) : "",
    input.recommended ? "- 平台原始推荐: " + String(input.recommended).slice(0, 200) : "",
  ].filter(Boolean);

  const detail = (safeBusiness + "\n\n" + techLines.join("\n")).slice(0, 6000);
  return { title, detail, businessText: safeBusiness, domain, cueKind };
}

/** 判断一段卡片正文是否已符合"业务语言"口径(标题 + ①~⑤ 业务段无技术词, 且有技术细节段)。 */
export function isBusinessCard(title: string, detail: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const t = String(title ?? "");
  const d = String(detail ?? "");
  if (!/^【需您拍板】/.test(t)) reasons.push("标题缺少【需您拍板】前缀");
  if (hasTechnicalTokens(t)) reasons.push("标题含技术词: " + findTechnicalTokens(t).join(" / "));
  const biz = d.split(/【技术细节|技术细节\s*[(（]可跳过[)）]/)[0];
  if (hasTechnicalTokens(biz)) reasons.push("正文业务段含技术词: " + findTechnicalTokens(biz).join(" / "));
  for (const sec of ["①背景", "②要您决定什么", "③选项与各自后果", "④推荐", "⑤不决定的后果"]) {
    if (!biz.includes(sec)) reasons.push("缺少章节 " + sec);
  }
  return { ok: reasons.length === 0, reasons };
}
