/**
 * context-seed.ts — 记忆前置注入 (2026-09-10, 由"agent 没有读平台记忆"暴露的缺口驱动)
 *
 * 问题: agent(含平台内 agent 与外部 LLM 会话)在执行任务前不会主动检索平台记忆, 导致"平台里存过的东西没人用";
 *       实测: 用户问"记忆/知识/技能定义"时, 我(agent)完全没查平台记忆, 而库里确实存在相关条目。
 * 方案: 提供统一检索入口 searchContext() -> 任务认领/提示词/agent 工具三处注入;
 *       检索口径: 同主题 + 关键词命中 + 质量分排序, 只取活性行(Memory 非 COLD / Knowledge 非 stale / Skill 非 legacy)。
 */
import { prisma } from "@/lib/prisma";
import { buildInjectedTitle } from "./injected-ids";
// 2026-09-23 uos20 #1 记忆分层+检索: 记忆按短期/长期两层 top-K 相关性召回, 注入容量 2K->50K+ token。
import { recallTopK, terms, queryTokens, retrievalTokens, maxCharsForTokens, memorySeedMaxTokens } from "./memory-layers";

export interface ContextHit { kind: "memory" | "knowledge" | "skill" | "practice"; id: string; title: string; snippet: string; score: number | null; source: string | null; theme: string | null; layer?: string | null;
  /** 2026-09-29: 该条目历史被消费次数 (memory.accessCount / knowledge.usageCount /
   *  skill.totalUsageCount / practice.reinforceCount)。用于长尾多样性加权。 */
  useCount?: number | null }

