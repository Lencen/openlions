// Phase0.5 路由先行 (2026-09-17): /sessions/detail 会话详情页 (?id=<session_uid>)
// Phase3 屏04 增量 (2026-09-18): 右侧派生 InspectorPanel —— 不新增 BFF, 直接由 messages[] 算出
//   角色分布 / 长度直方图 / 模型使用 / 时间跨度; 平台处置使用会话服务自身 status, 不向 mind 注册中心反查。
// 数据: 既有只读 BFF /api/session-detail/<uid> (代理 session 服务 3002 GET /api/v1/sessions/<uid>,
//       X-API-Key 走 env SESSION_SERVICE_API_KEY, 见 src/lib/secret.ts; 本页不新增 BFF、不直连库)。
// 注意: 归档登记 (mind registry) 与会话服务 (3002) 是两个数据面 —— 历史 SKIPPED 登记可能无对应
//       会话服务记录 (BFF 返回 {error:"session 服务 HTTP 404"}), 此处渲染空态而非 500/白屏。
import Link from "next/link";
import { statusLabel } from "@/config/systemLabels";
import { inkOf } from "@/lib/ink";
import { headers } from "next/headers";
import InspectorPanel, { type InspectorMessage } from "../_components/InspectorPanel";
import TableCopyButton from "@/components/TableCopyButton";
import { DetailFields } from "@/components/detail";
import { fmtStamp as fmtTs } from "@/lib/format";


export const dynamic = "force-dynamic";

interface DetailMessage {
  messageUid: string;
  role: string;
  content: string;
  createdAt: string | null;
  model?: string | null;
}
interface DetailPayload {
  session?: {
    sessionUid: string; agentId?: string | null; source?: string | null; sourceId?: string | null;
    title?: string | null; startedAt?: string | null; lastMessageAt?: string | null;
    updatedAt?: string | null; messageCount?: number; status?: string | null;
    model?: string | null; platform?: string | null;
  };
  totalMessages?: number;
  messagesTruncated?: boolean;
  messages?: DetailMessage[];
  error?: string;
}

function roleStyle(role: string): { color: string; label: string } {
  if (role === "user") return { color: "var(--info)", label: "用户" };
  // 2026-10-13 round 76-CU: --brand 是**按填充色**设计的, 直接当 11px 文字只有 ~3.3(需要 4.5);
  //   这里用 inkOf 把它向当前主题文字色混合(其它三个本来就是文字向令牌, 保持不变)。
  if (role === "assistant") return { color: inkOf("var(--brand)"), label: "智能体" };
  if (role === "system") return { color: "var(--text-3)", label: "系统" };
  return { color: "var(--warn)", label: role || "tool" };
}

