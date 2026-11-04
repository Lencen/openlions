// Server-side data fetching for Agent Activity
// 2026-06-10 P3-2 修复: 加 AbortController timeout + 详细错误日志 + 兜底空数据
import AgentActivitySection from "./AgentActivitySection";

export const dynamic = "force-dynamic"; // 每次请求都重新拉取

interface SummaryData {
  recallByAgent: Record<string, number>;
  rememberByAgent: Record<string, number>;
  hotBySource: Record<string, { count: number; percent: number }>;
  hotTotal: number;
  recallTotal: number;
  rememberTotal: number;
  windowHours: number;
}

// 空数据 fallback — fetch 失败时返回零值而不是 null,UI 显示"暂无活动"而不是红色错误
function emptySummary(hours: number): SummaryData {
  const empty: Record<string, number> = {};
  return {
    recallByAgent: empty,
    rememberByAgent: empty,
    hotBySource: {},
    hotTotal: 0,
    recallTotal: 0,
    rememberTotal: 0,
    windowHours: hours,
  };
}

export default async function AgentActivityServer() {
  const hours = 24;
  let initial: SummaryData | null = null;
  let error: string | null = null;
  // P3 修复: 用环境变量 MIND_API_URL 而不是写死 3000
  // dev 3000 / staging 3100 / prod 3200 自动适配
  const mindBase = process.env.MIND_API_URL || "http://localhost:3000";

  // P3-2 修复: 5s AbortController timeout — 防止 mind 端 hang 死拖累 SSR
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const url = `${mindBase}/api/trpc/agentActivity.summary?input=` +
      encodeURIComponent(JSON.stringify({ json: { hours } }));
    const r = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeoutId);
    if (r.ok) {
      const j = await r.json();
      initial = j?.result?.data ?? null;
      if (!initial) {
        // 200 但 data 为 null (mind 端 schema 变更/字段缺失) — fallback
        console.warn("[AgentActivityServer] mind 200 但 data 为空, fallback empty");
        initial = emptySummary(hours);
      }
    } else {
      console.warn(`[AgentActivityServer] mind 返 ${r.status}`);
      error = `mind ${r.status}`;
      initial = emptySummary(hours); // P3-2: 不显示红错,显示空数据 + 文案
    }
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === "AbortError") {
      console.warn("[AgentActivityServer] mind fetch timeout (>5s)");
      error = "timeout";
    } else {
      console.warn(`[AgentActivityServer] fetch 失败: ${e?.message ?? String(e)}`);
      error = `fetch 失败: ${e?.message ?? String(e)}`;
    }
    initial = emptySummary(hours); // P3-2: fallback,UI 显示空数据而非红错
  }
  // P3-2 修复: 即使有 error 也注水空数据,UI 不会显示刺眼的红色"Failed to fetch"
  return <AgentActivitySection initial={initial} error={error} />;
}