export async function searchContext(opts: { query?: string; theme?: string; kinds?: Array<"memory" | "knowledge" | "skill" | "practice">; limit?: number; countUsage?: boolean; layered?: boolean; tags?: string; domain?: string; source?: string;
  /** 2026-10-25 资产归属: Memory 的归属过滤谓词（由调用方按请求身份用 scopeSqlFragment 算好）。
   *  为什么在"选出 picked 之后"过滤而不是塞进每条查询: 分层召回(recallTopK)/非分层/兜底裸 SQL
   *  是三条不同的查询路径，逐条改容易漏；末尾用一次 id 集合校验能**统一兜住三条路径**。
   *  代价是多一次只读查询（只在有 memory 命中时）。 */
  scopeSql?: string;
  /** 2026-10-25: Knowledge/Skill 的归属谓词（列存在时才由调用方传入；不存在时传 undefined = 不过滤）。 */
  scopeSqlByKind?: { knowledge?: string; skill?: string };
  /** 2026-10-26 C2: 记下注入事件是"谁"触发的（此前 agentId 恒为 null，注入无法归因到 agent）。 */
  agentId?: string | null } = {}): Promise<ContextHit[]> {
  // 2026-09-23 容量: 旧 clamp 上限 20(≈2K token) -> 200(配合 MEMORY_SEED_MAX_TOKENS=50K+ 注入预算)。
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 200));
  const layered = opts.layered !== false;
  const q = String(opts.query || "").trim();
  // 2026-10-09 round 72-J: 换中文友好分词(term 整句 LIKE 对中文几乎零命中 -> 全走兜底)
  const ts = retrievalTokens(q);
  // 2026-09-29 (agent-d 休假期间) 修缺口: practice 此前**不在检索范围**(kinds 只有
  //   memory/knowledge/skill), 导致 Practice 表 7d 100% usageCount=0 —— 即"做法/经验"这类
  //   产物**从未进入过消费闭环**(portal/knowledge 计 reinforceCount 只覆盖人工看 UI 的路径)。
  //   Practice 是平台四类核心产物之一(见 docs/platform-logic/ 各 living 文档), 缺它等于
  //   "产了不收"。现纳入默认检索 + countUsage。
  const kinds = opts.kinds && opts.kinds.length ? opts.kinds : (["memory", "knowledge", "skill", "practice"] as const);
  const out: ContextHit[] = [];
  /** round 72-BB: 本次补进来的零消费长尾候选数(按 kind), 供观测/验证用 */
  const tailAdded: Record<string, number> = {};

  if ((kinds as readonly string[]).includes("memory")) {
    if (layered) {
      // 2026-09-23 uos20 #1: 记忆走分层 top-K 相关性召回(短期层/长期层各取 K 条), 替换旧的
      //   "qualityScore 直排 + 活性过滤"。K 按 limit 分配: 短期层与长期层各半(都至少 1 条)。
      const memK = Math.max(2, limit);
      const shortK = Math.max(1, Math.ceil(memK / 2));
      const longK = Math.max(1, memK - shortK);
      const rec = await recallTopK({ query: q, theme: opts.theme, shortK, longK }).catch(() => null);
      if (rec) {
        for (const h of [...rec.shortTerm, ...rec.longTerm]) out.push({ kind: "memory", id: h.id, title: h.title || "", snippet: h.snippet, score: h.score, source: h.sourceType ?? null, theme: h.theme ?? null, layer: h.layer, useCount: (h as any).accessCount ?? (h as any).useCount ?? null });
      }
    } else {
      const where: any = { supersededBy: null, NOT: { tier: "COLD" } };
      if (opts.theme) where.theme = opts.theme;
      // 2026-09-22 知识库结构化整理(步骤3): tags/domain 检索(向后兼容, 不传则现行为)
      if (opts.tags) where.tags = { contains: opts.tags };
      if (opts.domain) where.domain = opts.domain;
      if (ts.length) where.OR = ts.flatMap((t) => [{ title: { contains: t } }, { content: { contains: t } }]);
      const rows = await prisma.memory.findMany({ where, select: { id: true, title: true, content: true, theme: true, qualityScore: true, sourceType: true, accessCount: true }, orderBy: [{ qualityScore: "desc" }, { updatedAt: "desc" }], take: Math.max(limit * 6, 30) }).catch(() => [] as any[]);
      for (const r of rows as any[]) out.push({ kind: "memory", id: r.id, title: r.title || "", snippet: String(r.content || "").slice(0, 220), score: r.qualityScore ?? null, source: r.sourceType ?? null, theme: r.theme ?? null, useCount: r.accessCount ?? 0 });
    }
  }
  if ((kinds as readonly string[]).includes("knowledge")) {
    // 2026-09-10 质量治理: 未复核的 agent 产出候选(verification=PENDING_REVIEW 且人类未确认)不注入上下文,
    //   防止"未经证实的结论"被别的 agent 当事实使用并放大。
    const where: any = {
      supersededBy: null,
      stale: false,
      // 2026-10-09 round 72: 降权机制读取端 —— tier=COLD 不进入默认注入候选(仍可被精确检索/引用/人工 review, 与「只降权不删」一致)
      NOT: { tier: "COLD", sourceType: "AGENT_OUTPUT", verification: { not: "VERIFIED" }, humanConfirmed: false },
    };
    if (opts.theme) where.theme = opts.theme;
    // 2026-09-22 知识库结构化整理(步骤3): tags/domain 检索(向后兼容, 不传则现行为)
    if (opts.tags) where.tags = { contains: opts.tags };
    if (opts.domain) where.domain = opts.domain;
    if (ts.length) where.OR = ts.flatMap((t) => [{ title: { contains: t } }, { content: { contains: t } }]);
    const rows = await prisma.knowledge.findMany({ where, select: { id: true, title: true, content: true, theme: true, qualityScore: true, sourceType: true, usageCount: true }, orderBy: [{ qualityScore: "desc" }, { updatedAt: "desc" }], take: Math.max(limit * 6, 30) }).catch(() => [] as any[]);
    for (const r of rows as any[]) out.push({ kind: "knowledge", id: r.id, title: r.title || "", snippet: String(r.content || "").slice(0, 220), score: r.qualityScore ?? null, source: r.sourceType ?? null, theme: r.theme ?? null, useCount: r.usageCount ?? 0 });
  }
  if ((kinds as readonly string[]).includes("skill")) {
    // 2026-09-15 撤回流程落地(待办 todo_c4869259208d4a748fb9): 原查询只挡 supersededBy/legacy,
    //   被撤回(Skill PATCH stale=true / 撤回流程)的技能仍会被注入 agent 提示词 -> 撤回不生效。
    // 2026-09-23 uos20 #2 Skills 按需加载(方案 A): 加载层**只注入 {name,description} 轻量列表**,
    //   select 不再取 content(steps 全文), snippet 只来自 description; 需要全文时由
    //   skillViewByName()(skill_view 按需取回)另行取回 —— 不再 100+ 全文注入浪费 token。
    const where: any = { supersededBy: null, legacy: false, stale: false, NOT: { tier: "COLD" } };
    if (opts.theme) where.theme = opts.theme;
    if (ts.length) where.OR = ts.flatMap((t) => [{ name: { contains: t } }, { description: { contains: t } }]);
    const rows = await prisma.skill.findMany({ where, select: { id: true, name: true, description: true, theme: true, qualityScore: true, totalUsageCount: true }, orderBy: [{ qualityScore: "desc" }, { updatedAt: "desc" }], take: Math.max(limit * 6, 30) }).catch(() => [] as any[]);
    for (const r of rows as any[]) out.push({ kind: "skill", id: r.id, title: r.name || "", snippet: String(r.description || r.name || "").slice(0, 220), score: r.qualityScore ?? null, source: "SKILL", theme: r.theme ?? null, useCount: r.totalUsageCount ?? 0 });
  }
  if ((kinds as readonly string[]).includes("practice")) {
    // 2026-09-29 (agent-d 休假期间) 新增: practice 纳入上下文检索。
    //   检索字段用 title + description(practice 无 content 列, 正文在 description)。
    //   过滤与 knowledge 同口径: supersededBy=null + stale=false。
    const where: any = { supersededBy: null, stale: false };
    if (opts.theme) where.theme = opts.theme;
    if (ts.length) where.OR = ts.flatMap((t) => [{ title: { contains: t } }, { description: { contains: t } }]);
    const rows = await prisma.practice.findMany({
      where,
      select: { id: true, title: true, description: true, theme: true, qualityScore: true, outcome: true, reinforceCount: true },
      orderBy: [{ qualityScore: "desc" }, { updatedAt: "desc" }],
      take: Math.max(limit * 6, 30),
    }).catch(() => [] as any[]);
    for (const r of rows as any[]) out.push({ kind: "practice", id: r.id, title: r.title || "", snippet: String(r.description || r.title || "").slice(0, 220), score: r.qualityScore ?? null, source: r.outcome ?? null, theme: r.theme ?? null, useCount: r.reinforceCount ?? 0 });
  }

  // 排序(2026-09-10 修正): ①标题含全部检索词的优先(定义类查询) ②PLATFORM_SPEC 权威条目加权
  //   ③质量分 ④类型配额(单一类型最多占 2/3, 避免"技能"刷屏把定义类知识挤掉)
  // 2026-09-10 兜底(实测: 近7天 204 次任务认领只有 5 次注入 -> 检索没命中就静默跳过, 等于没注入):
  //   关键词命中为空时, 退化为"最近的高质量产物", 保证每次 agent 工作都有平台记忆可用。
  if (out.length === 0) {
    const recentMem = await prisma.$queryRawUnsafe<any[]>("SELECT id, title, content, qualityScore, sourceType, theme FROM Memory WHERE supersededBy IS NULL AND COALESCE(tier,'') <> 'COLD' AND COALESCE(qualityScore,0) >= 0.5 ORDER BY createdAt DESC LIMIT 3");
    const recentKn = await prisma.$queryRawUnsafe<any[]>("SELECT id, title, content, qualityScore, sourceType, theme FROM Knowledge WHERE supersededBy IS NULL AND stale = 0 AND COALESCE(tier,'') <> 'COLD' AND COALESCE(qualityScore,0) >= 0.5 ORDER BY createdAt DESC LIMIT 3");
    for (const r of recentMem || []) out.push({ kind: "memory", id: r.id, title: "[兜底] " + (r.title || ""), snippet: String(r.content || "").slice(0, 220), score: r.qualityScore ?? null, source: r.sourceType ?? null, theme: r.theme ?? null, useCount: null });
    for (const r of recentKn || []) out.push({ kind: "knowledge", id: r.id, title: "[兜底] " + (r.title || ""), snippet: String(r.content || "").slice(0, 220), score: r.qualityScore ?? null, source: r.sourceType ?? null, theme: r.theme ?? null, useCount: null });
  }
  // ===== 2026-10-12 round 72-BB: 给"长尾多样性"打分**补候选**(修一个结构性缺陷) =====
  // 实测根因(本轮量化): 上面每个 kind 的 findMany 用 `orderBy: qualityScore desc` + `take: max(limit*6,30)=48`
  //   **在打分之前**就把候选集截断了。于是一个"质量分排在第 49 名开外、但从未被消费"的对象
  //   **永远进不了候选集** —— 无论下面 scored() 里给它多大的长尾加权都没用。
  //   这正是 round 65 那个 "+0.25 长尾多样性加权" **没能提高召回面**的原因:
  //   它只能在已被质量分截断的那 48 条里重排序, 而那 48 条每次都几乎一样。
  // 量化(2026-10-12): 无 query 时可达天花板 Memory 5.81% / Knowledge 1.62% / Skill 14.12% / Practice 7.82%
  //   (合计约 6.2%), 而**实测覆盖只有 3.01%、重复倍数 11**;
  //   同时"高质量且从未被消费"的死库存有 Memory 4349 / Skill 5646 / Practice 3343 条。
  // 修法(**不加新机制, 而是喂饱已有机制**): 每个 kind 额外补一批"消费计数=0"的高质量候选进 out,
  //   让下面已有的相关性 + 长尾打分真正能看见它们; 选谁仍由那套打分决定, 这里只负责**让它们进入视野**。
  // 自我轮换: countUsage 会给被注入的行 +1 计数(见本文件末尾的 UPDATE), 所以本轮补进去的零消费对象
  //   下一轮就不再是"零消费"了 -> 覆盖面随注入次数单调增长, 不会钉死在同一批。
  // 回滚开关: CONTEXT_TAIL_EXTRA=0 完全关闭(退回改动前行为); 默认 20。
  const TAIL_EXTRA = Math.max(0, Number(process.env.CONTEXT_TAIL_EXTRA ?? "20") || 0);
  if (TAIL_EXTRA) {
    const have = new Set(out.map((h) => h.id));
    // 收集到独立数组, 循环结束后**前置**到 out —— 因为 scored 用 sort(稳定),
    //   同分候选按 out 顺序胜出; 追加在末尾 = 同分必输, 那就等于没补(实测: 追加时 8 个只换了 1 个)。
    const tailHits: ContextHit[] = [];
    const tailSpecs: Array<[string, string, string, string]> = [
      ["memory", "Memory", "content", "accessCount"],
      ["knowledge", "Knowledge", "content", "usageCount"],
      ["skill", "Skill", "description", "totalUsageCount"],
      ["practice", "Practice", "description", "reinforceCount"],
    ];
    // 2026-10-12 round 72-BC: **并行发这 4 条查询**(原来是串行 await)。
    //   实测串行代价 370ms(Memory 119 / Knowledge 166 / Skill 24 / Practice 61), 端点 740->1183ms。
    //   它们彼此无依赖, 并行后墙钟时间 ≈ 最慢的那条(≈166ms) 而不是求和。
    //   语义不变: 结果仍**按 tailSpecs 顺序**处理并 unshift, 最终 out 顺序与串行完全一致。
    const tailQueries: Array<{ kind: string; p: Promise<any[]> }> = [];
    for (const [kind, table, bodyCol, cntCol] of tailSpecs) {
      if (!(kinds as readonly string[]).includes(kind)) continue;
      try {
        // 过滤口径与上面的 findMany 保持一致(supersededBy/stale/COLD), 只额外要求"消费计数=0"。
        const guard =
          table === "Memory" ? "supersededBy IS NULL AND COALESCE(tier,'') <> 'COLD'"
            : table === "Knowledge" ? "supersededBy IS NULL AND stale = 0 AND COALESCE(tier,'') <> 'COLD'"
              : table === "Skill" ? "supersededBy IS NULL AND legacy = 0 AND stale = 0 AND COALESCE(tier,'') <> 'COLD'"
                : "supersededBy IS NULL AND stale = 0";
        const args: any[] = [];
        let whereSql = guard + " AND COALESCE(" + cntCol + ",0) = 0";
        if (opts.theme) { whereSql += " AND theme = ?"; args.push(String(opts.theme)); }
        // 2026-10-12 再修(实测第 4 次迭代才通): 补候选**必须与主查询同口径地过 query 过滤**。
        //   否则它们虽"高质量且零消费", 却与本次查询无关 —— 会被下面的 MIN_MATCH 精度过滤直接滤掉
        //   (实测: 不加这一条时, 补进来的候选一条都进不了最终结果, 交集 8/8)。
        //   这里用与上面 findMany 完全相同的 OR-of-LIKE(任一 token 命中), 保证"有资格参加后面的打分"。
        const titleCol = kind === "skill" ? "name" : "title";
        if (ts.length) {
          whereSql += " AND (" + ts.map(() => "(" + titleCol + " LIKE ? OR " + bodyCol + " LIKE ?)").join(" OR ") + ")";
          for (const t of ts) args.push("%" + t + "%", "%" + t + "%");
        }
        tailQueries.push({ kind, p: prisma.$queryRawUnsafe<any[]>(
          "SELECT id, " + titleCol + " AS title, " + bodyCol + " AS body, theme, qualityScore, " + (kind === "skill" ? "'SKILL' AS st" : "sourceType AS st") + ", " + cntCol + " AS cnt" +
          // 排序口径 = **质量分优先, 同级按 updatedAt 最旧** —— 两个约束都不能丢(实测踩过):
          //   · 只按 updatedAt ASC(最旧优先) -> 补进来的是**低质量老行**(实测首行 q=0.2),
          //     加权后仍低于现有胜出者 -> 一条都进不去, 改动等于没做(实测交集 8/8)。
          //   · 只按 qualityScore DESC -> 每次补的永远是同一批(sort 稳定 + 同分同序) -> 覆盖面不增长。
          //   · 两者结合: 先取高质量(够格竞争), 同质量里取最旧的(自我轮换)。
          //   轮换机制: 注入会给被选中的行 +1 消费计数(见文件末尾 UPDATE), 于是它下一轮不再满足
          //   "计数=0", 自动退出补候选集, 下一次补进来的就是**同质量档里的下一批最旧对象**。
          " FROM " + table + " WHERE " + whereSql + " ORDER BY COALESCE(qualityScore,0) DESC, updatedAt ASC LIMIT " + Math.min(TAIL_EXTRA, 100),
          ...args
        ).catch(() => [] as any[]) });
      } catch { /* 拼 SQL 失败不影响主路径 */ }
    }
    // 并行等全部返回, 再按 tailSpecs 顺序处理(与串行时 out 的最终顺序一致)
    const tailResults = await Promise.all(tailQueries.map((q) => q.p));
    for (let i = 0; i < tailQueries.length; i++) {
      const kind = tailQueries[i].kind;
      const rows = tailResults[i] || [];
      const hits: ContextHit[] = [];
      for (const r of rows as any[]) {
        const id = String(r.id || "");
        if (!id || have.has(id)) continue;
        have.add(id);
        hits.push({
          kind: kind as any, id, title: r.title || "",
          snippet: String(r.body || r.title || "").slice(0, 220),
          score: r.qualityScore ?? null, source: r.st ?? null, theme: r.theme ?? null,
          useCount: Number(r.cnt ?? 0),
        });
      }
      if (hits.length) { tailAdded[kind] = hits.length; out.unshift(...hits); }
    }
  }

  // ===== 2026-10-09 round 72-K: 覆盖率下限(先过滤, 再打分) =====
  // 实测依据(40 条真实任务标题, 两个 arm 取回的条目都用同一套 bigram 词评估覆盖度):
  //   A legacy 整句分词 : 有命中 25 次 / 62 条 / 平均覆盖 0.346 / >=25% 覆盖 62.9%
  //   B bigram 滑窗     : 有命中 38 次 / 103 条 / 平均覆盖 0.265 / >=25% 覆盖 47.6%
  //   C bigram + 至少命中 2 个 bigram: 有命中 **38** 次 / 84 条 / 平均覆盖 **0.308** / >=25% 覆盖 **58.3%**
  // 即: 换成 bigram 救回了召回(25->38), 但**单条相关度确实下降了**(0.346->0.265);
  //   加一道"至少命中 2 个 bigram"的下限后, 召回不变而单条相关度回到 0.308 —— 这才是要落地的策略。
  // 为什么按 kind 分别过滤: 某一类若全被过滤掉, 会退化成"整类消失"(历史上 practice 就这样被挤出过),
  //   所以**只在"该类还有强候选"时才收紧**, 一条强候选都没有就保留该类原候选(绝不做空召回)。
  // 可用 CONTEXT_MIN_MATCH 关闭/调整(评测与回滚开关; 0 = 不过滤)
  const MIN_MATCH = ts.length >= 4 ? Math.max(0, Number(process.env.CONTEXT_MIN_MATCH ?? "2") || 0) : 0;
  const precisionFiltered = (() => {
    if (!MIN_MATCH) return out;
    const withCov = out.map((h) => {
      const hay = (h.title || "") + "\n" + (h.snippet || "");
      let matched = 0;
      for (const t of ts) if (hay.includes(t)) matched++;
      return { h, matched };
    });
    const keep = new Set<ContextHit>();
    const kinds = Array.from(new Set(withCov.map((x) => x.h.kind)));
    for (const k of kinds) {
      const group = withCov.filter((x) => x.h.kind === k);
      const strong = group.filter((x) => x.matched >= MIN_MATCH);
      for (const x of (strong.length ? strong : group)) keep.add(x.h);
    }
    return out.filter((h) => keep.has(h));
  })();

  const scored = precisionFiltered.map((h) => {
    let boost = h.score ?? 0;
    // 2026-10-09 round 72-J: 原判据是"标题包含**全部**检索词"-> +0.3。换成中文 2 字滑窗后这个条件
    //   几乎不可能成立(要求标题同时含十几个 bigram), 会变成一条死规则。改为**梯度相关性**:
    //   命中比例越高加权越大(最多 +0.3), 与 scoreRelevance 的口径一致(命中数 + 覆盖率)。
    if (ts.length) {
      const hay = (h.title || "") + "\n" + (h.snippet || "");
      let matched = 0;
      for (const t of ts) if (hay.includes(t)) matched++;
      if (matched > 0) boost += 0.3 * (matched / ts.length);
    }
    if (h.source === "PLATFORM_SPEC") boost += 0.25;
    // 2026-09-10 修正(实测: 使用率 0, 检索只捞旧条目): 会话提炼/agent 产出属"刚学到的知识",
    //   不加权则永远被历史高分条目压住 -> 注入再多次也用不到新产物, 飞轮无法复利。
    if (h.source === "SESSION_EXTRACT") boost += 0.5;
    if (h.source === "AGENT_OUTPUT") boost += 0.05;
    // 2026-09-29 (agent-d 休假期间) 长尾多样性: 0.05 太轻, 几乎不起作用(实测 30d use=0
    //   仍占 84-89% — audit-tail-circulation.cjs 验证).
    // 2026-10-08 round 65 提升: use=0 加权从 +0.05 提到**质量分自适应**:
    //   - 质量分 ≥ 0.7 的 use=0 长尾: +0.25 (高分高质量被忽视, 优先级大)
    //   - 质量分 0.5-0.7: +0.15
    //   - 质量分 < 0.5:  +0.05 (不抬低质条目)
    //   一次性把 use=0 的高分条目从"被高频条目压住"提升到"有机会被选"。
    //   上限保护: 一旦被消费过(useCount>=1)即不再获得该倾斜, 机制自限, 不会造成新马太。
    if ((h.useCount ?? 0) === 0) {
      const s = h.score ?? 0;
      if (s >= 0.7) boost += 0.25;
      else if (s >= 0.5) boost += 0.15;
      else boost += 0.05;
    }
    return { h, boost };
  }).sort((a, b) => b.boost - a.boost);
  // 2026-09-29 (agent-d 休假期间) 修**类型挤出**:
  //   实测(tsx 直调 searchContext): practice 检索本身正常(单独查有 5 条命中),
  //   但在混合检索里**一条都进不来** —— 因为本段按 boost 降序 + 每类上限 quota 选,
  //   而 memory 命中 SESSION_EXTRACT(+0.35)/AGENT_OUTPUT 等 source 加权, 分数系统性高于
  //   practice/skill, 于是 limit=8 时前 8 个被 memory+skill 占满, practice 还没轮到就 break。
  //   后果: Practice 表 7d 100% usageCount=0 —— 25500+ 条实践**从未进入过消费闭环**。
  //   这与"产出虽多但长尾永不被用"是同一类结构问题, 对四类核心产物都成立。
  // 修法: 先按 kind **各保底 1 个**(round-robin 首个), 再按 boost 补齐剩余名额(仍受 quota 约束)。
  //   效果: 每类产物都有机会被注入/计使用; 单类刷屏仍被 quota 挡住。
  const quota = Math.max(1, Math.ceil((limit * 2) / 3));
  const perKind: Record<string, number> = {};
  const picked: ContextHit[] = [];
  const seededKind = new Set<string>();
  for (const { h } of scored) {
    if (seededKind.has(h.kind)) continue;
    seededKind.add(h.kind);
    perKind[h.kind] = (perKind[h.kind] || 0) + 1;
    picked.push(h);
    if (picked.length >= limit) break;
  }

  for (const { h } of scored) {
    if (picked.includes(h)) continue;
    perKind[h.kind] = (perKind[h.kind] || 0) + 1;
    if (perKind[h.kind] > quota) continue;
    picked.push(h);
    if (picked.length >= limit) break;
  }
  // 配额未填满则按 boost 补齐
  if (picked.length < limit) {
    for (const { h } of scored) {
      if (picked.includes(h)) continue;
      picked.push(h);
      if (picked.length >= limit) break;
    }
  }
  // 2026-09-10: 计使用下沉到本函数(纯函数调用, 零 HTTP — 上轮在路由内自 HTTP 调用导致 cron 500 自锁)。
  //   任何调用方(生成器/反思/结构化/worker)检索到产物即计一次使用, 飞轮才能度量记忆->使用。
  // 2026-10-17 P0-1(人类已批准): **事件必须覆盖 0 命中**。原实现把"用量自增 + 事件"整个写在
  //   `picked.length` 里, 于是**零命中派发在平台侧没有任何痕迹** —— 实测(只读)27974 条
  //   `CONTEXT_INJECTED` 里 `count=0` 的 **0 条** ⇒ 平台无法回答"今天有没有派发零命中"。
  //   现拆成两段(改动逐行可回退 = 把下面 ② 挪回 ① 的 if 内):
  //     ① 用量自增: 仍**只在有命中时**做(一字未改);
  //     ② 事件: **有命中/零命中都落**, 仍受 `countUsage !== false` 门控 ⇒ 探针的 `countUsage=false`
  //        依旧不写事件, **不污染指标**。
  // ===== 2026-10-25 资产归属：Memory 命中按归属过滤（Knowledge/Skill 待加列后同法接入）=====
  if (opts.scopeSql && picked.some((h) => h.kind === "memory")) {
    try {
      const memIds = picked.filter((h) => h.kind === "memory").map((h) => h.id);
      const rows = await prisma.$queryRawUnsafe<any[]>(
        "SELECT id FROM Memory WHERE id IN (" + memIds.map(() => "?").join(",") + ") AND (" + opts.scopeSql + ")",
        ...memIds);
      const allowed = new Set((rows || []).map((r: any) => String(r.id)));
      for (let i = picked.length - 1; i >= 0; i--) {
        if (picked[i].kind === "memory" && !allowed.has(String(picked[i].id))) picked.splice(i, 1);
      }
    } catch { /* 过滤失败不阻断注入（宁可多给，不可让注入 500） */ }
  }
  // 2026-10-25: Knowledge/Skill 同法过滤（表与列名不同 -> 按 kind 各查一次；只在调用方确认"列存在"时才传）
  for (const kind of ["knowledge", "skill"] as const) {
    const sql = opts.scopeSqlByKind && opts.scopeSqlByKind[kind];
    if (!sql || !picked.some((h) => h.kind === kind)) continue;
    const table = kind === "knowledge" ? "Knowledge" : "Skill";
    try {
      const ids = picked.filter((h) => h.kind === kind).map((h) => h.id);
      const rows = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id FROM "' + table + '" WHERE id IN (' + ids.map(() => "?").join(",") + ") AND (" + sql + ")",
        ...ids);
      const allowed = new Set((rows || []).map((r: any) => String(r.id)));
      for (let i = picked.length - 1; i >= 0; i--) {
        if (picked[i].kind === kind && !allowed.has(String(picked[i].id))) picked.splice(i, 1);
      }
    } catch { /* 过滤失败不阻断注入 */ }
  }
  if (opts.countUsage !== false) {
    if (picked.length) {
      try {
        const memIds = picked.filter((h) => h.kind === "memory").map((h) => h.id);
        const knIds = picked.filter((h) => h.kind === "knowledge").map((h) => h.id);
        // 2026-09-29: practice 也计入 (原先只记 memory/knowledge, Practice 永远 use=0)
        const prIds = picked.filter((h) => h.kind === "practice").map((h) => h.id);
        const now = new Date();
        if (memIds.length) await prisma.$executeRawUnsafe("UPDATE Memory SET accessCount = COALESCE(accessCount,0)+1, lastAccessed = ? WHERE id IN (" + memIds.map(() => "?").join(",") + ")", now, ...memIds);
        if (knIds.length) await prisma.$executeRawUnsafe("UPDATE Knowledge SET usageCount = COALESCE(usageCount,0)+1, lastUsedAt = ? WHERE id IN (" + knIds.map(() => "?").join(",") + ")", now, ...knIds);
        if (prIds.length) await prisma.$executeRawUnsafe("UPDATE Practice SET reinforceCount = COALESCE(reinforceCount,0)+1, updatedAt = ? WHERE id IN (" + prIds.map(() => "?").join(",") + ")", now, ...prIds);
      } catch { /* 计数失败不影响检索 */ }
    }
    // 2026-09-11 P0 记忆->使用闭环: 原事件只写 "mem=3 kn=2", 从不记 id -> 无法归因"用了哪条"。
    //   改为统一 JSON(含 ids); mem/kn 计数保留在 JSON 里, 便于人读。
    // 2026-10-10 round 72-AB: 记下**调用者身份**。此前 sourceId 恒为 "searchContext", 而 mind 改成
    //   生产模式后 next start 不再打请求日志 —— 于是「谁在反复调检索接口」彻底不可查(实测最近 60
    //   分钟 89 次注入里有 59 次无标识, 无法归因)。调用方用 opts.source 声明自己(冒烟=smoke /
    //   待办兜底=todo-worker / 排障=manual ...); 不传则保持原值, 向后兼容。
    // 2026-10-17 P0-1: 本段**不再**要求 `picked.length` —— `count: 0` 正是"零命中"的可观测锚点。
    try {
      const src = String(opts.source || "").trim().slice(0, 32) || "searchContext";
      await prisma.flywheelEvent.create({ data: { stage: "CONTEXT_INJECTED", sourceType: "context-seed", sourceId: src, sourceTitle: buildInjectedTitle({ agentId: opts.agentId ?? null, source: src, count: picked.length, kinds: Array.from(new Set(picked.map((h) => h.kind))), ids: picked.map((h) => h.id) }), targetStage: "OK" } });
    } catch { /* 事件失败不影响检索 */ }
  }
  return picked;
}

