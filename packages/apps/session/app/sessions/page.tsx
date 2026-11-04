import { prisma } from "@/lib/prisma";
import Topbar from "../components/Topbar";
// 2026-09-02: 排除 0-消息 session + 定时任务触发的 session (cron: 前缀)
import { buildSessionWhere } from "@/lib/session-filters";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

const STATUS_BADGE: Record<string, string> = {
  DONE: "badge-ok",
  PENDING: "badge-pending",
  PROCESSING: "badge-pending",
  FAILED: "badge-fail",
  NONE: "badge-none",
};

const SOURCE_LABELS: Record<string, string> = {
  HERMES_SESSION: "Hermes",
  CLAUDE_CONVERSATION: "Claude",
  OPENCLAW_SESSION: "OpenClaw",  // Phase D 2026-08-31
  mcp: "MCP",
};

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: { page?: string; agent?: string; source?: string; status?: string; q?: string; sort?: string; order?: string };
}) {
  const page = Math.max(1, parseInt(searchParams.page || "1"));
  const agent = searchParams.agent;
  const source = searchParams.source;
  const status = searchParams.status;
  const q = searchParams.q;
  // Phase D 2026-08-31: 交互排序 (白名单防注入)
  // 2026-09-01: 默认排序改 updatedAt (同步/更新时间, 永不 NULL) — 之前用 lastMessageAt
  //   有 1487 条 NULL (无消息 session), DESC 时沉底导致"看起来没按时间排"
  const SORTABLE: Record<string, string> = {
    title: "title", agent: "agentId", source: "source", model: "model",
    msgs: "messageCount", started: "startedAt", last: "updatedAt",
    status: "extractStatus",
  };
  const sort = searchParams.sort && SORTABLE[searchParams.sort] ? searchParams.sort : "last";
  const order = searchParams.order === "asc" ? "asc" : "desc";
  // updatedAt desc then createdAt desc (列表设计规范)
  const orderBy: any = sort === "last"
    ? [{ updatedAt: order }, { createdAt: order }]
    : { [SORTABLE[sort]]: order };

  const userWhere: Record<string, unknown> = {};
  if (agent) userWhere.agentId = agent;
  if (source) userWhere.source = source;
  if (status) userWhere.extractStatus = status;
  if (q) userWhere.title = { contains: q };
  // 2026-09-02: 自动排除 0-消息 + cron 触发的 session
  const where = buildSessionWhere(userWhere) as any;
  // groupBy/count 也走相同过滤 (filter chips 计数才一致)
  const whereAny = where as any;

  const [sessions, total, allAgents, sources, statuses] = await Promise.all([
    prisma.session.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, sessionUid: true, title: true, agentId: true, agentName: true,
        source: true, channel: true, platform: true, model: true, summary: true,
        messageCount: true, startedAt: true, lastMessageAt: true, updatedAt: true, createdAt: true, extractStatus: true,
      },
    }),
    prisma.session.count({ where }),
    prisma.session.groupBy({ by: ["agentId"], _count: true, where: whereAny }),
    prisma.session.groupBy({ by: ["source"], _count: true, where: whereAny }),
    prisma.session.groupBy({ by: ["extractStatus"], _count: true, where: whereAny }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const fmt = (d: Date | null) =>
    d ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai",  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d) : "—";

  function link(extra: Record<string, string | null>) {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (agent) sp.set("agent", agent);
    if (source) sp.set("source", source);
    if (status) sp.set("status", status);
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    return `/sessions?${sp.toString()}`;
  }

  return (
    <>
      <Topbar active="sessions" stats={`${total.toLocaleString()} sessions`} />
      <main className="page page-wide">
        <div className="list-header">
          <div className="left">
            <h1>Sessions</h1>
            <div className="subtitle">{total.toLocaleString()} archived sessions · 按 agent / 来源 / 状态过滤</div>
          </div>
          <div className="right">
            <form method="get">
              {agent && <input type="hidden" name="agent" value={agent} />}
              {source && <input type="hidden" name="source" value={source} />}
              {status && <input type="hidden" name="status" value={status} />}
              <div className="filter-bar" style={{ margin: 0 }}>
                <div className="search">
                  <input type="text" name="q" defaultValue={q || ""} placeholder="搜索 session 标题..." />
                </div>
              </div>
            </form>
          </div>
        </div>

        {/* Agent filter */}
        <div className="filter-section">
          <div className="filter-label">Agent</div>
          <div className="chips">
            <a href={link({ agent: null })} className={`chip ${!agent ? "active" : ""}`}>All</a>
            {allAgents.map((a) => (
              <a key={a.agentId} href={link({ agent: a.agentId || "" })} className={`chip ${agent === a.agentId ? "active" : ""}`}>
                {(a.agentId || "?").replace("agent-", "")} <span className="n">{a._count}</span>
              </a>
            ))}
          </div>
        </div>

        {/* Source filter */}
        <div className="filter-section">
          <div className="filter-label">Source</div>
          <div className="chips">
            <a href={link({ source: null })} className={`chip ${!source ? "active" : ""}`}>All</a>
            {sources.map((s) => (
              <a key={s.source} href={link({ source: s.source || "" })} className={`chip ${source === s.source ? "active" : ""}`}>
                {SOURCE_LABELS[s.source || ""] || s.source || "?"} <span className="n">{s._count}</span>
              </a>
            ))}
          </div>
        </div>

        {/* Status filter */}
        <div className="filter-section">
          <div className="filter-label">Status</div>
          <div className="chips">
            <a href={link({ status: null })} className={`chip ${!status ? "active" : ""}`}>All</a>
            {statuses.map((s) => (
              <a key={s.extractStatus} href={link({ status: s.extractStatus || "" })} className={`chip ${status === s.extractStatus ? "active" : ""}`}>
                {s.extractStatus || "NONE"} <span className="n">{s._count}</span>
              </a>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="table-wrap">
          <table className="session-table">
            <thead>
              <tr>
                {[
                  ["title", "Title"], ["agent", "Agent"], ["source", "Source"], ["model", "Model"],
                  ["msgs", "Msgs"], ["started", "Started"], ["last", "Updated"], ["status", "Status"],
                ].map(([f, label]) => {
                  const active = sort === f;
                  const nextOrder = active && order === "desc" ? "asc" : "desc";
                  const arrow = active ? (order === "desc" ? " ↓" : " ↑") : "";
                  return (
                    <th key={f}>
                      <a href={link({ sort: f, order: nextOrder })} className="sortable" title="点击排序">
                        {label}{arrow}
                      </a>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={`/sessions/${s.id}`} className="title" title={s.title || "Untitled"}>
                      {s.title || "Untitled"}
                    </a>
                    <div className="uid">{s.channel || s.platform || ""}</div>
                  </td>
                  <td>
                    <span className="agent-cell">
                      <span className="swatch" style={{ background: `var(--agent-${(s.agentId || "ut").replace("agent-", "")})` }} />
                      {(s.agentId || "—").replace("agent-", "")}
                    </span>
                  </td>
                  <td>{SOURCE_LABELS[s.source || ""] || s.source || "—"}</td>
                  <td className="num">{s.model || "—"}</td>
                  <td className="num">{s.messageCount}</td>
                  <td className="time">{fmt(s.startedAt)}</td>
                  <td className="time" title={s.updatedAt ? new Date(s.updatedAt).toLocaleString("zh-CN") : "—"}>
                    {fmt(s.updatedAt)}
                    {s.updatedAt && s.lastMessageAt && s.updatedAt.getTime() - new Date(s.lastMessageAt).getTime() > 3600000 && (
                      <div className="uid" style={{ color: "var(--ink-muted)" }}>sync</div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[s.extractStatus || "NONE"]}`}>
                      <span className="pip" />
                      {s.extractStatus || "NONE"}
                    </span>
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: "center", padding: "40px", color: "var(--ink-muted)" }}>No sessions match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="list-pagination">
            {page > 1 ? (
              <a className="btn" href={link({ page: String(page - 1) })}>← 上一页</a>
            ) : (
              <span className="btn btn-disabled">← 上一页</span>
            )}
            <span className="page-info">第 {page} / {totalPages} 页 · 共 {total.toLocaleString()} 条</span>
            {page < totalPages ? (
              <a className="btn" href={link({ page: String(page + 1) })}>下一页 →</a>
            ) : (
              <span className="btn btn-disabled">下一页 →</span>
            )}
          </div>
        )}
      </main>
    </>
  );
}
