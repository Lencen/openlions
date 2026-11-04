import { prisma } from "@/lib/prisma";
import { themeVariants } from "./resolver";

/**
 * verify-evidence-pack.ts — 2026-09-14
 *
 * 问题(实测): VERIFY_AGENT_OUTPUT 占平台任务量的 **79%**(近 2h: 136 条提交里 108 条), 而它们被派给了
 *   没有数据访问的文本通道 agent —— 生成侧只在 materials 里写 "howToVerify: GET /api/... 或直接查 mind dev.db",
 *   等于让它们"自己去查"(查不了), 于是只能回 UNCONVERIFIABLE/无法验证: 近 2h 有 25 条自认做不到。
 *   agent 的记忆里其实早有这条教训: "对 agent 发出的[挑战]类任务, 必须在 materials 中注入 evidencePack
 *   (确定性 SQL 证据快照), 否则 agent 只能回'证据不足/UNVERIFIABLE'"。
 *
 * 本模块在**开单侧**把可确定性得到的证据先跑出来, 随任务一起下发 —— 让文本通道也能做有依据的判断,
 * 而不是把"查证"这个它们做不到的活丢给它们。
 *
 * 设计原则:
 *   1) 只放**可复算**的事实(每条都带 SQL 或接口路径 + 当时的返回值), 不放结论;
 *   2) 查不到就说查不到(不编), 并写明"这一项需要执行体进一步核实";
 *   3) 包体控制在 3KB 内(进 description/materials, 会跟着任务进大脑上下文)。
 */
export interface VerifyEvidencePack {
  generatedAt: string;
  candidate: { id: string; title: string; submitter: string; qualityScore: number | null };
  /** 同主题已存在的知识(判"与既有已验证知识重复/冲突"用) */
  sameThemeKnowledge: Array<{ id: string; title: string; qualityScore: number | null; verification: string | null }>;
  /** 同内容(哈希)是否已存在 -> 重复候选 */
  duplicateByHash: number;
  /** 来源任务是否真的完成过、有无执行记录 */
  sourceTask: { id: string; status: string; completedBy: string | null; executionCount: number } | null;
  /**
   * 真实主题解析结果(2026-10-09 修)。
   *   candidate.theme 常是流水线**分类标签**(如 '挑战·finding'), 直接当聚合键会把全平台该标签的行
   *   算成"本主题产物"(实测 Knowledge=1007), 与真实主题(如 '闭环断点' → Knowledge=0)差 3 个数量级。
   */
  resolvedTheme: { theme: string; source: string; candidateTheme: string; variants: string[]; reliable: boolean; classLabel?: boolean };
  /** 该主题下产物存量(判断"这件事到底落过地没有"); 主题不可解析/不可信时为 null(不编) */
  productsByTheme: { memory: number; knowledge: number; practice: number; skill: number; reflection: number } | null;
  /** 复核人可直接引用的查询清单 */
  queries: Array<{ what: string; sql: string; result: unknown }>;
  notes: string[];
}

const PACK_MAX_CHARS = 3000;

/**
 * 已知的"流水线分类标签"——它们会出现在 candidate.theme 上, 但**不是主题**。
 * 这些都是开单脚本 generate-agent-tasks.cjs 写死的 theme(见其 L85/L106/L128), 用来标记任务种类;
 * 把候选行按它聚合 = 统计全平台该类任务, 不是统计本结论所属主题。
 * 显式白名单(而非模糊匹配), 口径可审计(与 resolver.THEME_ALIAS_GROUPS 同风格)。
 */
export const NON_THEME_CLASS_LABELS = new Set<string>([
  "挑战·finding",
  "诊断·链路异常",
  "复盘·机制修复",
]);

/** 从任意文本解析真实主题: 优先开单侧写的 `主题「X」`, 退化到 `[挑战] X f-00N`。 */
export function parseThemeFromText(text: string | null | undefined): string {
  return parseExplicitTheme(text) || parseLabelTheme(text);
}

