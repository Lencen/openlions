"use client"
import { useState } from "react";
import Link from "next/link";
import { t } from "@/i18n";
import FlywheelFlow from "@/components/FlywheelFlow";
import TableCopyButton from "@/components/TableCopyButton";
export default function TransferPage() {
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setLoading(true); setError(""); setResult(null);
    try {
      const res = await fetch("/api/agent-transfer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromAgentId: fromId.trim(), toAgentId: toId.trim(), dryRun, force: !dryRun }),
      });
      const d = await res.json();
      const data = d?.result?.data || d;
      if (d?.error) throw new Error(d.error.message);
      setResult(data);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };
  const counts = result?.counts || result?.moved || {};
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>{t('transfer.crumb')}</span><span className="sep">/</span><span className="current">AI 离开/接手</span></div>
    <div className="page-header"><div className="page-title">AI 离开/接手</div><div className="page-subtitle">权限转移 + 数据继承 + 无中断切换</div></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">接手流程</span></div>
      <FlywheelFlow steps={[{label:"AI 离开"},{label:"权限转移",active:true},{label:"数据继承",active:true},{label:"新 AI 接手"},{label:"无中断切换",active:true}]}/>
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">{t('transfer.inherit.title')}</span></div>
      <div style={{display:"flex",gap: "var(--sp-3)",marginBottom: "var(--sp-3)",flexWrap:"wrap"}}>
        <input value={fromId} onChange={e=>setFromId(e.target.value)} placeholder={t('transfer.from')} style={{padding: "var(--sp-2) var(--sp-3)",borderRadius: "var(--radius-sm)",border:"1px solid var(--border)",background:"var(--bg-surface)",color:"var(--text)",minWidth:180}} />
        <span style={{alignSelf:"center",color:"var(--text-dim)"}}>→</span>
        <input value={toId} onChange={e=>setToId(e.target.value)} placeholder={t('transfer.to')} style={{padding: "var(--sp-2) var(--sp-3)",borderRadius: "var(--radius-sm)",border:"1px solid var(--border)",background:"var(--bg-surface)",color:"var(--text)",minWidth:180}} />
        <label style={{alignSelf:"center",display:"flex",alignItems:"center",gap: "var(--sp-1-5)",color:"var(--text-dim)",fontSize: "var(--fs-md)"}}>
          <input type="checkbox" checked={dryRun} onChange={e=>setDryRun(e.target.checked)} /> 仅预览（不写入）
        </label>
        <button onClick={submit} disabled={loading || !fromId || !toId} style={{padding: "var(--sp-2) var(--sp-4)",borderRadius: "var(--radius-sm)",background:dryRun?"var(--primary)":"var(--status-crit)",border:"none",color:"var(--on-primary)",cursor:"pointer",opacity:loading||!fromId||!toId?0.5:1}}>
          {loading ? "处理中..." : dryRun ? "预览迁移" : "执行迁移"}
        </button>
      </div>
      {error && <div style={{color:"var(--status-crit)",fontSize: "var(--fs-md)",marginBottom: "var(--sp-2)"}}>{error}</div>}
      {result && <div style={{fontSize: "var(--fs-md)"}}>
        <div style={{color:"var(--text-dim)",marginBottom: "var(--sp-1-5)"}}>状态: <strong style={{color:result.status==="done"?"var(--status-ok)":"var(--text)"}}>{result.status}</strong>
          {result.status==="done" && <> · {result.fromAgentId} → {result.toAgentId} · 共 <strong>{result.total}</strong> 条</>}
          {result.status==="preview" && <> · {result.fromAgentId} → {result.toAgentId} · 将迁移 <strong>{result.total}</strong> 条</>}
        </div>
        <TableCopyButton />
        <table className="tbl"><thead><tr><th>表</th><th>条数</th></tr></thead><tbody>
          {Object.entries(counts).map(([k,v]: any) => (<tr key={k}><td>{k}</td><td className="num">{Number(v).toLocaleString()}</td></tr>))}
        </tbody></table>
      </div>}
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">历史记录</span>
      {/* 2026-10-13 round 76-CQ: 这张表里那行是**硬编码的静态记录**(平台还没有转移历史的查询接口),
          而原页面把它渲染成一张普通历史表 —— 用户会以为这是**实时历史**。
          这里显式标注来源, 不把静态数据当实时数据。(要真正展示历史, 需先有历史记录接口。) */}
      <span className="tiny" style={{ color: "var(--text-dim)", fontWeight: 400 }}>静态记录 · 转移历史自动记录尚未接入</span></div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>事件</th><th>{t('transfer.col.from')}</th><th>{t('transfer.col.to')}</th><th>时间</th><th>状态</th></tr></thead><tbody>
        <tr><td>继承</td><td className="nowrap">ut (阿泰)</td><td className="nowrap">leo (leo)</td><td className="nowrap">2026-07-30</td><td><span className="badge badge-green">完成</span></td></tr>
      </tbody></table></div>
    {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/agents">智能体总览 →</Link>
      <Link href="/system/permissions">业务授权矩阵 →</Link>
    </div>
  </main></div>);
}