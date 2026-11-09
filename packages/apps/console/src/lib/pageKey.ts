// 2026-11-06 页面标记 key 表（D-03）—— **由 scripts/gen-console-page-key.cjs 生成，勿手改**
// 用途：根 layout 在每个页面的 SSR 输出里写一个稳定的 data-page 标记，
//   让"首屏空壳"可被判据断言（客户端页在数据到之前没有页头，但一定会有这个标记）。
// 口径：key = release-pages 清单里的 route 原样（动态段保留 [id] / [dim]）；
//   **301 下线的路由不进表**（它们由 next.config 在进入路由前重定向，永远不会渲染页面），
//   否则 check-offline-301 的"代码引用旧路由"会把这张表判成 4 处引用（0.4.32-06 修的就是这个）。
// 数据源：release-pages-0.4.30.json（83 条）− next.config 的 301 规则（6 条）

export const PAGE_ROUTES: string[] = [
  "/agents-live",
  "/agents/[id]/config",
  "/agents/[id]/org",
  "/agents/[id]/overview",
  "/agents/[id]",
  "/agents/[id]/runs",
  "/agents/[id]/versions",
  "/agents/approvals",
  "/agents/capabilities",
  "/agents/detail",
  "/agents/keys",
  "/agents/onboard",
  "/agents/org",
  "/agents",
  "/agents/session-browser",
  "/agents/sessions",
  "/agents/transfer",
  "/audit/daily-summary",
  "/audit",
  "/cognitive/knowledge/detail",
  "/cognitive/knowledge/governance",
  "/cognitive/knowledge",
  "/cognitive/memory/detail",
  "/cognitive/memory",
  "/cognitive",
  "/cognitive/practice/detail",
  "/cognitive/practice",
  "/cognitive/reflection/detail",
  "/cognitive/reflection",
  "/cognitive/skills/detail",
  "/cognitive/skills",
  "/cost",
  "/design",
  "/flywheel/audit",
  "/flywheel/coverage",
  "/flywheel/executions",
  "/flywheel/findings",
  "/flywheel/flow",
  "/flywheel/hard-metrics",
  "/flywheel/improvement-results",
  "/flywheel/learning",
  "/flywheel/llm-usage",
  "/flywheel/logs",
  "/flywheel",
  "/flywheel/reflections",
  "/flywheel/tasks/[id]",
  "/flywheel/tasks/new",
  "/flywheel/tasks",
  "/lineage",
  "/market",
  "/messages/failed",
  "/messages/manage",
  "/messages",
  "/messages/session",
  "/",
  "/platform/logic",
  "/platform/model",
  "/platform/ops",
  "/sessions/detail",
  "/sessions",
  "/system/access-log",
  "/system/api",
  "/system/assets",
  "/system/auth",
  "/system/automation",
  "/system/business",
  "/system/client-releases",
  "/system/guards",
  "/system/health",
  "/system",
  "/system/permissions",
  "/system/pipeline",
  "/system/rotation",
  "/terminals/detail",
  "/terminals",
  "/todo",
  "/tools",
];

/** 把真实 pathname 归一成清单里的 route pattern（动态段换成 [id]/[dim]）。 */
function toPatterns(p: string): string[] {
  const segs = p.split("/").filter(Boolean);
  const out = new Set<string>();
  const walk = (i: number, acc: string[]) => {
    if (i === segs.length) { out.add("/" + acc.join("/")); return; }
    const s = segs[i];
    walk(i + 1, [...acc, s]);
    walk(i + 1, [...acc, "[id]"]);
    walk(i + 1, [...acc, "[dim]"]);
  };
  walk(0, []);
  return Array.from(out);
}

/** 返回该 pathname 对应的清单 route；不在清单里返回空串（判据据此判"不在清单"）。 */
export function pageKeyOf(pathname: string): string {
  const clean = ("/" + String(pathname || "").split("?")[0]).replace(/\/+$/, "") || "/";
  if (clean === "/") return "/";
  if (PAGE_ROUTES.includes(clean)) return clean;
  for (const cand of toPatterns(clean)) if (PAGE_ROUTES.includes(cand)) return cand;
  return "";
}
