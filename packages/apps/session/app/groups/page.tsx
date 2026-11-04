import { prisma } from "@/lib/prisma";
import Topbar from "../components/Topbar";
import Link from "next/link";
// 2026-09-02: 排除 0-消息 group + 全部成员都是 cron 的 group
import { buildGroupWhere, getNonCronGroupIds } from "@/lib/session-filters";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

const STATUS_BADGE: Record<string, string> = {
  PENDING: "badge-pending",
  PROCESSING: "badge-pending",
  DONE: "badge-ok",
  FAILED: "badge-fail",
};

export default async function GroupsPage({
  searchParams,
}: {
  searchParams: { status?: string; agentType?: string; q?: string; offset?: string };
}) {
  const offset = Math.max(0, parseInt(searchParams.offset || "0", 10));

  const userWhere: Record<string, unknown> = {};
  // Phase 2 2026-08-31: 过滤空壳 group (sessionCount=0, 孤儿清理后遗留)
  userWhere.sessionCount = { gt: 0 };
  if (searchParams.status) {
    if (searchParams.status === "PENDING") {
      userWhere.OR = [{ extractStatus: "PENDING" }, { extractStatus: null }];
    } else {
      userWhere.extractStatus = searchParams.status;
    }
  }
  if (searchParams.agentType) userWhere.agentType = searchParams.agentType;
  if (searchParams.q) {
    userWhere.OR = [
      { titleBase: { contains: searchParams.q } },
      { groupKey: { contains: searchParams.q } },
    ];
  }
  // 2026-09-02: 排除 0-消息 group
  const where = buildGroupWhere(userWhere) as any;
  const whereAny = where as any;

  // 2026-09-02: 排除全部成员都是 cron 任务的 group (699 个 ut-cron-group + 22 个 cron_ 前缀)
  const nonCronGroupIds = await getNonCronGroupIds();

  const nonCronIds = Array.from(nonCronGroupIds);
  const idFilter = nonCronIds.length > 0 ? { id: { in: nonCronIds } } : { id: { in: ["__none__"] } };
  const whereWithId: any = { AND: [where, idFilter] };
  const [groups, total, statusCounts, agentTypeCounts] = await Promise.all([
    prisma.sessionGroup.findMany({
      where: whereWithId,
      // 2026-09-01: 按最后活动时间倒序 (列表设计规范) — 之前按 sessionCount desc,
      //   2295 会话的旧 group 永远置顶, 最新更新的 group 沉底。
      //   SessionGroup.updatedAt 存在 1970 垃圾值, 改用 lastMessageAt (组内最后消息时间)
      orderBy: [{ lastMessageAt: "desc" }, { sessionCount: "desc" }],
      skip: offset,
      take: PAGE_SIZE,
      select: {
        id: true, groupKey: true, titleBase: true, agentType: true, workdir: true,
        sessionCount: true, messageCount: true, firstMessageAt: true, lastMessageAt: true,
        updatedAt: true, extractStatus: true,
      },
    }),
    prisma.sessionGroup.count({ where: whereWithId }),
    prisma.sessionGroup.groupBy({ by: ["extractStatus"], _count: true, where: whereWithId }),
    prisma.sessionGroup.groupBy({ by: ["agentType"], _count: true, where: whereWithId }),
  ]);

  const statusMap: Record<string, number> = {};
  for (const s of statusCounts) statusMap[s.extractStatus || "PENDING"] = s._count;
  const agentMap: Record<string, number> = {};
  for (const a of agentTypeCounts) agentMap[a.agentType || "unknown"] = a._count;

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const curPage = Math.floor(offset / PAGE_SIZE) + 1;

  const qParams = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (searchParams.q) p.set("q", searchParams.q);
    if (searchParams.status) p.set("status", searchParams.status);
    if (searchParams.agentType) p.set("agentType", searchParams.agentType);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  };

  return (
    <>
      <Topbar active="groups" />
      <main className="page page-wide">
        <div className="list-header">
          <div className="left">
            <h1>Session Groups</h1>
            <div className="subtitle">{total} groups · 按主题归类的会话聚合</div>
          </div>
          <div className="right">
            <form method="get">
              {searchParams.status && <input type="hidden" name="status" value={searchParams.status} />}
              {searchParams.agentType && <input type="hidden" name="agentType" value={searchParams.agentType} />}
              <div className="filter-bar" style={{ margin: 0 }}>
                <div className="search">
                  <input type="text" name="q" defaultValue={searchParams.q || ""} placeholder="搜索 group 标题..." />
                </div>
              </div>
            </form>
          </div>
        </div>

        {/* Status filter */}
        <div className="filter-section">
          <div className="filter-label">Status</div>
          <div className="chips">
            <Link href={`/groups?${qParams({})}`} className={`chip ${!searchParams.status ? "active" : ""}`}>
              All <span className="n">{total}</span>
            </Link>
            {(["PENDING", "PROCESSING", "DONE", "FAILED"] as const).map((s) => (
              <Link key={s} href={`/groups?${qParams({ status: s })}`} className={`chip ${searchParams.status === s ? "active" : ""}`}>
                {s} <span className="n">{statusMap[s] || 0}</span>
              </Link>
            ))}
          </div>
        </div>

        {/* Agent filter */}
        <div className="filter-section">
          <div className="filter-label">Agent</div>
          <div className="chips">
            <Link href={`/groups?${qParams({})}`} className={`chip ${!searchParams.agentType ? "active" : ""}`}>
              All
            </Link>
            {Object.entries(agentMap).map(([k, v]) => (
              <Link key={k} href={`/groups?${qParams({ agentType: k })}`} className={`chip ${searchParams.agentType === k ? "active" : ""}`}>
                {k} <span className="n">{v}</span>
              </Link>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="table-wrap">
          <table className="session-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Agent</th>
                <th>Sessions</th>
                <th>Messages</th>
                <th>First</th>
                <th>Last activity</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div className="group-key-cell">
                      <Link href={`/groups/${encodeURIComponent(g.groupKey)}`} className="title">
                        {g.titleBase || g.groupKey}
                      </Link>
                    </div>
                    {g.workdir && <div className="uid">{g.workdir}</div>}
                  </td>
                  <td>
                    <span className="agent-cell">
                      <span className="swatch" style={{ background: `var(--agent-${g.agentType || "ut"})` }} />
                      {g.agentType || "—"}
                    </span>
                  </td>
                  <td className="num">{g.sessionCount}</td>
                  <td className="num">{g.messageCount.toLocaleString()}</td>
                  <td className="time">{g.firstMessageAt ? new Date(g.firstMessageAt).toLocaleDateString("zh-CN") : "—"}</td>
                  <td className="time" title={g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleString("zh-CN") : "—"}>
                    {g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[g.extractStatus || "PENDING"]}`}>
                      <span className="pip" />
                      {g.extractStatus || "PENDING"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {groups.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--ink-muted)" }}>
            No groups found.
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="list-pagination">
            {offset > 0 ? (
              <Link className="btn" href={`/groups?${qParams({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}`}>
                ← 上一页
              </Link>
            ) : (
              <span className="btn btn-disabled">← 上一页</span>
            )}
            <span className="page-info">第 {curPage} / {totalPages} 页 · 共 {total} 条</span>
            {offset + PAGE_SIZE < total ? (
              <Link className="btn" href={`/groups?${qParams({ offset: String(offset + PAGE_SIZE) })}`}>
                下一页 →
              </Link>
            ) : (
              <span className="btn btn-disabled">下一页 →</span>
            )}
          </div>
        )}
      </main>
    </>
  );
}
