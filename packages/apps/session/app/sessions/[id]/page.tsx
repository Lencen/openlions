import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import Topbar from "../../components/Topbar";

export const dynamic = "force-dynamic";

const MIND_ENDPOINT = process.env.MIND_ENDPOINT || "http://[internal-ip]:3000";

interface MsgRow {
  id: string;
  role: string;
  content: string | null;
  timestamp: Date;
  toolName: string | null;
  toolCalls: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  tokenCount: number | null;
  reasoning: string | null;
}

function MessageBubble({ msg }: { msg: MsgRow }) {
  // 2026-08-31: openclaw 的 toolResult 角色识别为 tool; 系统注入消息折叠显示
  const role = msg.role === "user" ? "user"
    : msg.role === "assistant" ? "assistant"
    : msg.role === "tool" || msg.role === "toolResult" ? "tool"
    : msg.role === "system" ? "system"
    : "system";

  const fmt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", 
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(msg.timestamp);

  const content = msg.content || "";
  const long = content.length > 1500;
  const roleLabel = role === "user" ? "User"
    : role === "assistant" ? "Assistant"
    : role === "tool" ? `Tool · ${msg.toolName || (msg.role === "toolResult" ? "result" : "")}`
    : "System";

  return (
    <div className={`msg-row msg-row--${role}`}>
      <div className="msg-row__inner">
        <div className="msg-row__meta">
          <span className="msg-row__role">{roleLabel}</span>
          <span className="msg-row__time">{fmt}</span>
          {msg.tokenCount ? <span className="msg-row__tok">{msg.tokenCount} tok</span> : null}
        </div>
        <div className="msg-row__bubble">
          {role === "tool" ? (
            <details>
              <summary className="msg-row__summary">{msg.toolName || "tool"} · input / output</summary>
              {msg.toolInput && (
                <div className="msg-row__block">
                  <div className="msg-row__block-label">Input</div>
                  <pre className="msg-row__pre">{msg.toolInput.slice(0, 4000)}{msg.toolInput.length > 4000 ? "\n…(truncated)" : ""}</pre>
                </div>
              )}
              {msg.toolOutput && (
                <div className="msg-row__block">
                  <div className="msg-row__block-label">Output</div>
                  <pre className="msg-row__pre">{msg.toolOutput.slice(0, 4000)}{msg.toolOutput.length > 4000 ? "\n…(truncated)" : ""}</pre>
                </div>
              )}
              {msg.content && <div className="msg-row__text">{msg.content.slice(0, 4000)}</div>}
            </details>
          ) : (
            <>
              {role === "system" ? (
                <details>
                  <summary className="msg-row__summary">
                    系统消息 · {content.slice(0, 80) || "[空]"}
                  </summary>
                  <div className="msg-row__text">{content}</div>
                </details>
              ) : long ? (
                <details open>
                  <summary className="msg-row__summary">长消息 ({content.length} 字符) — 折叠</summary>
                  <div className="msg-row__text">{content}</div>
                </details>
              ) : (
                <div className="msg-row__text">{content || <span className="muted">[空]</span>}</div>
              )}
              {msg.toolCalls && (
                <details className="msg-row__sub">
                  <summary className="msg-row__summary">tool_calls</summary>
                  <pre className="msg-row__pre">{msg.toolCalls.slice(0, 2000)}</pre>
                </details>
              )}
              {msg.reasoning && (
                <details className="msg-row__sub">
                  <summary className="msg-row__summary">reasoning</summary>
                  <pre className="msg-row__pre">{msg.reasoning.slice(0, 2000)}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default async function SessionDetailPage({ params }: { params: { id: string } }) {
  const session = await prisma.session.findUnique({
    where: { id: params.id },
    include: {
      messages: {
        orderBy: { timestamp: "asc" },
        take: 500,
      },
    },
  });

  if (!session) notFound();

  const fmt = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", 
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(d)
      : "—";

  const mindHref = session.sessionUid
    ? `${MIND_ENDPOINT}/session-registry?agent=${session.agentId || ""}`
    : null;

  return (
    <>
      <Topbar active="sessions" stats={`${session.messageCount} messages`} />
      <main className="page page--detail">
        <div className="detail-head">
          <div className="eyebrow"><a href="/sessions" className="muted-link">← Sessions</a></div>
          <h1 className="title-sm">{session.title || "Untitled Session"}</h1>

          <div className="detail-head__tags">
            {session.agentId && (
              <span className={`tag tag--agent tag--${session.agentId}`}>
                {session.agentId.replace("agent-","")} · {session.agentName || ""}
              </span>
            )}
            {session.source && <span className="tag tag--src">{session.source}</span>}
            {session.channel && <span className="tag tag--src">{session.channel}</span>}
            {session.model && <span className="tag tag--model">{session.model}</span>}
            <span className={`tag tag--st tag--st-${(session.extractStatus || "none").toLowerCase()}`}>
              {session.extractStatus || "NONE"}
            </span>
            <span className="detail-head__meta">{session.messageCount} msgs</span>
            <span className="detail-head__meta">Started {fmt(session.startedAt)}</span>
            <span className="detail-head__meta">Last {fmt(session.lastMessageAt)}</span>
            {mindHref && (
              <a href={mindHref} target="_blank" rel="noreferrer" className="detail-head__mind">
                Open in mind →
              </a>
            )}
          </div>

          <div className="detail-head__uid">{session.sessionUid || session.id}</div>

          {session.summary && (
            <div className="detail-head__summary">
              <span className="detail-head__summary-label">Summary</span>
              <span>{session.summary}</span>
            </div>
          )}
        </div>

        {session.messages.length === 0 ? (
          <div className="detail-empty">
            <div>No raw messages stored locally</div>
            <div className="muted">{session.extractStatus ? "Awaiting mind sync or remote agent push" : ""}</div>
          </div>
        ) : (
          <div className="detail-thread">
            {session.messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg as unknown as MsgRow} />
            ))}
            {session.messageCount > session.messages.length && (
              <div className="detail-thread__more">
                {session.messageCount} total · showing first {session.messages.length}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}
