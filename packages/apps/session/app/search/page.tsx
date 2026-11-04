import { prisma } from "@/lib/prisma";
import { SESSION_EXCLUDE_FILTER } from "@/lib/session-filters";
// D-01: snippet 安全转义 (独立模块可单测)
import { escapeSnippet } from "@/lib/snippet";
import Topbar from "../components/Topbar";

type Hit = {
  sessionId: string;
  title: string | null;
  platform: string | null;
  messageCount: number;
  lastMessageAt: Date | null;
  hits: number;
  snippet: string;
  // 2026-10-08 round 54: 工具调用命中(独立索引 message_fts_tools) ——
  //   人类明确"工具调用也能搜"; 只在工具索引命中的会话必须**可见**(带片段与标记),
  //   否则会重演"点进去看不到命中位置"的老问题。
  toolHits: number;
  toolSnippet: string;
};

/**
 * 工具调用检索(独立索引): 与 content 索引同源维护(见 scripts/session-fts-tools-index.cjs 的触发器),
 * 只索引有工具数据的行。**合并规则**: 同一会话两处命中则合并计数, 片段各自保留 -> UI 分开展示。
 */
async function ftsSearchTools(q: string, platform?: string, from?: string, to?: string): Promise<Map<string, { toolHits: number; toolSnippet: string; title: string | null; platform: string | null; messageCount: number; lastMessageAt: Date | null }>> {
  const out = new Map<string, { toolHits: number; toolSnippet: string; title: string | null; platform: string | null; messageCount: number; lastMessageAt: Date | null }>();
  if (q.length < 3) return out;
  const phrase = q.replace(/"/g, '""');
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT s.id, s.title, s.platform, s.messageCount, s.lastMessageAt,
             COUNT(*) AS toolHits,
             (SELECT snippet(message_fts_tools, 1, '<mark>', '</mark>', '…', 12)
              FROM message_fts_tools
              JOIN Message m2 ON m2.rowid = message_fts_tools.rowid
              WHERE message_fts_tools MATCH ? AND m2.sessionId = s.id
              LIMIT 1) AS toolSnippet
      FROM message_fts_tools
      JOIN Message m ON m.rowid = message_fts_tools.rowid
      JOIN Session s ON s.id = m.sessionId
      WHERE message_fts_tools MATCH ?
        ${platform ? "AND s.platform = ?" : ""}
        ${from ? "AND s.lastMessageAt >= ?" : ""}
        ${to ? "AND s.lastMessageAt <= ?" : ""}
      GROUP BY s.id
      HAVING s.messageCount > 0 AND s.sourceId NOT LIKE 'cron:%'
      ORDER BY toolHits DESC, s.lastMessageAt DESC
      LIMIT 50
      `,
      ...[`"${phrase}"`, `"${phrase}"`, ...(platform ? [platform] : []), ...(from ? [from] : []), ...(to ? [to] : [])]
    );
    for (const r of rows) {
      out.set(r.id, { toolHits: Number(r.toolHits), toolSnippet: r.toolSnippet || "", title: r.title, platform: r.platform, messageCount: r.messageCount, lastMessageAt: r.lastMessageAt });
    }
  } catch (e) {
    // 工具索引缺失/损坏时**降级**为"只按内容搜", 不让整页 500
    console.warn("[search] 工具索引查询失败, 降级为仅内容检索: " + (e as Error).message);
  }
  return out;
}

async function ftsSearch(q: string, platform?: string, from?: string, to?: string): Promise<Hit[]> {
  // trigram 需要 ≥3 字符; 短词退化为 LIKE
  const useFts = q.length >= 3;
  if (useFts) {
    // FTS5 phrase 查询: 双引号包裹避免分词器把 token 拆开
    const phrase = q.replace(/"/g, '""');
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT s.id, s.title, s.platform, s.messageCount, s.lastMessageAt,
             COUNT(*) AS hits,
             (SELECT snippet(message_fts, 0, '<mark>', '</mark>', '…', 16)
              FROM message_fts
              JOIN Message m2 ON m2.rowid = message_fts.rowid
              WHERE message_fts MATCH ? AND m2.sessionId = s.id
              LIMIT 1) AS snippet
      FROM message_fts
      JOIN Message m ON m.rowid = message_fts.rowid
      JOIN Session s ON s.id = m.sessionId
      WHERE message_fts MATCH ?
        ${platform ? "AND s.platform = ?" : ""}
        ${from ? "AND s.lastMessageAt >= ?" : ""}
        ${to ? "AND s.lastMessageAt <= ?" : ""}
      GROUP BY s.id
      HAVING s.messageCount > 0  -- 2026-09-02: 过滤 0-消息会话
        AND s.sourceId NOT LIKE 'cron:%'  -- 过滤定时任务触发
      ORDER BY hits DESC, s.lastMessageAt DESC
      LIMIT 50
      `,
      ...[`"${phrase}"`, `"${phrase}"`, ...(platform ? [platform] : []),
          ...(from ? [from] : []), ...(to ? [to] : [])]
    );
    const contentHits: Hit[] = rows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      platform: r.platform,
      messageCount: r.messageCount,
      lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt) : null,
      hits: Number(r.hits),
      snippet: r.snippet || "",
      toolHits: 0,
      toolSnippet: "",
    }));
    // 合并工具索引结果: 已存在的补字段; 只在工具里命中的会话**新增一行**(带工具片段与标记)
    const toolHits = await ftsSearchTools(q, platform, from, to);
    const seen = new Set(contentHits.map((h) => h.sessionId));
    for (const h of contentHits) {
      const t = toolHits.get(h.sessionId);
      if (t) { h.toolHits = t.toolHits; h.toolSnippet = t.toolSnippet; }
    }
    const toolOnly: Hit[] = [...toolHits.entries()]
      .filter(([id]) => !seen.has(id))
      .map(([id, t]) => ({
        sessionId: id,
        title: t.title,
        platform: t.platform,
        messageCount: t.messageCount,
        lastMessageAt: t.lastMessageAt ? new Date(t.lastMessageAt) : null,
        hits: 0,
        snippet: "",
        toolHits: t.toolHits,
        toolSnippet: t.toolSnippet,
      }));
    return [...contentHits, ...toolOnly].slice(0, 50);
  }

  // 短词 LIKE 回退 (仅搜 title)
  const sessions = await prisma.session.findMany({
    where: {
      ...(platform ? { platform } : {}),
      title: { contains: q },
      ...SESSION_EXCLUDE_FILTER,
    },
    // 2026-09-01: 按更新时间倒序 (规范) — lastMessageAt 有 NULL 沉底问题
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 50,
  });
  return sessions.map((s) => ({
    sessionId: s.id,
    title: s.title,
    platform: s.platform,
    messageCount: s.messageCount,
    lastMessageAt: s.lastMessageAt,
    hits: 0,
    snippet: "",
    toolHits: 0, // 短词(<3 字符)走 title LIKE, 不进 FTS 两索引
    toolSnippet: "",
  }));
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string; platform?: string; from?: string; to?: string };
}) {
  const q = (searchParams.q || "").trim();
  const platform = searchParams.platform;
  const from = searchParams.from;
  const to = searchParams.to;

  let hits: Hit[] = [];
  let mode: "fts" | "like" | "none" = "none";
  if (q) {
    hits = await ftsSearch(q, platform, from, to);
    mode = q.length >= 3 ? "fts" : "like";
  }

  const formatDate = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d)
      : "—";

