/**
 * POST /api/v1/flywheel/title-refine — 标题/技能名的 LLM 缩写(**只提案, 不写库**)
 *
 * 为什么需要(2026-10-09 round 69): `server/llm/shorten-title.ts` 自 round 59 就存在, 但**没有任何调用方**
 *   —— 死的代码等于没有这个能力。而确定性归一(`normalizeProductTitle` 的"保头保尾压缩")在某些输入上
 *   只会产出 `SQLite…JOIN查询` 这类省略号名: 长度合规了, 但**丢掉了区分度**。LLM 能在同样 ≤20 字里
 *   给出更忠实、更有区分度的版本(例: `SQLite CTE检测孤儿记录`)。这是确定性算法做不到的部分。
 *
 * 职责边界(**刻意不写库**):
 *   - 本端点只把"原名 -> LLM 建议名"算出来返回; 落库由调用方(`scripts/refine-overlong-titles.cjs --llm`)
 *     在自己的快照/回滚保护下做。理由: 一次 HTTP 调用就静默改写 859 行标题, 无法审计也无法回滚。
 *   - 每条都过 `validateShortened`(长度上限 / 非空 / 禁忌模板 / 与原文字符 Jaccard 相似度 ≥0.4),
 *     LLM 改写含义时**拒绝而不是接受**。
 *
 * 请求: { items: [{ id, text, kind }], limit?: number, mode?: "abbreviate" | "all" }
 *   kind ∈ knowledge | practice | memory | skill (skill 上限 20, 其余 30)
 *   limit 默认 8, 硬上限 20(串行调用, 单条 8s 超时 + 最多 2 次重试, 见 shorten-title.ts)
 *   mode 默认 "abbreviate"(只产 name, 行为与 round 69 一致);
 *   mode "all" 走 llmDescribeRow, 一次 LLM 调用产出 {name, summary, tags} 三件套
 *     (round 72-B 用这个: 1 次调用 = 3 个字段, 39,545 Skill × 3 = 12 万次调用 -> 砍到 4 万次, 单窗口跑得完)
 * 响应(200): { ok, mode, stats: { requested, processed, shortened|complete, failed, unchanged|shortInput,
 *              budgetExhausted, durationMs }, results: [...] }
 *   单条失败**不影响**其它条(逐条 try/catch), 失败条以 ok:false + error 类名返回。
 * 响应(400): 请求体不合法 / 超硬上限 —— 明确报错, 不悄悄截断(截断会让调用方以为都处理了)。
 *
 * 预算保护: 总耗时超过 BUDGET_MS(默认 120s)后**停止再开新条**, 剩余条标 `skipped_budget`,
 *   并置 stats.budgetExhausted=true —— 调用方据此分批重试, 而不是拿到一个静默的短结果。
 */
import { llmShortenOne, llmDescribeRow, TITLE_MAX, SKILL_NAME_MAX, LlmError } from "@/server/llm/shorten-title";

const KINDS = new Set(["knowledge", "practice", "memory", "skill"]);
const HARD_CAP = 20;
const BUDGET_MS = Number(process.env.TITLE_REFINE_BUDGET_MS ?? "120000");

type Item = { id: string; text: string; kind: string };

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const raw = Array.isArray(body?.items) ? body.items : null;
  if (!raw || raw.length === 0) return Response.json({ error: "MISSING_ITEMS" }, { status: 400 });
  if (raw.length > HARD_CAP) {
    return Response.json({ error: "TOO_MANY_ITEMS", message: "单次最多 " + HARD_CAP + " 条(串行 LLM 调用), 请分批", got: raw.length }, { status: 400 });
  }

  const items: Item[] = [];
  for (const r of raw) {
    const id = String(r?.id ?? "").trim();
    const text = String(r?.text ?? "").trim();
    const kind = String(r?.kind ?? "").trim();
    if (!id || !text) return Response.json({ error: "ITEM_MISSING_ID_OR_TEXT", item: r }, { status: 400 });
    if (!KINDS.has(kind)) return Response.json({ error: "ITEM_BAD_KIND", message: "kind 必须是 " + [...KINDS].join(" | "), item: r }, { status: 400 });
    items.push({ id, text, kind });
  }

  const limit = Math.max(1, Math.min(Number(body?.limit ?? 8) || 8, HARD_CAP));
  const mode: "abbreviate" | "all" = body?.mode === "all" ? "all" : "abbreviate";
  const budget = items.slice(0, limit);
  const dropped = items.slice(limit);

  const t0 = Date.now();
  const results: any[] = [];
  let processed = 0, failed = 0, shortInput = 0;
  let budgetExhausted = false;

  for (const it of budget) {
    if (Date.now() - t0 > BUDGET_MS) { budgetExhausted = true; break; }
    const max = it.kind === "skill" ? SKILL_NAME_MAX : TITLE_MAX;
    if (mode === "abbreviate") {
      // mode: abbreviate —— 只产 name, 行为与 round 69 一致
      if (it.text.length <= max) {
        shortInput++;
        results.push({ id: it.id, kind: it.kind, original: it.text, shortened: it.text, ok: true, note: "already_compliant" });
        continue;
      }
      try {
        const out = await llmShortenOne(it.text, it.kind as any);
        processed++;
        results.push({ id: it.id, kind: it.kind, original: it.text, shortened: out, ok: true });
      } catch (e) {
        failed++;
        results.push({ id: it.id, kind: it.kind, original: it.text, shortened: null, ok: false,
          error: e instanceof LlmError ? e.constructor.name : "UnknownError",
          message: String((e as any)?.message ?? e).slice(0, 200) });
      }
    } else {
      // mode: all —— 一次 LLM 调用产 name + summary + tags (round 72-B-prep)
      // 注意: 即使 it.text 短(已合规), 也仍调 LLM 拿 summary 和 tags —— caller 要的是**三件套**
      try {
        const r = await llmDescribeRow(it.text, it.kind as any);
        processed++;
        results.push({ id: it.id, kind: it.kind, original: it.text, name: r.name, summary: r.summary, tags: r.tags, ok: true });
      } catch (e) {
        failed++;
        results.push({ id: it.id, kind: it.kind, original: it.text, ok: false,
          error: e instanceof LlmError ? e.constructor.name : "UnknownError",
          message: String((e as any)?.message ?? e).slice(0, 200) });
      }
    }
  }

  const processedIds = new Set(results.map((r) => r.id));
  for (const it of [...budget, ...dropped]) {
    if (processedIds.has(it.id)) continue;
    failed++;
    results.push({ id: it.id, kind: it.kind, original: it.text, ok: false, error: "SkippedBudgetOrLimit" });
  }

  return Response.json({
    ok: true,
    mode,
    stats: {
      requested: items.length, processed: results.length,
      ...(mode === "abbreviate" ? { shortened: processed, unchanged: shortInput } : { complete: processed }),
      failed, budgetExhausted, durationMs: Date.now() - t0,
      limits: { titleMax: TITLE_MAX, skillNameMax: SKILL_NAME_MAX, hardCap: HARD_CAP, limit },
    },
    results,
  });
}