/** 只认显式标记 `主题「X」` / `主题"X"`(开单侧写真实主题的规范形态)。 */
export function parseExplicitTheme(text: string | null | undefined): string {
  const s = String(text ?? "");
  const m = s.match(/主题[「『"]([^」』"]{1,60})[」』"]/);
  return m ? m[1].trim() : "";
}

/** 只认 `[挑战|复核|人审|提案闭环] X` 形态(挑战/复核任务标题里带主题的形态)。 */
export function parseLabelTheme(text: string | null | undefined): string {
  const s = String(text ?? "");
  const m = s.match(/\[(挑战|复核|人审|提案闭环)\]\s*([^\s:：,，]{1,30})/);
  if (!m) return "";
  return m[2].replace(/\s*f-\d+.*$/, "").trim();
}

/**
 * 决定证据包用哪个主题做聚合键。
 *
 * 缺陷(2026-10-09 实测): 原实现直接用 candidate.theme。AGENT_OUTPUT 候选是由
 *   "[挑战] <主题> <findingId>" 任务产出的, 其落库 theme 是分类标签 '挑战·finding';
 *   真实主题只写在来源任务正文: `【背景】主题「闭环断点」的 finding f-005 ...`。
 *   实测候选 cmtwsnhit05p21j760bb5ov81: candidate.theme='挑战·finding' 时证据包输出
 *   `Memory 0 / Knowledge 1007 / Practice 0 / Skill 0`, 而真实主题 '闭环断点' 下为
 *   `Knowledge 0 / Memory 21 / Reflection 3` —— 1007 会把"该主题知识为 0"读成"已有千条知识",
 *   直接误导复核人下 VERDICT。1007 是分类标签计数, 不是主题产物。
 *
 * 优先级(全部可复算; 顺序经真实候选回归验证):
 *   1) 显式 `主题「…」` —— 来源任务 description > 来源任务 title > 候选 title(开单侧写的规范形态, 最权威)
 *   2) 已声明主题 —— 来源任务 theme > 候选 theme, 且**不是**分类标签时直接信用
 *      (反例保护: 候选 cmu0m3bbo002v… 的真实主题就是 '平台演进'(Knowledge 311), 若先解析来源任务
 *       title 「[复核] MACS 注册白名单…」会误得 'MACS' —— 非分类标签的声明主题必须优先于标题解析)
 *   3) 声明的是分类标签 -> 才退化到 `[挑战] X f-00N` 形态解析(来源 title > 来源 description > 候选 title)
 *   4) 都解析不出 -> **不编**: reliable=false, 产物计数置 null
 */
export function resolveEvidenceTheme(input: {
  candidateTheme?: string | null;
  candidateTitle?: string | null;
  sourceTaskTheme?: string | null;
  sourceTaskTitle?: string | null;
  sourceTaskDescription?: string | null;
}): { theme: string; source: string; candidateTheme: string; variants: string[]; reliable: boolean; classLabel?: boolean } {
  const candidateTheme = String(input.candidateTheme || "").trim();
  const sourceTaskTheme = String(input.sourceTaskTheme || "").trim();
  const ok = (theme: string, source: string) => ({ theme, source, candidateTheme, variants: themeVariants(theme), reliable: true });

  // 1) 显式 `主题「…」`
  const explicit: Array<[string, string]> = [
    [parseExplicitTheme(input.sourceTaskDescription), "sourceTask.description"],
    [parseExplicitTheme(input.sourceTaskTitle), "sourceTask.title"],
    [parseExplicitTheme(input.candidateTitle), "candidate.title"],
  ];
  for (const [t, src] of explicit) if (t) return ok(t, "主题「」@" + src);

  // 2) 已声明主题(非分类标签可直接信用)
  const declared: Array<[string, string]> = [
    [sourceTaskTheme, "sourceTask.theme"],
    [candidateTheme, "candidate.theme"],
  ];
  for (const [t, src] of declared) if (t && !NON_THEME_CLASS_LABELS.has(t)) return ok(t, src);

  // 3) 声明主题是分类标签 -> 从 `[挑战] X f-00N` 扒真实主题
  const byLabel: Array<[string, string]> = [
    [parseLabelTheme(input.sourceTaskTitle), "sourceTask.title"],
    [parseLabelTheme(input.sourceTaskDescription), "sourceTask.description"],
    [parseLabelTheme(input.candidateTitle), "candidate.title"],
  ];
  for (const [t, src] of byLabel) if (t) return ok(t, "[标签]@" + src);

  // 4) 不编
  const anyDeclared = sourceTaskTheme || candidateTheme;
  return {
    theme: "", source: anyDeclared ? "声明的 theme 是分类标签, 未解析出真实主题" : "(无)",
    candidateTheme, variants: [], reliable: false, classLabel: !!anyDeclared,
  };
}

export async function buildVerifyEvidencePack(candidate: {
  id: string; title?: string | null; content?: string | null; contentHash?: string | null;
  theme?: string | null; agentSource?: string | null; qualityScore?: number | null; sourceId?: string | null;
}): Promise<VerifyEvidencePack> {
  const candidateTheme = String(candidate.theme || "");
  const notes: string[] = [];
  const queries: Array<{ what: string; sql: string; result: unknown }> = [];

  // 先取来源任务(真实主题写在它的正文里), 再据此解析聚合主题 —— 顺序不能反。
  let sourceTask: VerifyEvidencePack["sourceTask"] = null;
  let sourceTaskTitle = "";
  let sourceTaskDescription = "";
  let sourceTaskTheme = "";
  if (candidate.sourceId) {
    try {
      const sql = "SELECT id,status,completedBy,title,description,theme FROM Task WHERE id=?";
      const rows: any[] = await prisma.$queryRawUnsafe(sql, candidate.sourceId);
      if (rows && rows.length) {
        const r = rows[0];
        sourceTaskTitle = String(r.title || "");
        sourceTaskDescription = String(r.description || "");
        sourceTaskTheme = String(r.theme || "");
        const execN = await prisma.taskExecution.count({ where: { taskId: String(candidate.sourceId) } }).catch(() => 0);
        sourceTask = { id: String(r.id), status: String(r.status), completedBy: r.completedBy ?? null, executionCount: Number(execN) };
        queries.push({ what: "来源任务是否完成过", sql, result: { status: sourceTask.status, completedBy: sourceTask.completedBy, executions: sourceTask.executionCount, theme: sourceTaskTheme || null } });
      } else { notes.push("来源任务 " + candidate.sourceId + " 不存在(候选可能来自已清理的任务)"); }
    } catch { /* 忽略 */ }
  }

  // 2026-10-09 治本: 聚合键必须是**真实主题**。candidate.theme 常是 '挑战·finding' 之类分类标签,
  //   用它计数会把全平台该标签的行算成本主题产物(实测 Knowledge=1007 vs 真实 0), 严重误导复核。
  const resolvedTheme = resolveEvidenceTheme({
    candidateTheme, candidateTitle: candidate.title, sourceTaskTheme, sourceTaskTitle, sourceTaskDescription,
  });
  const theme = resolvedTheme.theme;
  const themeIn = resolvedTheme.variants.length ? resolvedTheme.variants : (theme ? [theme] : []);
  const ph = themeIn.map(() => "?").join(",");
  if (!resolvedTheme.reliable) {
    notes.push("真实主题无法从来源任务解析, 且 candidate.theme=「" + candidateTheme + "」是流水线分类标签(非主题); 为避免误导, 本次**不给出**主题产物计数, 请执行体自行确认该结论所属主题。");
  } else if (theme !== candidateTheme) {
    notes.push("候选行 theme=「" + candidateTheme + "」是流水线分类标签, 已改用来源任务解析出的真实主题「" + theme + "」(" + resolvedTheme.source + ")做产物计数与同主题检索。");
  }

  let sameThemeKnowledge: VerifyEvidencePack["sameThemeKnowledge"] = [];
  if (themeIn.length) {
    try {
      // 2026-09-15 撤回流程补漏: 复核证据包不得把已撤回(stale=1)的知识列为"同主题已有知识",
      //   否则复核者会拿被推翻的结论当依据(撤回写 stale=1, supersededBy 仍为 NULL)。
      // 2026-10-09: theme 改用真实主题 + 别名族(themeVariants), 与 reflect.loadThemeProducts 同口径。
      const sql = "SELECT id,title,qualityScore,verification FROM Knowledge WHERE theme IN (" + ph + ") AND supersededBy IS NULL AND COALESCE(stale,0)=0 ORDER BY qualityScore DESC LIMIT 5";
      const rows: any[] = await prisma.$queryRawUnsafe(sql, ...themeIn);
      sameThemeKnowledge = (rows || []).map((r) => ({ id: String(r.id), title: String(r.title || "").slice(0, 80), qualityScore: r.qualityScore ?? null, verification: r.verification ?? null }));
      queries.push({ what: "同主题已有知识(判重复/冲突)", sql, result: sameThemeKnowledge.length + " 条" });
    } catch (e: any) { notes.push("同主题知识查询失败: " + String(e?.message || e).slice(0, 60)); }
  }

  let duplicateByHash = 0;
  if (candidate.contentHash) {
    try {
      const sql = "SELECT COUNT(*) AS n FROM Knowledge WHERE contentHash=?";
      const rows: any[] = await prisma.$queryRawUnsafe(sql, candidate.contentHash);
      duplicateByHash = Number(rows?.[0]?.n ?? 0);
      queries.push({ what: "同内容哈希是否已存在", sql, result: duplicateByHash });
    } catch { /* 忽略 */ }
  } else {
    notes.push("候选没有 contentHash, 无法做同内容判重");
  }

  // 计数口径保持与历史一致(主题精确行数, 不做 live/stale 过滤), 只改**聚合键** —— 便于与
  //   缺陷报告基线(Knowledge=1007 / Memory=21 / Reflection=1)逐项对照; 新增 Reflection 一类,
  //   因为该主题的产物恰恰以 Reflection 形态存在, 漏计会重新造成"没落过地"的误判。
  let productsByTheme: VerifyEvidencePack["productsByTheme"] = null;
  if (themeIn.length) {
    try {
      const q = "SELECT (SELECT COUNT(*) FROM Memory WHERE theme IN (" + ph + ")) m,"
        + "(SELECT COUNT(*) FROM Knowledge WHERE theme IN (" + ph + ")) k,"
        + "(SELECT COUNT(*) FROM Practice WHERE theme IN (" + ph + ")) p,"
        + "(SELECT COUNT(*) FROM Skill WHERE theme IN (" + ph + ")) s,"
        + "(SELECT COUNT(*) FROM Reflection WHERE theme IN (" + ph + ")) r";
      const rows: any[] = await prisma.$queryRawUnsafe(q, ...themeIn, ...themeIn, ...themeIn, ...themeIn, ...themeIn);
      if (rows && rows.length) {
        productsByTheme = {
          memory: Number(rows[0].m ?? 0), knowledge: Number(rows[0].k ?? 0),
          practice: Number(rows[0].p ?? 0), skill: Number(rows[0].s ?? 0),
          reflection: Number(rows[0].r ?? 0),
        };
        queries.push({ what: "该主题五类产物存量(主题=" + theme + ", 别名族 " + JSON.stringify(themeIn) + ")", sql: q, result: productsByTheme });
      }
    } catch (e: any) { notes.push("主题产物存量查询失败: " + String(e?.message || e).slice(0, 60)); }
  }

  notes.push("本证据包由开单侧确定性生成(可复算); 未列出的项表示平台当前无法用查询判定, 需要执行体进一步核实。");

  const pack: VerifyEvidencePack = {
    generatedAt: new Date().toISOString(),
    candidate: { id: candidate.id, title: String(candidate.title || "").slice(0, 120), submitter: String(candidate.agentSource || "unknown"), qualityScore: candidate.qualityScore ?? null },
    sameThemeKnowledge, duplicateByHash, sourceTask, resolvedTheme, productsByTheme, queries, notes,
  };
  // 控制体积: 超限则只保留 queries/notes 与计数
  const s = JSON.stringify(pack);
  if (s.length > PACK_MAX_CHARS) {
    pack.sameThemeKnowledge = pack.sameThemeKnowledge.slice(0, 2);
    const s2 = JSON.stringify(pack);
    if (s2.length > PACK_MAX_CHARS) { pack.queries = pack.queries.slice(0, 3); }
  }
  return pack;
}

/** 渲染成人可读的一段(直接进任务 description, 大脑一定会看到)。 */
export function renderEvidencePack(p: VerifyEvidencePack): string {
  const lines: string[] = [];
  lines.push("【证据包(开单侧确定性生成, 可直接引用)】");
  lines.push("· 候选: " + p.candidate.title + " | 提交者 " + p.candidate.submitter + " | 候选质量分 " + (p.candidate.qualityScore ?? "-"));
  // 2026-10-09: 明确写出"统计用的是哪个主题" —— 之前不写, 复核人无从发现聚合键是分类标签 '挑战·finding'。
  if (p.resolvedTheme.reliable) {
    lines.push("· 统计主题: 「" + p.resolvedTheme.theme + "」(" + p.resolvedTheme.source
      + (p.resolvedTheme.theme !== p.resolvedTheme.candidateTheme ? "; 候选行 theme=「" + p.resolvedTheme.candidateTheme + "」为分类标签已弃用" : "")
      + (p.resolvedTheme.variants.length > 1 ? "; 别名族 " + JSON.stringify(p.resolvedTheme.variants) : "") + ")");
  } else {
    lines.push("· 统计主题: 未能解析(候选行 theme=「" + p.resolvedTheme.candidateTheme + "」是分类标签, 非主题)");
  }
  lines.push("· 同主题已存在知识 " + p.sameThemeKnowledge.length + " 条" + (p.sameThemeKnowledge.length ? ": " + p.sameThemeKnowledge.map((k) => k.title.slice(0, 24) + "(" + (k.verification || "未标注") + ")").join("; ") : ""));
  lines.push("· 同内容哈希命中: " + p.duplicateByHash + " 条(>0 说明内容已存在)");
  if (p.sourceTask) lines.push("· 来源任务: " + p.sourceTask.id.slice(0, 12) + " status=" + p.sourceTask.status + " 执行记录 " + p.sourceTask.executionCount + " 条");
  if (p.productsByTheme) {
    lines.push("· 该主题产物存量: Memory " + p.productsByTheme.memory + " / Knowledge " + p.productsByTheme.knowledge + " / Practice " + p.productsByTheme.practice + " / Skill " + p.productsByTheme.skill + " / Reflection " + p.productsByTheme.reflection);
  } else {
    lines.push("· 该主题产物存量: 未统计(真实主题不可解析; 用 candidate.theme 计数会得到分类标签的全平台计数, 属误导, 故不输出)");
  }
  lines.push("· 以上每项的 SQL 都随任务下发, 复核人可原样重放。");
  return lines.join("\n");
}
