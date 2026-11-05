"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useUrlParam } from "@/lib/useUrlParam";
import { statusLabel } from "@/config/systemLabels";
import { interactiveProps } from "@/components/a11y";
import { t } from "@/i18n";
import KPICard from "@/components/KPICard";
import { Segmented } from "@/components/primitives";
import { classify, textFor, type AsyncPhase } from "@/lib/asyncState";
import TableCopyButton from "@/components/TableCopyButton";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

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


  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>业务与系统</span><span className="sep">/</span><span className="current">通信服务</span></div>
    <PageHeader><PageTitle>{t('comm.title')}</PageTitle><div className="page-subtitle">{t('comm.subtitle')}</div></PageHeader>
    <div style={{ fontSize: "var(--fs-base)", color: "var(--text-muted)", marginBottom: "var(--sp-2)" }}>{t('comm.autoReply')}</div>
    {phase !== "ready" && (() => {
      const v = textFor(phase, errView || undefined);
      const isErr = phase === "error";
      return (
        <div role="status" style={{ marginBottom: "var(--sp-3)", padding: "var(--sp-3)", borderRadius: 8,
          border: "1px solid " + (isErr ? "var(--status-crit)" : "var(--border-subtle)"),
          color: isErr ? "var(--status-crit)" : "var(--text-muted)" }}>
          <div style={{ fontWeight: 600 }}>{v.title}</div>
          <div style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>{v.hint}</div>
        </div>
      );
    })()}
    <div className="kpi-grid"><KPICard label={t('comm.kpi.service')} value={macsOk ? "在线" : (loading ? "检测中..." : "离线")} /><KPICard label={t('comm.kpi.mcpAuth')} value={String(mcpList.length)} /><KPICard label={t('comm.kpi.online')} value={String(onlineCount)} /><KPICard label={t('comm.kpi.convs')} value={String(convs.length)} /></div>
    <div style={{ marginBottom: "var(--sp-3)" }}><Segmented options={[{ label: "服务状态与授权", value: "status" }, { label: "通讯录", value: "contacts" }, { label: "沟通记录 (" + convs.length + ")", value: "convs" }]} value={tab} onChange={setTab} /></div>

    {tab === "status" && renderStatus() }
    {tab === "contacts" && renderContacts() }
    {tab === "convs" && renderConvs() }
    {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/sessions">会话中心 →</Link>
      <Link href="/system/health">健康检查 →</Link>
    </div>
  </main></div>);

  function renderStatus() { return (<div>
    <div className="panel"><div className="panel-header"><span className="panel-title">{t('comm.matrix.title')}</span></div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>{t('comm.col.agent')}</th><th>{t('comm.col.displayName')}</th><th>{t('comm.col.platformStatus')}</th><th>{t('comm.col.mcpAuth')}</th><th>{t('comm.col.macsOnline')}</th><th>{t('comm.col.lastActive')}</th></tr></thead><tbody>
        {mcpList.map((a: any) => (<tr key={a.agent_id}><td className="nowrap mono" style={{fontSize:"var(--fs-base)"}}>{a.agent_id}</td><td className="nowrap">{a.display_name || "—"}</td><td><span className={"badge " + (a.status === "ACTIVE" ? "badge-green" : "badge-yellow")}>{a.status}</span></td><td><span className={"badge " + (a.mcp_auth === "ACTIVE" ? "badge-green" : "badge-red")}>{a.mcp_auth === "ACTIVE" ? "已授权" : (a.mcp_auth === "REVOKED" ? "已取消" : "未授权")}</span></td><td><span className={"badge " + (a.macs_status === "online" ? "badge-green" : "badge")}>{a.macs_status || "—"}</span></td><td className="nowrap mono" style={{fontSize:"var(--fs-sm)"}}>{fmtT(a.last_seen)}</td></tr>))}
        {mcpList.length === 0 && !loading && <tr><td colSpan={6} style={{padding: "var(--sp-4)",color:"var(--text-muted)",textAlign:"center"}}>{t('comm.noMcpAgent')}</td></tr>}
      </tbody></table></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">通信服务统计</span></div><div style={{fontSize:"var(--fs-md)",padding: "var(--sp-1) 0"}}>{macsOk ? <span className="badge badge-green">运行中</span> : <span className="badge badge-red">离线</span>} <span style={{color:"var(--text-dim)",fontSize:"var(--fs-base)"}}>平台化管理</span></div><pre style={{fontSize:"var(--fs-sm)",color:"var(--text-dim)",whiteSpace:"pre-wrap",margin:0}}>{JSON.stringify(data?.macs_stats ?? {}, null, 2).slice(0, 300)}</pre></div>
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
      <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)", marginBottom: "var(--sp-2-5)" }}>发起身份: <b>我 · 运营者(operator)</b> <span className="badge" style={{ background: "var(--bg-surface2)", padding: "var(--sp-0-5) var(--sp-1-5)", borderRadius: "var(--radius-md)" }}>{t('comm.contact.identity')}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: "var(--sp-2-5)" }}>
        {aiAgents.map((a: any) => (
          <div key={a.agent_id} data-agent={a.agent_id} onClick={() => setTargetAgent(a.agent_id === targetAgent ? "" : a.agent_id)}
            style={{ border: "1px solid " + (targetAgent === a.agent_id ? "var(--primary)" : "var(--border)"), borderRadius: "var(--radius-md)", padding: "var(--sp-2-5)", cursor: "pointer", background: targetAgent === a.agent_id ? "var(--bg-hover)" : undefined }}>
            <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
              <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--primary)", color: "var(--on-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--fs-lg)" }}>{a.avatar || (a.display_name || "?")[0]}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "var(--fs-md)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.display_name || a.agent_id}</div>
                <div className="mono" style={{ fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>{a.agent_id}</div>
              </div>
            </div>
            <div style={{ marginTop: "var(--sp-1-5)", fontSize: "var(--fs-sm)", display: "flex", justifyContent: "space-between" }}>
              <span className={"badge " + (a.status === "online" ? "badge-green" : "badge")}>{statusLabel(String(a.status || "offline").toUpperCase()) || "离线"}</span>
              <span style={{ color: "var(--text-dim)" }}>{a.channel}</span>
            </div>
          </div>
        ))}
        {aiAgents.length === 0 && !loading && <div style={{ color: "var(--text-muted)", padding: "var(--sp-5)" }}>{t('comm.noAgents')}</div>}
      </div>
      {targetAgent && (
        <div style={{ marginTop: "var(--sp-3)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "var(--sp-3)" }}>
          <div style={{ fontSize: "var(--fs-md)", marginBottom: "var(--sp-2)" }}>发起会话 → <b>{nameOf(targetAgent)}</b> ({targetAgent})</div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('comm.send.placeholder', { name: nameOf(targetAgent) })} style={{ width: "100%", minHeight: 70, boxSizing: "border-box", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", padding: "var(--sp-2)", fontSize: "var(--fs-md)", resize: "vertical", background: "var(--bg)" }} />
          <div style={{ marginTop: "var(--sp-2)", display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
            <button onClick={() => sendAsLencen(targetAgent)} disabled={sending || !draft.trim()} style={{ padding: "var(--sp-2) var(--sp-4)", borderRadius: "var(--radius-md)", border: "none", background: "var(--primary)", color: "var(--on-primary)", fontWeight: 600, cursor: "pointer", fontSize: "var(--fs-md)" }}>{sending ? "发送中…" : "发送"}</button>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{t('comm.send.note')}</span>
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
    return (<div className="panel"><div className="panel-header"><span className="panel-title">{t('comm.records.title')}</span></div>
      <div style={{ display: "flex", gap: "var(--sp-4)", alignItems: "flex-start" }}>
        <div style={{ flex: "0 0 46%", minWidth: 0 }}><TableCopyButton />
        <table className="tbl"><thead><tr><th>{t('comm.col.participants')}</th><th>消息数</th><th>最后消息</th><th>时间</th></tr></thead><tbody>
          {convs.map((c: any) => (<tr key={c.conversation_id} {...interactiveProps(activeConv === c.conversation_id)} style={{cursor:"pointer",background: activeConv === c.conversation_id ? "var(--bg-hover)" : undefined}} onClick={() => openConv(c.conversation_id)}><td className="nowrap" style={{fontSize:"var(--fs-sm)"}}>{(c.participant_ids || []).join(" ↔ ")}</td><td className="num">{c.message_count}</td><td style={{fontSize:"var(--fs-sm)",color:"var(--text-dim)",maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.last_message_preview || "—"}</td><td className="nowrap mono" style={{fontSize:"var(--fs-xs)"}}>{fmtT(c.last_message_at)}</td></tr>))}
          {convs.length === 0 && !loading && <tr><td colSpan={4} style={{padding: "var(--sp-4)",color:"var(--text-muted)",textAlign:"center"}}>暂无沟通会话</td></tr>}
        </tbody></table></div>
        <div style={{ flex: "0 0 54%", minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
          <div style={{ padding: "var(--sp-1-5) var(--sp-2-5)", borderBottom: "1px solid var(--border)", background: "var(--bg-surface2)", display: "flex", gap: "var(--sp-1-5)", alignItems: "center", flexWrap: "wrap", fontSize: "var(--fs-sm)" }}>
            <span style={{ color: "var(--text-dim)" }}>视角(靠右为本人):</span>
            {parts.map((p: string) => <button key={p} onClick={() => setViewAgent(p)} style={{ padding: "var(--sp-0-5) var(--sp-2)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: view === p ? "var(--primary)" : "transparent", color: view === p ? "var(--on-primary)" : "var(--text)", cursor: "pointer", fontWeight: view === p ? 600 : 400, fontSize: "var(--fs-sm)" }}>{shortName(p)}</button>)}
            {parts.length === 0 && <span style={{color:"var(--text-muted)"}}>—</span>}
          </div>
          <div style={{ flex: 1, overflowY: "auto", maxHeight: 520, padding: "var(--sp-3)", background: "var(--bg)" }}>
            {msgLoading && <div style={{color:"var(--text-dim)",fontSize:"var(--fs-base)"}}>加载中...</div>}
            {!activeConv && !msgLoading && <div style={{color:"var(--text-muted)",fontSize:"var(--fs-base)",textAlign:"center",padding: "var(--sp-7)"}}>← 点击左侧会话查看消息</div>}
            {messages.map((m: any, i: number) => {
              const from = mFrom(m) || "";
              const mine = !!from && from === view;
              return (<div key={i} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: "var(--sp-2-5)" }}>
                <div style={{ maxWidth: "76%" }}>
                  <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", marginBottom: "var(--sp-0-5)", textAlign: mine ? "right" : "left" }}>
                    <b>{from ? nameOf(from) : "—"}</b> · {mTime(m)}
                  </div>
                  <div style={{ fontSize: "var(--fs-base)", whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "var(--sp-2) var(--sp-3)", borderRadius: "var(--radius-md)", borderTopLeftRadius: mine ? 10 : 2, borderTopRightRadius: mine ? 2 : 10, background: mine ? "var(--primary)" : "var(--bg-surface2)", color: mine ? "var(--on-primary)" : "var(--text)", boxShadow: "0 1px 2px rgba(0,0,0,.06)" }}>{mText(m) || " "}</div>
                </div>
              </div>);
            })}
          </div>
        </div>
      </div></div>);
  }
}