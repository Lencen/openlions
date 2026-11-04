"use client";
// 2026-10-22 会话线（Session Principal）三查询：**已接真接口**（console BFF 代理，服务端持 token）。
//   接口不可用时回退骨架数据，并在标题旁明确标注原因（不静默归零）。
import { useEffect, useState } from "react";
import { PageHero } from "@/components/ui";
import { useApi } from "@/lib/api";
import { MOCK_CONVERSATIONS, MOCK_OVERVIEW, MOCK_SYNC } from "../_contract/mock";
import type { SessionConversationsResponse, SessionsOverviewResponse, SyncResponse } from "../_contract/session";

const TONE: Record<string, string> = {
  delivered: "var(--status-ok)", read: "var(--status-ok)", replied: "var(--status-ok)",
  pending: "var(--status-warn)", queued: "var(--status-warn)", brain_timeout: "var(--status-crit)",
  failed: "var(--status-crit)", expired: "var(--status-crit)", rate_limited: "var(--status-warn)",
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

// 2026-10-22 五态统一（目标⑤）：把散落的 delivery_status 字符串收敛成同一套语义 chip。
//   未读 = 已送达但没读；已读 = 读了；送达 = 送达未读；处理中 = 模型侧处理；陈旧 = 心跳过期(stale)。
const STATE_LABEL: Record<string, string> = {
  unread: "未读", read: "已读", delivered: "送达", processing: "处理中", stale: "陈旧",
  pending: "传输中", failed: "未送达", expired: "已过期", queued: "排队",
};
function stateOf(delivery?: string | null, processing?: string | null): string {
  const d = String(delivery || "").toLowerCase();
  const pr = String(processing || "").toLowerCase();
  if (pr === "processing") return "processing";
  if (d === "read") return "read";
  if (d === "delivered") return "delivered";
  if (d === "pending" || d === "queued") return "pending";
  if (d === "failed" || d === "expired") return "failed";
  return d || "unknown";
}
const StateChip = ({ state, title }: { state: string; title?: string }) => (
  <span className={"msg-state s-" + state} title={title || STATE_LABEL[state] || state}>
    {STATE_LABEL[state] || state || "—"}
  </span>
);
// 2026-10-22 stale 原因翻译：接口给的是机器码（heartbeat_older_than_120s），表格里直接显示没人看得懂
const STALE_REASON: Record<string, string> = {
  heartbeat_older_than_120s: "心跳超过 120s 未更新",
  heartbeat_older_than_60s: "心跳超过 60s 未更新",
  no_heartbeat: "从未上报心跳",
  session_closed: "会话已关闭",
};
const staleText = (raw?: string | null) => (raw ? STALE_REASON[raw] || raw : "—");

const STATE_LEGEND: Array<{ s: string; hint: string }> = [
  { s: "unread", hint: "已送达但本线还没读" },
  { s: "read", hint: "已确认读取" },
  { s: "delivered", hint: "已送达对端" },
  { s: "processing", hint: "模型侧正在处理" },
  { s: "stale", hint: "心跳超过阈值，状态可能滞后" },
];

export default function SessionPage() {
  const { data: inbox } = useApi<any>("/api/macs/session-inbox");
  const { data: convData } = useApi<any>("/api/macs/session/conversations?limit=20", { pollMs: 30000 });
  const { data: ovData } = useApi<any>("/api/macs/session/overview?limit=50", { pollMs: 30000 });
  // 2026-10-22：后端的回信几乎都是 agent 级（无 target_session_id），session inbox/wake 看不到，
  //   这里直接读同 agent 会话最近消息，补上"主动读"的可见性缺口。
  const { data: agentLevel } = useApi<any>("/api/macs/session/agent-level?limit=8", { pollMs: 30000 });
  const [sync, setSync] = useState<SyncResponse | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);

  const convs: SessionConversationsResponse["conversations"] = convData?.ok ? convData.conversations || [] : MOCK_CONVERSATIONS.conversations;
  const overview = ovData?.ok ? ovData.sessions || [] : MOCK_OVERVIEW.sessions;
  const convReal = !!convData?.ok;
  const ovReal = !!ovData?.ok;

  // 同步历史：选第一条真实会话（没有就退骨架）
  const firstCid: string | null = convReal && convs.length ? convs[0].conversation_id : null;
  useEffect(() => {
    if (!firstCid) { setSync(null); setSyncErr(null); return; }
    let cancelled = false;
    fetch("/api/macs/session/sync?conversation_id=" + encodeURIComponent(firstCid) + "&limit=50")
      .then((r) => r.json())
      .then((j) => { if (cancelled) return; if (j?.ok) { setSync(j); setSyncErr(null); } else { setSync(null); setSyncErr(j?.error || "接口不可用"); } })
      .catch((e) => { if (!cancelled) { setSync(null); setSyncErr(String(e?.message || e)); } });
    return () => { cancelled = true; };
  }, [firstCid]);

  const syncRows = sync?.messages?.length ? sync.messages : MOCK_SYNC.messages;
  const syncReal = !!sync?.messages?.length;
  const badge = (real: boolean, why?: string | null) => (
    <span className="msg-tag" title={real ? "真实接口" : (why || "骨架数据")}>{real ? "真实" : "骨架"}</span>
  );

  return (
    <main className="page">
      <PageHero title="会话线" subtitle="同一智能体的多条并行会话：谁在线、有什么没确认、消息在哪条线上。" />

      {/* 2026-10-22 五态图例：让「未读/已读/送达/处理中/陈旧」一眼可辨，颜色与语义一一对应 */}
      <div className="msg-legend" role="note" aria-label="状态图例">
        <span className="msg-legend-title">状态</span>
        {STATE_LEGEND.map((l) => (
          <span key={l.s} className="msg-legend-item" title={l.hint}>
            <StateChip state={l.s} />
            <span className="msg-legend-hint">{l.hint}</span>
          </span>
        ))}
      </div>

      <div className="metric-row">
        <div className="metric-card">
          <div className="m-label">本线未确认读取</div>
          <div className="m-value">{inbox?.count ?? "—"}</div>
          <div className="tiny">watcher 镜像 · {fmt(inbox?.asOf)}</div>
        </div>
        <div className="metric-card">
          <div className="m-label">传输层待处理</div>
          <div className="m-value" style={{ color: (inbox?.pendingDelivery ?? 0) > 0 ? "var(--status-crit)" : undefined }}>{inbox?.pendingDelivery ?? "—"}</div>
          <div className="tiny">SLO 看这个口径</div>
        </div>
        <div className="metric-card">
          <div className="m-label">在线会话线 {badge(ovReal)}</div>
          <div className="m-value">{overview.filter((s) => s.online).length} / {overview.length}</div>
          <div className="tiny">
            {overview.filter((s) => s.stale).length} 条
            {overview.some((s) => s.stale) ? <> <StateChip state="stale" title="心跳过期，在线状态可能滞后" /></> : null}
          </div>
        </div>
        <div className="metric-card">
          <div className="m-label">实时通道</div>
          <div className="m-value">{inbox?.wake ? (inbox.wake.ok === false ? "异常" : "长轮询") : "—"}</div>
          <div className="tiny">
            {inbox?.wake?.last_wake_at ? "上次唤醒 " + fmt(inbox.wake.last_wake_at) : "watcher 未上报"}
            {inbox?.wake?.latest_seq ? " · seq " + inbox.wake.latest_seq : ""}
            <div>只做镜像与未读信号，不启动模型会话</div>
          </div>
        </div>
      </div>

      {inbox?.items?.length ? (
        <div className="panel" style={{ padding: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
          <div className="msg-col-title" style={{ marginBottom: "var(--sp-2)" }}>本线未确认消息（真实 · watcher 镜像）</div>
          {/* 2026-10-22 a11y：可滚动列表必须能键盘聚焦（axe: scrollable-region-focusable） */}
          <ul className="msg-stream" style={{ maxHeight: 180 }} tabIndex={0}>
            {inbox.items.map((m: any) => (
              <li key={m.message_id} className="tiny">
                <span className="td-mono">{m.message_id}</span> · <StateChip state={stateOf(m.delivery_status, m.processing_state)} /> · {(m.text || "").slice(0, 70)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="panel" style={{ padding: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
        <div className="msg-col-title" style={{ marginBottom: "var(--sp-2)" }}>
          同智能体会话最近消息 {badge(!!agentLevel?.ok, agentLevel?.error)}
          <span className="msg-tag">未定向到本线</span>
        </div>
        {agentLevel?.messages?.length ? (
          <ul className="msg-stream" style={{ maxHeight: 200 }} tabIndex={0}>
            {agentLevel.messages.map((m: any) => (
              <li key={m.message_id} className="tiny">
                <span className="td-mono">{fmt(m.created_at)}</span> · {m.sender_id} · {m.delivery_status} · {(m.text || "").slice(0, 90)}
              </li>
            ))}
          </ul>
        ) : (
          <div className="msg-empty">暂无（或接口不可用）</div>
        )}
      </div>

      <div className="panel" style={{ padding: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
        <div className="msg-col-title" style={{ marginBottom: "var(--sp-2)" }}>a) 按线的会话列表 {badge(convReal, convData?.error)}</div>
        <table className="tbl">
          <thead><tr><th>会话</th><th>参与者</th><th>最后消息</th><th>两态</th><th>未读/提及</th><th>待处理</th><th>认领</th></tr></thead>
          <tbody>
            {convs.map((c) => (
              <tr key={c.conversation_id}>
                <td className="td-mono">{c.conversation_id}</td>
                <td>{c.participant_display.join(" ↔ ")}</td>
                <td className="td-clip" title={c.last_message?.text || ""}>{c.last_message?.text || "—"}</td>
                <td>
                  <span className="msg-pill" style={{ color: TONE[c.last_message?.transport_status || "queued"] }}>{c.last_message?.transport_status || "—"}</span>{" "}
                  <span className="msg-pill">{c.last_message?.processing_state || "—"}</span>
                </td>
                <td>{c.unread_count} / {c.mention_count}</td>
                <td>{(c as any).pending_count ?? "—"}</td>
                <td className="td-mono">{c.claim ? c.claim.session_id : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ padding: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
        <div className="msg-col-title" style={{ marginBottom: "var(--sp-2)" }}>
          b) 会话同步历史 {badge(syncReal, syncErr)}
          {firstCid ? <span className="msg-tag">{firstCid}</span> : null}
        </div>
        <table className="tbl">
          <thead><tr><th>时间</th><th>方向</th><th>消息</th><th>两态</th><th>引用/客户端</th><th>事件</th></tr></thead>
          <tbody>
            {syncRows.map((m) => (
              <tr key={m.message_id}>
                <td className="td-mono">{fmt(m.created_at)}</td>
                <td>{m.direction === "in" ? "入" : "出"}</td>
                <td className="td-clip" title={m.text}>{m.text}</td>
                <td>
                  <span className="msg-pill" style={{ color: TONE[m.transport_status] }}>{m.transport_status}</span>{" "}
                  <span className="msg-pill">{m.processing_state}</span>
                </td>
                <td className="td-mono">{m.reply_to_id ? "有引用" : "—"} / {m.client_message_id ? "有" : "—"}</td>
                <td className="td-mono">{(m.events || []).map((e) => e.event_type + (e.actor ? "(" + e.actor + ")" : "")).join(" → ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ padding: "var(--sp-3)" }}>
        <div className="msg-col-title" style={{ marginBottom: "var(--sp-2)" }}>c) 跨线聚合 {badge(ovReal, ovData?.error)}</div>
        <table className="tbl">
          <thead><tr><th>会话线</th><th>在线</th><th>心跳</th><th>待处理</th><th>最老待处理</th><th>stale 原因</th></tr></thead>
          <tbody>
            {overview.map((s) => (
              <tr key={s.session_id}>
                <td>{s.label}<div className="tiny td-mono">{s.session_id}</div></td>
                <td>
                  {s.online ? "在线" : "离线"}
                  {s.stale ? <> <StateChip state="stale" title={staleText(s.stale_reason)} /></> : null}
                </td>
                <td className="td-mono">{fmt(s.last_heartbeat_at)}</td>
                <td>{s.pending_count}</td>
                <td className="td-mono">{fmt(s.oldest_pending_at)}</td>
                <td title={s.stale_reason || ""}>{staleText(s.stale_reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
