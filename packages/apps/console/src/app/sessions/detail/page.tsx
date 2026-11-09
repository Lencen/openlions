// Phase0.5 路由先行 (2026-09-17): /sessions/detail 会话详情页 (?id=<session_uid>)
// Phase3 屏04 增量 (2026-09-18): 右侧派生 InspectorPanel —— 不新增 BFF, 直接由 messages[] 算出
//   角色分布 / 长度直方图 / 模型使用 / 时间跨度; 平台处置使用会话服务自身 status, 不向 mind 注册中心反查。
// 数据: 既有只读 BFF /api/session-detail/<uid> (代理 session 服务 3002 GET /api/v1/sessions/<uid>,
//       X-API-Key 走 env SESSION_SERVICE_API_KEY, 见 src/lib/secret.ts; 本页不新增 BFF、不直连库)。
// 注意: 归档登记 (mind registry) 与会话服务 (3002) 是两个数据面 —— 历史 SKIPPED 登记可能无对应
//       会话服务记录 (BFF 返回 {error:"session 服务 HTTP 404"}), 此处渲染空态而非 500/白屏。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零。
//   角色色改成 data-tone 属性选择器（assistant 那档沿用 inkOf 的 color-mix 配方，逐字落进 CSS）。
//   取数、字段、文案、路由语义一字未改。
import Link from "next/link";
import { statusLabel } from "@/config/systemLabels";
import { headers } from "next/headers";
import InspectorPanel, { type InspectorMessage } from "../_components/InspectorPanel";
import TableCopyButton from "@/components/TableCopyButton";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import { DetailFields } from "@/components/detail";
import { fmtStamp as fmtTs } from "@/lib/format";
import styles from "./page.module.css";


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

/** 角色 → 语义档位（原来直接返回内联 color；现在返回 data-tone，颜色在 page.module.css 里） */
function roleStyle(role: string): { tone: string; label: string } {
  if (role === "user") return { tone: "user", label: "用户" };
  // 2026-10-13 round 76-CU: --brand 是**按填充色**设计的, 直接当 11px 文字只有 ~3.3(需要 4.5);
  //   这里用与 inkOf 相同的配方把它向当前主题文字色混合(其它三个本来就是文字向令牌, 保持不变)。
  if (role === "assistant") return { tone: "assistant", label: "智能体" };
  if (role === "system") return { tone: "system", label: "系统" };
  return { tone: "tool", label: role || "tool" };
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
        {/* 2026-11-05 页头口径统一（UIUX PAGE-HEADER-31 §3 #20）：面包屑 / 标题 / 一句说明新写。
            标题与说明逐字取自口径表；取数（/api/session-detail/<uid>）与路由语义一字未改。 */}
        <div className="breadcrumb">
          <span className={styles.crumbDim}>服务</span>
          <span className="sep">/</span>
          <Link href="/sessions">会话</Link>
          <span className="sep">/</span>
          <span className="current">详情</span>
        </div>
        <PageHeader>
          <PageTitle>会话详情</PageTitle>
          <div className="page-subtitle">单会话的消息、事件与产出</div>
        </PageHeader>

        {!id ? (
          <div className={"panel " + styles.panelPad6}>
            <div className={styles.emptyTitle}>缺少会话参数</div>
            <div className={styles.emptyDesc}>
              请从 <Link href="/sessions" className={styles.primaryLink}>会话中心</Link> 选择一条会话进入。
            </div>
          </div>
        ) : fetchFailed ? (
          <div className={"panel " + styles.panelPad6}>
            <div className={styles.emptyTitle}>会话详情暂不可用</div>
            <div className={styles.emptyDesc}>BFF /api/session-detail 连接失败, 请稍后重试。</div>
          </div>
        ) : data?.error || !s ? (
          <div className={"panel " + styles.panelPad6}>
            <div className={styles.emptyTitle}>未找到该会话</div>
            <div className={styles.emptyDesc}>
              {data?.error ?? "会话服务无记录"} —— 可能是历史归档登记 (会话服务 3002 无对应会话)。
              &nbsp;<Link href="/sessions" className={styles.primaryLink}>返回会话中心</Link>
            </div>
          </div>
        ) : (
          <div className={styles.detailGrid}>
            <div className="dt-stack">
              {/* 2026-10-26：会话详情与认知详情统一解剖 —— 原来是 手写表格 当定义表（表头重、首列 120px）。
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
                      ? <Link href={`/agents/detail?id=${encodeURIComponent(s.agentId)}`} className={styles.primaryLink}>{s.agentId}</Link>
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
                  <div className={styles.msgEmpty}>该会话在会话服务中暂无消息记录。</div>
                ) : (
                  <div className={styles.msgList}>
                    {messages.map((m) => {
                      const r = roleStyle(m.role);
                      return (
                        <div key={m.messageUid} className={styles.msgCard}>
                          <div className={styles.msgHead}>
                            <span className={styles.msgRole} data-tone={r.tone}>[{r.label}]</span>
                            {m.model ? <span className="mono">{m.model}</span> : null}
                            {m.createdAt ? <span className="mono">{m.createdAt}</span> : null}
                            <span className={styles.msgUid}>{m.messageUid}</span>
                          </div>
                          <div className={styles.msgBody}>{m.content || "(空消息)"}</div>
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
