"use client";
// 2026-10-22 会话线（Session Principal）三查询：**已接真接口**（console BFF 代理，服务端持 token）。
//   接口不可用时回退骨架数据，并在标题旁明确标注原因（不静默归零）。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 三张手写 .tbl 表 → 白名单 DataTable。
//   列/字段/文案一字未改；「两态」药丸的动态色从内联 TONE（var(--status-*)）改成 data-tone 属性选择器；
//   列表限高（maxHeight 180/200）走 .stream180 / .stream200 两档。
//   取数（session-inbox / conversations / overview / agent-level / sync）一字未改。
import { useEffect, useState } from "react";
import { PageHero } from "@/components/ui";
import { useApi } from "@/lib/api";
import { MOCK_CONVERSATIONS, MOCK_OVERVIEW, MOCK_SYNC } from "../_contract/mock";
import type { SessionConversationsResponse, SyncResponse } from "../_contract/session";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

// 传输态 → 语义档位（改前是 TONE: 状态 → var(--status-*)；这里只换表达，映射一一对应）
const TONE_LEVEL: Record<string, string> = {
  delivered: "ok", read: "ok", replied: "ok",
  pending: "warn", queued: "warn", brain_timeout: "crit",
  failed: "crit", expired: "crit", rate_limited: "warn",
};
const toneOf = (s?: string | null) => TONE_LEVEL[String(s || "").toLowerCase()];
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

/** 三张表的列定义（与改前 <thead> 逐列对应，顺序不变） */
const convColumns: DataColumn<any>[] = [
  { key: "cid", title: "会话", render: (c) => <span className={styles.monoCell}>{c.conversation_id}</span> },
  { key: "participants", title: "参与者", render: (c) => c.participant_display.join(" ↔ ") },
  { key: "last", title: "最后消息", render: (c) => <span title={c.last_message?.text || ""}>{c.last_message?.text || "—"}</span> },
  {
    key: "states",
    title: "两态",
    render: (c) => (
      <>
        <span className={"msg-pill " + styles.pillTone} data-tone={toneOf(c.last_message?.transport_status || "queued")}>
          {c.last_message?.transport_status || "—"}
        </span>{" "}
        <span className="msg-pill">{c.last_message?.processing_state || "—"}</span>
      </>
    ),
  },
  { key: "unread", title: "未读/提及", render: (c) => <>{c.unread_count} / {c.mention_count}</> },
  { key: "pending", title: "待处理", render: (c) => <>{(c as any).pending_count ?? "—"}</> },
  { key: "claim", title: "认领", render: (c) => <span className={styles.monoCell}>{c.claim ? c.claim.session_id : "—"}</span> },
];

const syncColumns: DataColumn<any>[] = [
  { key: "at", title: "时间", render: (m) => <span className={styles.monoCell}>{fmt(m.created_at)}</span> },
  { key: "dir", title: "方向", render: (m) => <>{m.direction === "in" ? "入" : "出"}</> },
  { key: "text", title: "消息", render: (m) => <span title={m.text}>{m.text}</span> },
  {
    key: "states",
    title: "两态",
    render: (m) => (
      <>
        <span className={"msg-pill " + styles.pillTone} data-tone={toneOf(m.transport_status)}>{m.transport_status}</span>{" "}
        <span className="msg-pill">{m.processing_state}</span>
      </>
    ),
  },
  {
    key: "refs",
    title: "引用/客户端",
    render: (m) => <span className={styles.monoCell}>{m.reply_to_id ? "有引用" : "—"} / {m.client_message_id ? "有" : "—"}</span>,
  },
  {
    key: "events",
    title: "事件",
    render: (m) => (
      <span className={styles.monoCell}>
        {(m.events || []).map((e: any) => e.event_type + (e.actor ? "(" + e.actor + ")" : "")).join(" → ")}
      </span>
    ),
  },
];