/** uos20 #2 Skills 按需加载(方案 A): skill_view(name) 按需取回全文。
 *  加载层(platform 上下文注入)只给 {name,description} 轻量列表; agent 判定某技能可用时,
 *  以 name 精确取回完整规范(steps=content / trigger / verification / pitfalls 等)。
 *  失败(未找到/无全文)返回 null, 不抛异常 —— 与 searchContext 的"失败不阻塞"口径一致。 */
export async function skillViewByName(name: string): Promise<any | null> {
  const n = String(name || "").trim();
  if (!n) return null;
  try {
    const s: any = await prisma.skill.findUnique({
      where: { name: n },
      select: { id: true, name: true, category: true, level: true, description: true, content: true,
                trigger: true, verification: true, pitfalls: true, platforms: true, theme: true,
                qualityScore: true, totalUsageCount: true, version: true, stale: true, legacy: true,
                createdAt: true, updatedAt: true },
    });
    return s || null;
  } catch {
    return null;
  }
}

/** 分数渲染口径(2026-10-16 P0-2): `0.8999999999999999` -> `0.9`, `1.0000000000000002` -> `1`。
 *
 *  为什么必须在这里收口(实测, 不是洁癖): 命中分数来自 `searchContext` 的相关性计算, 是**浮点数**,
 *  直接 `String(score)` 会打出 JS 的全精度表示 —— 实测 42.4% 的条目命中这种形态(最常见的是
 *  `score 0.8999999999999999`, 18 个字符), 白占 ≈30 B/次派发, 而且对执行体毫无信息量
 *  (`0.8999999999999999` 与 `0.9` 是同一个分数)。
 *
 *  口径与 responder 侧 `lib/platform_context.py::_fmt_score` **逐字符对齐**(两位小数 + 去尾 0 + 去尾点);
 *  非有限数/空值 -> `"-"`(与原先 `h.score ?? "-"` 一致), 解析不了的字符串原样返回。
 *  改这里同时让**两条消费路径**受益: ①服务端 renderContextSeed 直出的种子串(直通路径原样保留),
 *  ②responder 压缩块(它要么原样保留服务端串, 要么按同一口径重新格式化)。
 */