const platformLabels: Record<string, string> = {
    feishu: "飞书", dingtalk: "钉钉", telegram: "TG", discord: "Discord",
    cli: "CLI", web: "Web", hermes_session: "Hermes",
  };

  return (
    <>
      <Topbar active="search" stats={q ? `${hits.length} results` : ""} />
      <main className="page page--narrow">
        <div className="eyebrow">Full-text search · FTS5</div>
        <h1 className="title-sm">Find a <em>session</em>.</h1>

        <form className="search-form">
          <input
            name="q"
            defaultValue={q}
            placeholder="搜索消息内容、工具调用、标题... (≥3 字符走 FTS5)"
            className="search-form__input"
          />
          <select name="platform" defaultValue={platform || ""} className="search-form__select">
            <option value="">All platforms</option>
            <option value="hermes_session">Hermes</option>
            <option value="feishu">飞书</option>
            <option value="dingtalk">钉钉</option>
            <option value="telegram">Telegram</option>
            <option value="discord">Discord</option>
          </select>
          <button type="submit" className="search-form__submit">Search</button>
        </form>

        {q && (
          <div className="search-meta">
            {hits.length} results for &ldquo;{q}&rdquo;
            {mode === "fts" && <span className="tag tag--src" style={{ marginLeft: 8 }}>FTS5</span>}
            {mode === "like" && <span className="tag tag--src" style={{ marginLeft: 8 }}>title LIKE (短词)</span>}
          </div>
        )}

        <div className="search-results">
          {hits.map((h) => (
            <a key={h.sessionId} href={`/sessions/${h.sessionId}`} className="search-card">
              <div className="search-card__head">
                <span className="tag tag--src">{platformLabels[h.platform || ""] || h.platform || "—"}</span>
                <span className="search-card__title">{h.title || "Untitled"}</span>
                {h.hits > 0 && <span className="tag" style={{ marginLeft: "auto" }}>{h.hits} hits</span>}
                {h.toolHits > 0 && (
                  <span className="tag" style={{ marginLeft: h.hits > 0 ? 4 : "auto" }} title="命中位置在工具调用参数里(独立索引 message_fts_tools)">
                    {h.toolHits} tool calls
                  </span>
                )}
              </div>
              {h.snippet && (
                <div
                  className="search-card__snippet"
                  // D-01: 先转义防 XSS, 再还原 <mark> 高亮 (见 escapeSnippet)
                  dangerouslySetInnerHTML={{ __html: escapeSnippet(h.snippet) }}
                />
              )}
              {/* 工具调用命中: 显示工具片段 —— 保证"看得见命中位置"(2026-10-08 round 54) */}
              {h.toolHits > 0 && h.toolSnippet && (
                <div
                  className="search-card__snippet"
                  style={{ opacity: 0.85 }}
                  dangerouslySetInnerHTML={{ __html: escapeSnippet(h.toolSnippet) }}
                />
              )}
              <div className="search-card__meta">
                {h.messageCount} msgs · {formatDate(h.lastMessageAt)}
                {h.toolHits > 0 && !h.snippet && <span> · 命中在工具调用(内容无匹配)</span>}
              </div>
            </a>
          ))}

          {q && hits.length === 0 && (
            <div className="search-empty">No results found</div>
          )}

          {!q && (
            <div className="search-empty">Enter a search term to find sessions</div>
          )}
        </div>
      </main>
    </>
  );
}