const overviewColumns: DataColumn<any>[] = [
  {
    key: "session",
    title: "会话线",
    render: (s) => <>{s.label}<div className={"tiny " + styles.monoCell}>{s.session_id}</div></>,
  },
  {
    key: "online",
    title: "在线",
    render: (s) => (
      <>
        {s.online ? "在线" : "离线"}
        {s.stale ? <> <StateChip state="stale" title={staleText(s.stale_reason)} /></> : null}
      </>
    ),
  },
  { key: "hb", title: "心跳", render: (s) => <span className={styles.monoCell}>{fmt(s.last_heartbeat_at)}</span> },
  { key: "pending", title: "待处理", render: (s) => <>{s.pending_count}</> },
  { key: "oldest", title: "最老待处理", render: (s) => <span className={styles.monoCell}>{fmt(s.oldest_pending_at)}</span> },
  { key: "stale", title: "stale 原因", render: (s) => <span title={s.stale_reason || ""}>{staleText(s.stale_reason)}</span> },
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
          <div className={"m-value " + styles.metricValue} data-tone={(inbox?.pendingDelivery ?? 0) > 0 ? "crit" : undefined}>{inbox?.pendingDelivery ?? "—"}</div>
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
        <div className={"panel " + styles.panelPad}>
          <div className={"msg-col-title " + styles.colTitle}>本线未确认消息（真实 · watcher 镜像）</div>
          {/* 2026-10-22 a11y：可滚动列表必须能键盘聚焦（axe: scrollable-region-focusable） */}
          <ul className={"msg-stream " + styles.stream180} tabIndex={0}>
            {inbox.items.map((m: any) => (
              <li key={m.message_id} className="tiny">
                <span className={styles.monoCell}>{m.message_id}</span> · <StateChip state={stateOf(m.delivery_status, m.processing_state)} /> · {(m.text || "").slice(0, 70)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={"panel " + styles.panelPad}>
        <div className={"msg-col-title " + styles.colTitle}>
          同智能体会话最近消息 {badge(!!agentLevel?.ok, agentLevel?.error)}
          <span className="msg-tag">未定向到本线</span>
        </div>
        {agentLevel?.messages?.length ? (
          <ul className={"msg-stream " + styles.stream200} tabIndex={0}>
            {agentLevel.messages.map((m: any) => (
              <li key={m.message_id} className="tiny">
                <span className={styles.monoCell}>{fmt(m.created_at)}</span> · {m.sender_id} · {m.delivery_status} · {(m.text || "").slice(0, 90)}
              </li>
            ))}
          </ul>
        ) : (
          <div className="msg-empty">暂无（或接口不可用）</div>
        )}
      </div>

      <div className={"panel " + styles.panelPad}>
        <div className={"msg-col-title " + styles.colTitle}>a) 按线的会话列表 {badge(convReal, convData?.error)}</div>
        <DataTable
          columns={convColumns}
          rows={convs}
          rowKey={(c: any, i: number) => c.conversation_id || i}
          empty={{ title: "—" }}
        />
      </div>

      <div className={"panel " + styles.panelPad}>
        <div className={"msg-col-title " + styles.colTitle}>
          b) 会话同步历史 {badge(syncReal, syncErr)}
          {firstCid ? <span className="msg-tag">{firstCid}</span> : null}
        </div>
        <DataTable
          columns={syncColumns}
          rows={syncRows}
          rowKey={(m: any, i: number) => m.message_id || i}
          empty={{ title: "—" }}
        />
      </div>

      <div className={"panel " + styles.panelPad}>
        <div className={"msg-col-title " + styles.colTitle}>c) 跨线聚合 {badge(ovReal, ovData?.error)}</div>
        <DataTable
          columns={overviewColumns}
          rows={overview}
          rowKey={(s: any, i: number) => s.session_id || i}
          empty={{ title: "—" }}
        />
      </div>
    </main>
  );
}
