import { prisma } from "@/lib/prisma";
import Topbar from "../../components/Topbar";
import Link from "next/link";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  PENDING: "badge-pending",
  PROCESSING: "badge-pending",
  DONE: "badge-ok",
  FAILED: "badge-fail",
};

const MSG_LIMIT = 100;

interface MsgRow {
  id: string;
  role: string;
  content: string | null;
  timestamp: Date;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  tokenCount: number | null;
}

function MessageBubble({ msg, sessionTitle, sessionSeq }: { msg: MsgRow; sessionTitle: string; sessionSeq: number }) {
  const content = msg.content || "";

  // 检测框架注入的伪 user 消息 (非用户真实输入)
  const isFrameworkInjection =
    msg.role === "user" && (
      content.startsWith("[CONTEXT COMPACTION") ||
      content.startsWith("You just executed tool calls") ||
      content.startsWith("<!-- [PERSONA]") ||
      content.startsWith("<!-- [SHARED]") ||
      content.startsWith("<!-- [LOCAL]") ||
      content.startsWith("Conversation started:")
    );

  const role = isFrameworkInjection ? "system"
    : msg.role === "user" ? "user"
    : msg.role === "assistant" ? "assistant"
    : msg.role === "tool" ? "tool" : "system";

  const fmt = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(msg.timestamp));

  const isEmpty = content.length === 0;
  const isLong = content.length > 500;
  const roleLabel = role === "user" ? "User"
    : role === "assistant" ? "Assistant"
    : role === "tool" ? `Tool · ${msg.toolName || ""}` : "System";

  return (
    <div className={`msg-row msg-row--${role}`}>
      <div className="msg-row__inner">
        <div className="msg-row__meta">
          <span className="msg-row__role">{roleLabel}</span>
          <span className="msg-row__time">{fmt}</span>
          <span className="msg-row__sess">S{sessionSeq}: {sessionTitle?.slice(0, 30) || "—"}</span>
          {msg.tokenCount ? <span className="msg-row__tok">{msg.tokenCount} tok</span> : null}
        </div>
        <div className="msg-row__bubble">
          {role === "tool" ? (
            <details>
              <summary className="msg-row__summary">{msg.toolName || "tool"} · I/O</summary>
              {msg.toolInput && (
                <div className="msg-row__block">
                  <div className="msg-row__block-label">Input</div>
                  <pre className="msg-row__pre">{msg.toolInput.slice(0, 2000)}{msg.toolInput.length > 2000 ? "…" : ""}</pre>
                </div>
              )}
              {msg.toolOutput && (
                <div className="msg-row__block">
                  <div className="msg-row__block-label">Output</div>
                  <pre className="msg-row__pre">{msg.toolOutput.slice(0, 2000)}{msg.toolOutput.length > 2000 ? "…" : ""}</pre>
                </div>
              )}
            </details>
          ) : isEmpty ? (
            <span className="msg-row__text" style={{ opacity: .4, fontStyle: "italic" }}>(empty)</span>
          ) : isLong ? (
            <details>
              <summary className="msg-row__summary">{content.slice(0, 80)}… ({content.length} 字符, 点击展开)</summary>
              <div className="msg-row__text">{content}</div>
            </details>
          ) : (
            <div className="msg-row__text">{content}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default async function GroupDetailPage({
  params,
  searchParams,
}: {
  params: { groupKey: string };
  searchParams: { view?: string; offset?: string };
}) {
  const groupKey = decodeURIComponent(params.groupKey);
  const view = searchParams.view || "sessions";
  const offset = Math.max(0, parseInt(searchParams.offset || "0", 10) || 0);

  const group = await prisma.sessionGroup.findUnique({
    where: { groupKey },
    include: {
      members: {
        orderBy: { seq: "asc" },
        select: {
          seq: true,
          session: {
            select: {
              id: true, sessionUid: true, title: true, agentId: true, source: true,
              startedAt: true, lastMessageAt: true, messageCount: true, extractStatus: true,
            },
          },
        },
      },
    },
  });

  if (!group) {
    return (
      <>
        <Topbar active="groups" />
        <main className="page">
          <h1 className="title">Group not found</h1>
          <Link href="/groups" style={{ color: "var(--accent-primary)" }}>← Back to Groups</Link>
        </main>
      </>
    );
  }

  const msgPerSession = group.sessionCount > 0 ? Math.round(group.messageCount / group.sessionCount) : 0;

  // Messages view: fetch cross-session ordered messages with offset pagination
  // prefer-const: 两个变量都只在声明处赋值一次(其余是 push/读取), 改成 const 语义不变
  const messages: Array<MsgRow & { _sessionSeq: number; _sessionTitle: string }> = [];
  const msgTotal = group.messageCount;

  if (view === "messages") {
    const sessionSeqMap = new Map<string, { seq: number; title: string }>();
    for (const m of group.members) {
      sessionSeqMap.set(m.session.id, { seq: m.seq, title: m.session.title || "" });
    }

    let skipped = 0;
    let done = false;
    for (const m of group.members) {
      if (done) break;
      const sessMsgCount = m.session.messageCount || 0;
      if (skipped + sessMsgCount <= offset) {
        skipped += sessMsgCount;
        continue;
      }
      const skipInSession = Math.max(0, offset - skipped);
      const need = MSG_LIMIT - messages.length;
      if (need <= 0) { done = true; break; }
      const msgs = await prisma.message.findMany({
        where: { sessionId: m.session.id },
        orderBy: { timestamp: "asc" },
        skip: skipInSession,
        take: need,
        select: {
          id: true, role: true, content: true, timestamp: true,
          toolName: true, toolInput: true, toolOutput: true, tokenCount: true,
        },
      });
      const info = sessionSeqMap.get(m.session.id)!;
      for (const msg of msgs) {
        messages.push({ ...msg, _sessionSeq: info.seq, _sessionTitle: info.title });
      }
      skipped += sessMsgCount;
      if (messages.length >= MSG_LIMIT) done = true;
    }
  }

  const encKey = encodeURIComponent(group.groupKey);
  const totalPages = Math.ceil(msgTotal / MSG_LIMIT);
  const curPage = Math.floor(offset / MSG_LIMIT) + 1;

  return (
    <>
      <Topbar active="groups" />
      <main className="page page-wide">
        {/* Breadcrumb */}
        <div style={{ marginBottom: "var(--space-3)" }}>
          <Link href="/groups" style={{ fontSize: "13px", color: "var(--ink-muted)" }}>← Groups</Link>
        </div>

        {/* Group header */}
        <div className="group-header">
          <h1>{group.titleBase || group.groupKey}</h1>
          {group.titleBase && group.titleBase !== group.groupKey && (
            <div className="meta">groupKey: {group.groupKey}</div>
          )}
          <div className="stats-row">
            <span className="stat"><span className="num">{group.sessionCount}</span> sessions</span>
            <span className="stat"><span className="num">{group.messageCount.toLocaleString()}</span> messages</span>
            <span className="stat">avg <span className="num">{msgPerSession}</span> msg/session</span>
            <span className="stat">
              {group.firstMessageAt ? new Date(group.firstMessageAt).toLocaleDateString("zh-CN") : "?"}
              {" ~ "}
              {group.lastMessageAt ? new Date(group.lastMessageAt).toLocaleDateString("zh-CN") : "?"}
            </span>
            <span className={`badge ${STATUS_BADGE[group.extractStatus || "PENDING"]}`}>
              <span className="pip" />
              {group.extractStatus || "PENDING"}
            </span>
          </div>
          {group.agentType && <div className="meta">agentType: {group.agentType}</div>}
          {group.workdir && <div className="meta">workdir: {group.workdir}</div>}
        </div>

        {/* Tab bar */}
        <div className="tab-bar">
          <Link href={`/groups/${encKey}`} className={`tab ${view === "sessions" ? "active" : ""}`}>
            Sessions ({group.members.length})
          </Link>
          <Link href={`/groups/${encKey}?view=messages`} className={`tab ${view === "messages" ? "active" : ""}`}>
            Aggregated Messages
          </Link>
        </div>

        {/* Sessions tab */}
        {view === "sessions" && (
          <div className="table-wrap">
            <table className="session-table">
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>Session</th>
                  <th>Agent</th>
                  <th>Source</th>
                  <th>Msgs</th>
                  <th>Started</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {group.members.map((m) => (
                  <tr key={m.session.id}>
                    <td className="num">{m.seq}</td>
                    <td>
                      <Link href={`/sessions/${m.session.id}`} className="title">
                        {m.session.title || m.session.id.slice(0, 12)}
                      </Link>
                    </td>
                    <td>
                      <span className="agent-cell">
                        <span className="swatch" style={{ background: `var(--agent-${(m.session.agentId || "ut").replace("agent-", "")})` }} />
                        {(m.session.agentId || "—").replace("agent-", "")}
                      </span>
                    </td>
                    <td>{m.session.source || "—"}</td>
                    <td className="num">{m.session.messageCount || 0}</td>
                    <td className="time">
                      {m.session.startedAt ? new Date(m.session.startedAt).toLocaleDateString("zh-CN") : "—"}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[m.session.extractStatus || "PENDING"]}`}>
                        <span className="pip" />
                        {m.session.extractStatus || "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Messages tab */}
        {view === "messages" && (
          <div>
            {/* Top pagination */}
            {msgTotal > MSG_LIMIT && (
              <div className="msg-pagination msg-pagination--top">
                {offset > 0 ? (
                  <Link className="btn" href={`/groups/${encKey}?view=messages&offset=${Math.max(0, offset - MSG_LIMIT)}`}>← 上一页</Link>
                ) : (
                  <span className="btn btn-disabled">← 上一页</span>
                )}
                <span className="pagination-info">
                  {offset + 1}–{offset + messages.length} / {msgTotal.toLocaleString()} 条 · 第 {curPage} / {totalPages} 页
                </span>
                {offset + MSG_LIMIT < msgTotal ? (
                  <Link className="btn" href={`/groups/${encKey}?view=messages&offset=${offset + MSG_LIMIT}`}>下一页 →</Link>
                ) : (
                  <span className="btn btn-disabled">下一页 →</span>
                )}
              </div>
            )}
            {msgTotal <= MSG_LIMIT && (
              <div className="msg-pagination-info">{messages.length} messages</div>
            )}

            {/* Messages */}
            {messages.map((msg, i) => {
              const prev = i > 0 ? messages[i - 1] : null;
              const showDivider = !prev || prev._sessionSeq !== msg._sessionSeq;
              return (
                <div key={msg.id}>
                  {showDivider && (
                    <div className="session-divider">
                      <span className="session-divider__line" />
                      <span className="session-divider__label">
                        Session #{msg._sessionSeq}: {msg._sessionTitle || "—"}
                      </span>
                      <span className="session-divider__line" />
                    </div>
                  )}
                  <MessageBubble msg={msg} sessionTitle={msg._sessionTitle} sessionSeq={msg._sessionSeq} />
                </div>
              );
            })}
            {messages.length === 0 && (
              <div style={{ textAlign: "center", padding: "40px", color: "var(--ink-muted)" }}>No messages found.</div>
            )}

            {/* Bottom pagination */}
            {msgTotal > MSG_LIMIT && (
              <div className="msg-pagination">
                {offset > 0 ? (
                  <Link className="btn" href={`/groups/${encKey}?view=messages&offset=${Math.max(0, offset - MSG_LIMIT)}`}>← 上一页</Link>
                ) : (
                  <span className="btn btn-disabled">← 上一页</span>
                )}
                <span className="pagination-info">第 {curPage} / {totalPages} 页</span>
                {offset + MSG_LIMIT < msgTotal ? (
                  <Link className="btn" href={`/groups/${encKey}?view=messages&offset=${offset + MSG_LIMIT}`}>下一页 →</Link>
                ) : (
                  <span className="btn btn-disabled">下一页 →</span>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}
