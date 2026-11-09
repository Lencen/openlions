"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useUrlParam } from "@/lib/useUrlParam";
import { statusLabel } from "@/config/systemLabels";
import { t } from "@/i18n";
import KPICard from "@/components/KPICard";
import { Segmented } from "@/components/primitives";
import { classify, textFor, type AsyncPhase } from "@/lib/asyncState";
import TableCopyButton from "@/components/TableCopyButton";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

export default function CommPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // 2026-11-02 Day2 PoC：四态显式化（此前只判 d.error，401 空体会被渲染成"空列表"）
  const [phase, setPhase] = useState<AsyncPhase>("loading");
  const [errView, setErrView] = useState<{ status?: number; code?: string; message?: string } | null>(null);
  // 2026-10-19 B3: 页签进 URL（可分享"我在看哪个页签"、后退可回退）—— 修前该页无任何 URL API ✗
  const [tab, setTab] = useUrlParam("tab", "status");
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [viewAgent, setViewAgent] = useState<string>(""); // IM 视角: 该 agent 的消息靠右
  const [targetAgent, setTargetAgent] = useState<string>(""); // 通讯录选中目标
  const [draft, setDraft] = useState(""); // 发起会话草稿
  const [sending, setSending] = useState(false);

  const load = async () => {
    try {
      const r = await fetch("/api/system/comm", { cache: "no-store" });
      const d = await r.json().catch(() => null);
      const out = classify(r.status, d, (b: any) => !b || (!(b.macs_agents || []).length && !(b.conversations || []).length));
      if (out.phase === "error") { setErrView(out.error || null); setError(out.error?.message || "取数失败"); setPhase("error"); return; }
      setErrView(null); setError(""); setData(d); setPhase(out.phase);
    } catch (e: any) { setErrView({ status: 0, message: e.message }); setError(e.message); setPhase("error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const openConv = async (cid: string) => {
    setActiveConv(cid); setMsgLoading(true); setMessages([]);
    const parts = (convs.find((c: any) => c.conversation_id === cid)?.participant_ids || []).filter(Boolean);
    if (parts.length && !parts.includes(viewAgent)) setViewAgent(parts.includes("operator") ? "operator" : parts[0]);
    try { const r = await fetch("/api/system/comm?view=messages&conversation_id=" + encodeURIComponent(cid), { cache: "no-store" }); const d = await r.json(); setMessages([...(d?.messages || [])].sort((a: any, b: any) => parseTs(a) - parseTs(b))); }
    catch (e: any) { setError(e.message); } finally { setMsgLoading(false); }
  };

  const macsOk = data && data.macs && data.macs.code === 200;
  const mcpList = (data?.mcp_agents ?? []).filter((a: any) => a.mcp_auth === "ACTIVE");
  const onlineCount = (data?.mcp_agents ?? []).filter((a: any) => a.macs_status === "online" || a.macs_status === "registered").length;
  const convs = data?.conversations ?? [];
  const fmtT = (t?: string) => t ? new Date(t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
  const txt = (c: any) => { if (!c) return ""; if (typeof c === "string") { try { const j = JSON.parse(c); return j.text || c; } catch { return c; } } if (typeof c === "object") return c.text || c.content || JSON.stringify(c); return String(c); };
  // macs messages: from + text + created_at (无 T 需补时区)
  const mFrom = (m: any) => m.sender_id || m.from || m.sender || "—";
  const mText = (m: any) => m.content !== undefined && m.content !== null ? txt(m.content) : (m.text !== undefined ? txt(m.text) : "");
  const mTime = (m: any) => { const t = m.created_at || m.timestamp || ""; if (!t) return "—"; if (t.includes("T")) return new Date(t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); return new Date(t.replace(" ", "T") + "+08:00").toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); };
  // 2026-09-08 修复消息乱序: created_at 两种格式混存, 按解析后的时间戳升序(老上新下)
  const parseTs = (m: any) => { const t = m?.created_at || m?.timestamp || ""; if (!t) return 0; const n = t.includes("T") ? Date.parse(t) : Date.parse(t.replace(" ", "T") + "+08:00"); return Number.isNaN(n) ? 0 : n; };
  const msgTime = (t?: string) => t ? (t.includes("T") ? new Date(t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : t) : "—";


  // 2026-11-05 P2 批10（呈现层）：本页 50 处内联 style 清零（下沉 page.module.css），
  //   2 张手写 .tbl 裸表 → 白名单 @/components/DataTable；取数/接口/URL 页签/文案/字段名未动。
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>业务与系统</span><span className="sep">/</span><span className="current">通信服务</span></div>
    <PageHeader><PageTitle>{t('comm.title')}</PageTitle><div className="page-subtitle">{t('comm.subtitle')}</div></PageHeader>
    <div className={styles.autoReply}>{t('comm.autoReply')}</div>
    {phase !== "ready" && (() => {
      const v = textFor(phase, errView || undefined);
      const isErr = phase === "error";
      return (
        <div role="status" className={styles.stateBox} data-tone={isErr ? "error" : undefined}>
          <div className={styles.stateTitle}>{v.title}</div>
          <div className={styles.stateHint}>{v.hint}</div>
        </div>
      );
    })()}
    <div className="kpi-grid"><KPICard label={t('comm.kpi.service')} value={macsOk ? "在线" : (loading ? "检测中..." : "离线")} /><KPICard label={t('comm.kpi.mcpAuth')} value={String(mcpList.length)} /><KPICard label={t('comm.kpi.online')} value={String(onlineCount)} /><KPICard label={t('comm.kpi.convs')} value={String(convs.length)} /></div>
    <div className={styles.tabBar}><Segmented options={[{ label: "服务状态与授权", value: "status" }, { label: "通讯录", value: "contacts" }, { label: "沟通记录 (" + convs.length + ")", value: "convs" }]} value={tab} onChange={setTab} /></div>

    {tab === "status" && renderStatus() }
    {tab === "contacts" && renderContacts() }
    {tab === "convs" && renderConvs() }
    {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className={"tiny " + styles.related}>
      <span>相关视图：</span>
      <Link href="/sessions">会话中心 →</Link>
      <Link href="/system/health">健康检查 →</Link>
    </div>
  </main></div>);

  function renderStatus() {
    // 2026-11-05 P2 批10：列与改前表头逐列对应（智能体 / 显示名 / 平台状态 / MCP 授权 / MACS 在线 / 最后活跃）。
    //   本页是客户端组件（文件头 "use client"），可以传函数列（render / rowKey）。
    const mcpCols: DataColumn<any>[] = [
      { key: "agent_id", title: t('comm.col.agent'), render: (a: any) => <span className={"nowrap mono " + styles.agentId}>{a.agent_id}</span> },
      { key: "display_name", title: t('comm.col.displayName'), render: (a: any) => <span className="nowrap">{a.display_name || "—"}</span> },
      { key: "status", title: t('comm.col.platformStatus'), render: (a: any) => <span className={"badge " + (a.status === "ACTIVE" ? "badge-green" : "badge-yellow")}>{a.status}</span> },
      { key: "mcp_auth", title: t('comm.col.mcpAuth'), render: (a: any) => <span className={"badge " + (a.mcp_auth === "ACTIVE" ? "badge-green" : "badge-red")}>{a.mcp_auth === "ACTIVE" ? "已授权" : (a.mcp_auth === "REVOKED" ? "已取消" : "未授权")}</span> },
      { key: "macs_status", title: t('comm.col.macsOnline'), render: (a: any) => <span className={"badge " + (a.macs_status === "online" ? "badge-green" : "badge")}>{a.macs_status || "—"}</span> },
      { key: "last_seen", title: t('comm.col.lastActive'), render: (a: any) => <span className={"nowrap mono " + styles.dateXs}>{fmtT(a.last_seen)}</span> },
    ];
    return (<div>
    <div className="panel"><div className="panel-header"><span className="panel-title">{t('comm.matrix.title')}</span></div>
      <TableCopyButton />
      {/* 2026-11-05 P2 批10：裸 .tbl → 白名单 DataTable；行 key 取 agent_id，空态文案沿用改前的 t('comm.noMcpAgent') */}
      <DataTable columns={mcpCols} rows={mcpList} rowKey={(a: any) => a.agent_id} loading={loading} empty={{ title: t('comm.noMcpAgent') }} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">通信服务统计</span></div><div className={styles.statsRow}>{macsOk ? <span className="badge badge-green">运行中</span> : <span className="badge badge-red">离线</span>} <span className={styles.statsNote}>平台化管理</span></div><pre className={styles.statsPre}>{JSON.stringify(data?.macs_stats ?? {}, null, 2).slice(0, 300)}</pre></div>
  </div>); }

  async function sendAsLencen(to: string) {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await fetch("/api/system/comm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, text }), cache: "no-store" as any });
      const d = await r.json();
      if (d.error) { setError("发送失败: " + d.error); }
      else {
        setDraft("");
        setTab("convs");
        await load();
        if (d.conversation_id) { setViewAgent("operator"); openConv(d.conversation_id); }
      }
    } catch (e: any) { setError("发送异常: " + e.message); }
    finally { setSending(false); }
  }

  function renderContacts() {
    const aiAgents = (data?.macs_agents || []).filter((a: any) => (a.channel || "") !== "human");
    const nameOf = (id: string) => { const a = (data?.macs_agents || []).find((x: any) => x.agent_id === id); return a?.display_name || id.replace(/^agent-/, ""); };
    return (<div className="panel"><div className="panel-header"><span className="panel-title">{t('comm.contacts.title')}</span></div>
      <div className={styles.contactIntro}>发起身份: <b>我 · 运营者(operator)</b> <span className={"badge " + styles.identityBadge}>{t('comm.contact.identity')}</span></div>
      <div className={styles.contactGrid}>
        {aiAgents.map((a: any) => (
          <div key={a.agent_id} data-agent={a.agent_id} onClick={() => setTargetAgent(a.agent_id === targetAgent ? "" : a.agent_id)}
            className={styles.agentCard} data-selected={targetAgent === a.agent_id}>
            <div className={styles.agentCardHead}>
              <div className={styles.avatar}>{a.avatar || (a.display_name || "?")[0]}</div>
              <div className={styles.agentNameWrap}>
                <div className={styles.agentName}>{a.display_name || a.agent_id}</div>
                <div className={"mono " + styles.agentIdSm}>{a.agent_id}</div>
              </div>
            </div>
            <div className={styles.agentCardFoot}>
              <span className={"badge " + (a.status === "online" ? "badge-green" : "badge")}>{statusLabel(String(a.status || "offline").toUpperCase()) || "离线"}</span>
              <span className={styles.channel}>{a.channel}</span>
            </div>
          </div>
        ))}
        {aiAgents.length === 0 && !loading && <div className={styles.emptyPad}>{t('comm.noAgents')}</div>}
      </div>
      {targetAgent && (
        <div className={styles.compose}>
          <div className={styles.composeHead}>发起会话 → <b>{nameOf(targetAgent)}</b> ({targetAgent})</div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('comm.send.placeholder', { name: nameOf(targetAgent) })} className={styles.composeInput} />
          <div className={styles.composeActions}>
            <button onClick={() => sendAsLencen(targetAgent)} disabled={sending || !draft.trim()} className={styles.sendBtn}>{sending ? "发送中…" : "发送"}</button>
            <span className={styles.sendNote}>{t('comm.send.note')}</span>
          </div>
        </div>
      )}
    </div>);
  }

  function renderConvs() {
    const parts = (convs.find((c: any) => c.conversation_id === activeConv)?.participant_ids || []).filter(Boolean);
    const view = viewAgent || parts[0] || "";
    const shortName = (id: string) => id.replace(/^agent-/, "");
    const nameOf = (id: string) => { const a = [...(data?.mcp_agents || []), ...(data?.macs_agents || [])].find((x: any) => x.agent_id === id); return a?.display_name || shortName(id); };
    // 2026-11-05 P2 批10：列与改前表头逐列对应（参与方 / 消息数 / 最后消息 / 时间）。
    //   整行点击仍走 DataTable 的 onRow；键盘可达由参与方单元格里的原生 button 承担
    //   （原先是 tr 上的 interactiveProps：DataTable 的 tr 不进 Tab 序列，故保留同一开关的键盘入口，见 .rowBtn）。
    const convCols: DataColumn<any>[] = [
      {
        key: "participants",
        title: t('comm.col.participants'),
        render: (c: any) => (
          <button type="button" className={styles.rowBtn} aria-expanded={activeConv === c.conversation_id}
            onClick={(e) => { e.stopPropagation(); openConv(c.conversation_id); }}>
            {(c.participant_ids || []).join(" ↔ ")}
          </button>
        ),
      },
      { key: "message_count", title: "消息数", align: "right", render: (c: any) => <span className={styles.numMono}>{c.message_count}</span> },
      { key: "last_message_preview", title: "最后消息", render: (c: any) => <span className={styles.preview}>{c.last_message_preview || "—"}</span> },
      { key: "last_message_at", title: "时间", render: (c: any) => <span className={"nowrap mono " + styles.dateXs}>{fmtT(c.last_message_at)}</span> },
    ];
    return (<div className="panel"><div className="panel-header"><span className="panel-title">{t('comm.records.title')}</span></div>
      <div className={styles.convsLayout}>
        <div className={styles.convsCol}><TableCopyButton />
        {/* 2026-11-05 P2 批10：裸 .tbl → 白名单 DataTable；行 key 取 conversation_id，空态文案沿用改前的「暂无沟通会话」 */}
        <DataTable columns={convCols} rows={convs} rowKey={(c: any) => c.conversation_id}
          onRow={(c: any) => ({ onClick: () => openConv(c.conversation_id), className: activeConv === c.conversation_id ? styles.convRow + " " + styles.convRowActive : styles.convRow })}
          loading={loading} empty={{ title: "暂无沟通会话" }} /></div>
        <div className={styles.convsSide}>
          <div className={styles.viewBar}>
            <span className={styles.viewLabel}>视角(靠右为本人):</span>
            {parts.map((p: string) => <button key={p} onClick={() => setViewAgent(p)} className={styles.viewBtn} data-active={view === p}>{shortName(p)}</button>)}
            {parts.length === 0 && <span className={styles.msgEmpty}>—</span>}
          </div>
          <div className={styles.msgScroll}>
            {msgLoading && <div className={styles.msgLoading}>加载中...</div>}
            {!activeConv && !msgLoading && <div className={styles.msgHint}>← 点击左侧会话查看消息</div>}
            {messages.map((m: any, i: number) => {
              const from = mFrom(m) || "";
              const mine = !!from && from === view;
              return (<div key={i} className={styles.msgRow} data-mine={mine}>
                <div className={styles.msgBody}>
                  <div className={styles.msgMeta} data-mine={mine}>
                    <b>{from ? nameOf(from) : "—"}</b> · {mTime(m)}
                  </div>
                  <div className={styles.bubble} data-mine={mine}>{mText(m) || " "}</div>
                </div>
              </div>);
            })}
          </div>
        </div>
      </div></div>);
  }
}