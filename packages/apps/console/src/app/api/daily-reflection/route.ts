import { NextResponse } from "next/server";
import { asOf, num, q, openMind, safeClose } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/daily-reflection?limit=14
// 首页「日结」卡的数据源: 飞轮每天 00:00 自动生成的日结, 落在 mind 库
// FlywheelReflection 主题 DAILY·YYYY-MM-DD (正文在 summary, 结构在 dayStats)。
// 此前界面上完全看不到这一行, 本接口把它(及历史)只读取出来给首页卡片。
// 约束: 只读 mind 库; 库/表不可用或字段缺失一律降级为 available:false / 空数组, 不抛 500。
// 返回: latest (最近一期) + history (近期各期, 含正文与要点, 前端可就地切换日期, 无需再翻反思表)。

function parseJson<T>(s: unknown, fb: T): T {
  if (s == null || s === "") return fb;
  if (typeof s !== "string") return s as T;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fb;
  }
}

function buildItem(row: any) {
  const ds: any = parseJson(row.dayStats, {}) || {};
  const meta = ds.meta || {};
  const source = ds.source || {};
  const sessions = source.sessions || {};
  const products = ds.products || {};
  const memProd = products.memory || {};
  const buckets = memProd.qualityBuckets || {};
  const findings = ds.findings || {};
  const tasks = ds.tasks || {};
  const done = tasks.done || {};
  const failed = tasks.failed || {};
  const created = tasks.created || {};
  const produced = ds.produced || {};
  const leftover: any[] = Array.isArray(ds.leftover) ? ds.leftover : [];
  const suggested: any[] = Array.isArray(ds.suggested) ? ds.suggested : [];
  const failedSamples: any[] = Array.isArray(failed.samples) ? failed.samples : [];
  const byPriority = findings.byPriority || {};

  const theme = String(row.theme || "");
  const date = String(meta.date || theme.replace(/^DAILY[·.]/, ""));
  const summary = String(row.summary || ds.summary?.text || "");

  const doneN = num(done.total);
  const failedN = num(failed.total);
  const execN = num(tasks.executions);
  const createdN = num(created.total);

  // 亮点: 只从结构化日结数据(dayStats)按规则生成, 不臆造 summary 里没有的事实。
  const highlights: string[] = [];
  if (doneN > 0 || failedN > 0) {
    highlights.push(
      failedN === 0
        ? `任务全部完成, 无失败(完成 ${doneN} 个)`
        : `任务完成 ${doneN} 个, 失败 ${failedN} 个`
    );
  }
  if (num(findings.resolved) > 0) {
    highlights.push(`已解决结构化问题 ${num(findings.resolved)} 条(识别 ${num(findings.total)} 条)`);
  }
  if (num(byPriority.P0) > 0) {
    highlights.push(`识别 P0 优先问题 ${num(byPriority.P0)} 条`);
  }
  const producedN = num(produced.memory) + num(produced.knowledge) + num(produced.practice);
  if (producedN > 0) {
    highlights.push(
      `改进落库产物 ${producedN} 条(记忆 ${num(produced.memory)} / 知识 ${num(produced.knowledge)} / 实践 ${num(produced.practice)})`
    );
  }
  const newProductsN = num(memProd.created) + num(products.knowledge?.created) + num(products.practice?.created);
  if (newProductsN > 0) {
    highlights.push(`新增提炼产物 ${newProductsN} 条`);
  }
  if (execN > 0) highlights.push(`自动执行 ${execN} 次`);

  // 异常 / 哪里不对: 规则日结已算好的遗留项 (失败任务 / 复发未解决 / 低覆盖) + 失败样本.
  const issues: { type: string; detail: string }[] = [];
  for (const l of leftover.slice(0, 6)) {
    if (!l || !l.detail) continue;
    issues.push({ type: String(l.type || "issue"), detail: String(l.detail) });
  }
  for (const s of failedSamples.slice(0, 3)) {
    const detail = [s.theme, s.title].filter(Boolean).join(" · ");
    if (detail && !issues.some((x) => x.detail.includes(detail.slice(0, 20)))) {
      issues.push({ type: "task_failed", detail });
    }
  }
  const qualityAvg = ds.quality?.avgMemoryQuality;
  if (issues.length === 0 && num(memProd.created) > 0 && num(buckets.low) > num(buckets.high)) {
    issues.push({ type: "low_quality", detail: `新增记忆低质量 ${num(buckets.low)} 条多于高质量 ${num(buckets.high)} 条` });
  }

  // 今日关注: 昨日最低覆盖的主题 (suggested) + 复发未解决的遗留项.
  const focus: { theme: string; coverage: number | null; reason: string }[] = [];
  for (const s of suggested.slice(0, 5)) {
    if (!s || !s.theme) continue;
    focus.push({
      theme: String(s.theme),
      coverage: s.coverage == null ? null : Number(s.coverage),
      reason: "覆盖度偏低, 今日优先补强",
    });
  }
  for (const l of leftover) {
    if (l?.type !== "recurring" || !l.ref) continue;
    if (focus.some((f) => f.theme === l.ref)) continue;
    focus.push({ theme: String(l.ref), coverage: null, reason: String(l.detail || "复发未解决") });
  }

  const generatedAtMs = meta.generatedAtUtc ? Date.parse(String(meta.generatedAtUtc)) : NaN;

  return {
    id: row.id,
    theme,
    date,
    granularity: row.reflectionGranularity || (theme.startsWith("DAILY") ? "day" : "theme"),
    generatedAt: Number.isFinite(generatedAtMs) ? generatedAtMs : num(row.updatedAt) || null,
    updatedAt: num(row.updatedAt) || null,
    coverageScore: row.coverageScore == null ? null : num(row.coverageScore),
    summary,
    overview: {
      themesReflected: num(source.themesReflectedCount),
      activeSessions: num(sessions.active),
      messages: num(sessions.messages),
      avgMemoryQuality: qualityAvg == null ? null : Number(qualityAvg),
    },
    counts: {
      tasksCreated: createdN,
      tasksDone: doneN,
      tasksFailed: failedN,
      executions: execN,
      findingsTotal: num(findings.total),
      findingsResolved: num(findings.resolved),
      findingsRecurring: num(findings.recurring),
    },
    products: {
      memory: num(memProd.created),
      knowledge: num(products.knowledge?.created),
      practice: num(products.practice?.created),
      improved: { memory: num(produced.memory), knowledge: num(produced.knowledge), practice: num(produced.practice) },
      qualityBuckets: {
        high: num(buckets.high),
        mid: num(buckets.mid),
        low: num(buckets.low),
        unscored: num(buckets.unscored),
      },
    },
    highlights,
    issues,
    focus,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") || "14");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 60) : 14;
  const wantDate = url.searchParams.get("date") || "";

  const mind = openMind();
  if (!mind) {
    return NextResponse.json({
      asOf: asOf(),
      available: false,
      warnings: ["管理库不可用: 日结卡已降级"],
      latest: null,
      history: [],
    });
  }

  let rows: any[] = [];
  try {
    rows = await q(
      mind,
      "SELECT id, theme, coverageScore, summary, dayStats, reflectionGranularity, updatedAt " +
        "FROM FlywheelReflection WHERE theme LIKE 'DAILY%' ORDER BY updatedAt DESC LIMIT ?",
      limit
    );
  } catch {
    rows = [];
  }
  safeClose(mind);

  // 只认日期形态为 YYYY-MM-DD 的日结, 避免将来出现 DAILY_SUMMARY 之类主题时被当作日结展示。
  const items = rows.map(buildItem).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date));
  let latest = items[0] || null;
  if (wantDate) {
    const picked = items.find((x) => x.date === wantDate);
    if (picked) latest = picked;
  }

  return NextResponse.json({
    asOf: asOf(),
    available: items.length > 0,
    warnings: items.length === 0 ? ["未找到已生成的日结(每日 00:00 自动生成)"] : [],
    latest,
    history: items.map((x) => ({
      id: x.id,
      theme: x.theme,
      date: x.date,
      generatedAt: x.generatedAt,
      coverageScore: x.coverageScore,
      tasksDone: x.counts.tasksDone,
      tasksFailed: x.counts.tasksFailed,
      summary: x.summary,
      overview: x.overview,
      counts: x.counts,
      products: x.products,
      highlights: x.highlights,
      issues: x.issues,
      focus: x.focus,
    })),
  });
}