export function fmtScore(score: unknown): string {
  if (score === null || score === undefined || score === "") return "-";
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n)) return String(score);
  return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** P4(2026-10-16, 人类已批准)之前: 注入正文**每一条**都 `slice(0, 180)`。实测后果是**第 1 名**
 *  (平台按相关性排序的 top-1, 恰恰是最该被读全的那条)与第 200 名受同一个 180 字符上限 ——
 *  于是"最相关的一条"经常在关键句之前被切断, 执行体拿到的只是摘要的头。
 *
 *  本常量为**第 2..N 名**的正文上限, 值**保持 180 不变**(第 2 名及以后的行为逐字未改)。
 *  第 1 名自 P4 起不再受本条约束(完整正文), 但仍受 renderContextSeed 末尾的**整块预算**
 *  `.slice(0, budget)` 约束 —— 总预算语义一个字未动。 */
export const CONTEXT_SEED_TAIL_SNIPPET_CHARS = 180;

/** 渲染成提示词片段(带 id 后缀便于引用/回溯)。容量: 2026-09-23 由 1400 字符(~2K token) 提升到
 *  MEMORY_SEED_MAX_TOKENS(默认 50K+ token); 调用方可显式传更小的 maxChars 自限。
 *  2026-10-16: score 由全精度改为 fmtScore() 两位口径(P0-2, 净省字节, 见该函数注释)。
 *  2026-10-16 P4(人类已批准): **第 1 名不再 `slice(0, 180)`**(保留完整正文, 只受整块 budget 约束);
 *  第 2 名及以后仍是 `slice(0, CONTEXT_SEED_TAIL_SNIPPET_CHARS=180)` —— 逐字不变。
 *  空白折叠(`replace(/\s+/g, " ")`)对第 1 名**照旧保留**: 那是"每条一行"的格式约束(解析侧按 \n 切条),
 *  不是长度截断 —— P4 放开的是长度, 不是格式。
 *  配对发布约束(部署时必读): responder 侧 `scripts/macs-responder/lib/platform_context.py` 的
 *  §R-8 压缩块把每条正文夹到 `MEMORY_INJECT_SNIPPET_CHARS=120` 且整块 2048 B。**若该 2048B 版本部署时
 *  不同时放开 top-1 的 120, P4 会被静默撤销**(执行体看到的仍是短的)。本文件不碰 responder(独立步骤)。 */
export function renderContextSeed(hits: ContextHit[], maxChars?: number): string {
  if (!hits.length) return "";
  const budget = maxChars ?? maxCharsForTokens(memorySeedMaxTokens());
  const lines = hits.map((h, i) => {
    const snippet = h.snippet.replace(/\s+/g, " ");
    // i === 0 = 平台排序 top-1 -> 完整正文; i >= 1 -> 原 180 字符上限(逐字不变)。
    const body = i === 0 ? snippet : snippet.slice(0, CONTEXT_SEED_TAIL_SNIPPET_CHARS);
    return "- [" + h.kind + (h.layer ? "/" + h.layer : "") + " " + h.id.slice(-6) + "] " + (h.title || "") + " (score " + fmtScore(h.score) + "): " + body;
  });
  return ("=== 平台记忆注入 (执行前先读, 避免重复劳动/重复结论) ===\n" + lines.join("\n")).slice(0, budget);
}