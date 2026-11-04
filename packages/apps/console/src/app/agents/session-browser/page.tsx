"use client";
import { interactiveProps } from "@/components/a11y";
import Link from "next/link";
import KPICard from "@/components/KPICard";
import { useGlobalNonce } from "@/components/GlobalFilter";
import { useState, useEffect, useCallback } from "react";
import { t } from "@/i18n";

interface SessionItem {
  id: string;
  agentId: string;
  title: string;
  messageCount: number;
  startedAt: string;
  lastMessageAt: string;
}

interface SessionListResp {
  items: SessionItem[];
  nextCursor: string | null;
  total: number;
  limit: number;
  sortBy: string;
  error?: string;
}

interface SessionDetail {
  session: {
    sessionUid: string;
    agentId: string;
    title: string;
    messageCount: number;
    startedAt: string;
    lastMessageAt: string;
  };
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp?: string;
  }>;
}

const PAGE_SIZE = 100; // session 服务 max 500; 前端 100/页更流畅, 也给后端 cursor 翻页

export default function SessionBrowserPage() {
  // 2026-10-13 round 76-DK: 接入全局刷新(见 fetchPage 里的 _gf)。
  const gfNonce = useGlobalNonce();
  const [filterAgent, setFilterAgent] = useState<string>("");
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  // P0 [todo_zowi9ayu1m2kkuyw] 2026-09-15: 多页状态
  //   - items 累积所有已加载页
  //   - cursor 翻页 (服务端 nextCursor base64(updatedAt))
  //   - total 来自后端 (中间层 COUNT 真值)
  //   - 切换 agent 时 reset
  const [items, setItems] = useState<SessionItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  // 2026-10-13 round 76-CY: 初值改为 **true** —— 本页**挂载即加载**(在 useEffect 里)。
  //   初值 false 时, 从首帧到 effect 跑起来之间会渲染出 items=[]、total=null,
  //   于是显示"0 个会话"与"暂无会话" —— 那是**假空态/假计数**(与"真的没有会话"无法区分)。
  const [loadingPage, setLoadingPage] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null, reset: boolean) => {
      if (reset) setLoadingPage(true);
      else setLoadingMore(true);
      setListError(null);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
        // 2026-10-13 round 76-DK: 加上全局 nonce —— 本页只挂载拉一次(无轮询), 让顶栏刷新也能重取。
        qs.set("_gf", String(gfNonce));
        if (filterAgent) qs.set("agentId", filterAgent);
        if (cursor) qs.set("cursor", cursor);
        qs.set("sortBy", "last_message_at");
        const res = await fetch(
          `/api/session-service-list?${qs.toString()}`
        );
        const data: SessionListResp = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setTotal(data.total);
        setNextCursor(data.nextCursor);
        setItems((prev) => (reset ? data.items : [...prev, ...data.items]));
      } catch (e: any) {
        setListError(e?.message || String(e));
        if (reset) {
          setItems([]);
          setNextCursor(null);
          setTotal(null);
        }
      } finally {
        if (reset) setLoadingPage(false);
        else setLoadingMore(false);
      }
    },
    [filterAgent, gfNonce]
  );

  // agent 切换 / 首次加载: 重头拉
  useEffect(() => {
    fetchPage(null, true);
  }, [filterAgent, fetchPage]);

  const loadMore = () => {
    if (nextCursor && !loadingMore && !loadingPage) {
      fetchPage(nextCursor, false);
    }
  };

  // 选中 session 后加载详情
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedUid) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    fetch(`/api/session-detail/${encodeURIComponent(selectedUid)}`)
      // 2026-10-13 round 76-AI: 原来不检查 r.ok —— 详情接口 500 时错误体被 setDetail, 渲染 detail.messages.length 抛异常(整页崩)。
      .then((r) => { if (!r.ok) throw new Error("请求失败（状态码 " + r.status + "）"); return r.json(); })
      .then((data) => {
        setDetail(data);
        setDetailLoading(false);
      })
      .catch((e) => { setDetailError(e?.message || String(e)); setDetailLoading(false); });
  }, [selectedUid]);

  const agentOptions = Array.from(new Set(items.map((i) => i.agentId))).sort();

  return (
    <div className="layout-with-sidebar">

      <main className="main">
        <div className="breadcrumb">
          <span style={{ color: "var(--text-dim)" }}>{t('sessionBrowser.crumb')}</span>
          <span className="sep">/</span>
          <span className="current">{t('sessionBrowser.title')}</span>
        </div>
        <div className="page-header">
          <div className="page-title">{t('sessionBrowser.title')}</div>
          <div className="page-subtitle">
            {t('sessionBrowser.meta', {
              n: loadingPage
                ? "加载中..."
                : total !== null
                  ? `${items.length} / ${total}`
                  : items.length,
            })}
          </div>
        </div>
        {/* 2026-10-19 B4: 修前首屏大号数字 **0 个** ✗ —— "已加载/总数"藏在副标题小字里。补 ≤3 张 ✓ */}

        <div className="kpi-grid" style={{ marginBottom: "var(--sp-3)" }}>

          <KPICard label="已加载会话（个）" value={items.length} delta={total !== null ? "共 " + total : "总数未知"} />

          <KPICard label="涉及智能体（个）" value={agentOptions.length} delta="按已加载会话" />

          <KPICard label="选中会话消息（条）" value={detail?.messages?.length ?? 0} delta={selectedUid ? "已选会话" : "未选会话"} />

        </div>


        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "var(--sp-4)", height: "calc(100vh - 180px)" }}>
          {/* 左侧：会话列表 */}
          <div className="panel" style={{ overflow: "auto", margin: 0 }}>
            <div className="panel-header">
              <span className="panel-title">{t('sessionBrowser.list')}</span>
              <select
                aria-label="按智能体筛选"
                value={filterAgent}
                onChange={(e) => setFilterAgent(e.target.value)}
                style={{ padding: "var(--sp-1) var(--sp-2)", background: "var(--bg-surface2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)" }}
              >
                <option value="">{t('sessionBrowser.allAgents')}</option>
                {agentOptions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            {listError && (
              <div style={{ padding: "var(--sp-5)", color: "var(--status-crit)" }}>
                加载失败: {listError}
              </div>
            )}
            {items.length === 0 && !loadingPage && !listError && (
              <div style={{ padding: "var(--sp-5)", color: "var(--text-muted)" }}>{t('sessionBrowser.empty')}</div>
            )}
            {items.map((s) => (
              <div
                key={s.id}
                {...interactiveProps(selectedUid === s.id)}
                onClick={() => setSelectedUid(s.id)}
                style={{
                  padding: "var(--sp-2-5) var(--sp-3-5)",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  background: selectedUid === s.id ? "var(--bg-hover)" : "transparent",
                }}
              >
                <div style={{ fontSize: "var(--fs-md)", fontWeight: 500 }}>{s.title || s.id.slice(0, 50)}</div>
                <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginTop: "var(--sp-1)" }}>
                  {s.agentId} · {s.messageCount} msgs · {new Date(s.startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}
                </div>
              </div>
            ))}
            {/* P0 加载更多按钮 */}
            {nextCursor && (
              <div style={{ padding: "var(--sp-3) var(--sp-3-5)", textAlign: "center" }}>
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{
                    padding: "var(--sp-1-5) var(--sp-4)",
                    background: "var(--bg-surface2)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-xs)",
                    cursor: loadingMore ? "wait" : "pointer",
                    fontSize: "var(--fs-base)",
                  }}
                >
                  {loadingMore ? "加载中..." : `加载更多 (已加载 ${items.length} / 总 ${total ?? "?"})`}
                </button>
              </div>
            )}
          </div>

          {/* 右侧：消息详情 */}
          <div className="panel" style={{ overflow: "auto", margin: 0 }}>
            <div className="panel-header">
              <span className="panel-title">
                {detail?.session?.title || (selectedUid ? (detailError ? "加载失败" : "加载中...") : t('sessionBrowser.pick'))}
              </span>
              {detail && (
                <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>
                  {detail.messages.length} 条消息
                </span>
              )}
            </div>
            <div style={{ padding: "var(--sp-3-5)" }}>
              {detailLoading && <div style={{ color: "var(--text-muted)" }}>加载中...</div>}
              {detailError && <div style={{ color: "var(--status-crit)" }}>详情加载失败: {detailError}</div>}
              {detail && (
                <>
                  {detail.messages.map((m, i) => (
                    <div
                      key={i}
                      style={{
                        marginBottom: "var(--sp-3)",
                        padding: "var(--sp-2-5)",
                        borderRadius: "var(--radius-sm)",
                        background: m.role === "user" ? "var(--bg-surface2)" : "var(--bg-hover)",
                        borderLeft: `3px solid ${m.role === "user" ? "var(--info)" : "var(--status-ok)"}`,
                      }}
                    >
                      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginBottom: "var(--sp-1)" }}>
                        {m.role} {m.timestamp && `· ${new Date(m.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`}
                      </div>
                      <div style={{ fontSize: "var(--fs-md)", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace" }}>
                        {m.content.length > 2000 ? m.content.slice(0, 2000) + "..." : m.content}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
        {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
        <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
          <span>相关视图：</span>
          <Link href="/sessions">会话中心 →</Link>
          <Link href="/agents/sessions">会话概览 →</Link>
        </div>
      </main>
    </div>
  );
}