export default async function SessionDetailPage({
  searchParams,
}: {
  searchParams?: { id?: string };
}) {
  const id = (searchParams?.id || "").trim();

  let data: DetailPayload | null = null;
  let fetchFailed = false;
  if (id) {
    try {
      const h = headers();
      const host = h.get("host") || `127.0.0.1:${process.env.PORT || 3004}`;
      const res = await fetch(`http://${host}/api/session-detail/${encodeURIComponent(id)}`, { cache: "no-store" });
      data = (await res.json()) as DetailPayload;
      if (!res.ok) data = { error: data?.error || `BFF HTTP ${res.status}` };
    } catch {
      fetchFailed = true;
    }
  }

  // Phase3 屏04: 不再向 mind 注册中心反查 (那需要新 BFF); 直接使用会话服务的 status 作为
  //   InspectorPanel 的『平台处置』来源 — 它已经是真实数据, 足够让 SKIPPED/FAILED/DONE(旧键 PROCESSED) 不再黑盒。
  const s = data?.session;
  const messages: InspectorMessage[] = (data?.messages ?? []).map((m) => ({
    messageUid: m.messageUid,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    model: m.model ?? null,
  }));

  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <Link href="/">概览</Link>
          <span className="sep">/</span>
          <Link href="/sessions">会话中心</Link>
          <span className="sep">/</span>
          <span className="current">会话详情</span>
        </div>

        {!id ? (
          <div className="panel" style={{ padding: "var(--sp-6)" }}>
            <div style={{ fontWeight: 600, marginBottom: "var(--sp-2)" }}>缺少会话参数</div>
            <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-md)" }}>
              请从 <Link href="/sessions" style={{ color: "var(--primary)" }}>会话中心</Link> 选择一条会话进入。
            </div>
          </div>
        ) : fetchFailed ? (
          <div className="panel" style={{ padding: "var(--sp-6)" }}>
            <div style={{ fontWeight: 600, marginBottom: "var(--sp-2)" }}>会话详情暂不可用</div>
            <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-md)" }}>BFF /api/session-detail 连接失败, 请稍后重试。</div>
          </div>
        ) : data?.error || !s ? (
          <div className="panel" style={{ padding: "var(--sp-6)" }}>
            <div style={{ fontWeight: 600, marginBottom: "var(--sp-2)" }}>未找到该会话</div>
            <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-md)" }}>
              {data?.error ?? "会话服务无记录"} —— 可能是历史归档登记 (会话服务 3002 无对应会话)。
              &nbsp;<Link href="/sessions" style={{ color: "var(--primary)" }}>返回会话中心</Link>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: "var(--sp-4)", alignItems: "start" }}>
            <div className="dt-stack">
              {/* 2026-10-26：会话详情与认知详情统一解剖 —— 原来是 <table class="tbl"> 当定义表（表头重、首列 120px）。
                  改成 DetailFields（label 96px + 值），并把三段时间戳合并成一栏。 */}
              <DetailFields
                title="会话信息"
                cols={1}
                items={[
                  { label: "会话 UID", value: s.sessionUid, kind: "mono" },
                  { label: "标题", value: s.title },
                  {
                    label: "智能体",
                    value: s.agentId
                      ? <Link href={`/agents/detail?id=${encodeURIComponent(s.agentId)}`} style={{ color: "var(--primary)" }}>{s.agentId}</Link>
                      : "",
                    kind: "mono",
                  },
                  { label: "来源", value: (s.source ?? "") + (s.sourceId ? ` / ${s.sourceId}` : "") },
                  { label: "状态", value: statusLabel(s.status) || "" },
                  { label: "消息数", value: String(s.messageCount ?? data?.totalMessages ?? "") },
                  { label: "模型 / 平台", value: [s.model, s.platform].filter(Boolean).join(" / ") },
                  { label: "开始", value: fmtTs(s.startedAt) },
                  { label: "最近消息", value: fmtTs(s.lastMessageAt) },
                  { label: "更新", value: fmtTs(s.updatedAt) },
                ]}
              />

              <div className="panel">
                <div className="panel-header">
                  <span className="panel-title">消息列表{data?.messagesTruncated ? " (已截断展示)" : ""}</span>
                </div>
                {messages.length === 0 ? (
                  <div style={{ padding: "var(--sp-4)", color: "var(--text-dim)" }}>该会话在会话服务中暂无消息记录。</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", padding: "var(--sp-3)" }}>
                    {messages.map((m) => {
                      const r = roleStyle(m.role);
                      return (
                        <div key={m.messageUid} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "var(--sp-2-5) var(--sp-3)", background: "var(--bg-surface)" }}>
                          <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", marginBottom: "var(--sp-1-5)", fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
                            <span style={{ color: r.color, fontWeight: 600 }}>[{r.label}]</span>
                            {m.model ? <span className="mono">{m.model}</span> : null}
                            {m.createdAt ? <span className="mono">{m.createdAt}</span> : null}
                            <span className="mono" style={{ marginLeft: "auto", fontSize: "var(--fs-xs)" }}>{m.messageUid}</span>
                          </div>
                          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "var(--fs-md)" }}>{m.content || "(空消息)"}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Phase3 屏04 检查器 (右侧栏) */}
            <InspectorPanel
              messages={messages}
              registryStatus={s.status ?? null}
              processingNote={null}
            />
          </div>
        )}
      </main>
    </div>
  );
}
