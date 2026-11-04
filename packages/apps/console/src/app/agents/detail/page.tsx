"use client"
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数/状态与拼装 (<200 行)。
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { Suspense } from "react";
import DiscussionPanel from "@/components/DiscussionPanel";
import AgentHeader from "./_components/AgentHeader";
import AgentBaseInfo from "./_components/AgentBaseInfo";
import AgentServiceMatrix from "./_components/AgentServiceMatrix";
import AgentTierPanel from "./_components/AgentTierPanel";
import DataMoment from "@/components/DataMoment";

function AgentDetailInner() {
  const params = useSearchParams();
  // Phase0.5 (2026-09-17): 兼容 ?id= 别名 —— 复核确认部分入口/文档按 ?id= 跳转; 原只认 ?agentId=。
  const agentId = params.get("agentId") || params.get("id") || "agent-e";
  // 2026-10-13 round 76-DY: 解构 loading —— 业务授权矩阵要用它区分「还没加载」与「确实没有」。
  const { data, error, loading } = useApi<{result?:{data?:any}}>(`/api/agent-services?agent_id=${agentId}`);
  const { data: a, error: listError } = useApi<{result?:{data?:any[]}}|any[]>(`/api/agent-list`);
  // 2026-10-26 修：`/api/agent-list` 的响应体是 **{ ok, items, sources, asOf }**，
  //   而这里只认「裸数组」或「tRPC 透传 {result:{data}}」→ 永远取到 []，
  //   于是详情页的「基础信息」整块显示「—」、标题退化成 id、状态恒为「未知」。
  //   现在把三种形状都兼容（items / result.data / 裸数组）。
  const agents = Array.isArray(a) ? a : ((a as any)?.items ?? (a as any)?.result?.data ?? []);
  const me = agents.find((x:any)=>x.agent_id===agentId) ?? agents[0] ?? {};
  // 2026-09-14 关键修复(用户反馈"还是无法在 agent 详情中对 agent 权限进行调整"的真正根因):
  //   /api/agent-services 返回的是**裸数组**(实测: [{id:...,name:"lions_flywheel",...}]), 而这里
  //   一直按 data.result.data / data.services 取 —— 两条都不匹配, 于是 services 恒为空数组,
  //   业务授权矩阵永远显示"暂无可用业务服务", 用户看不到任何一行, 自然"没法调整权限"。
  const services = Array.isArray(data)
    ? data
    : ((data as any)?.result?.data?.json ?? (data as any)?.result?.data ?? (data as any)?.services ?? []);
  // 2026-09-07: 单业务授权管理 (grant/revoke)
  const [busySvc, setBusySvc] = useState<string | null>(null);
  const [opMsg, setOpMsg] = useState("");
  const actSvc = async (service_name: string, action: "grant" | "revoke") => {
    setBusySvc(service_name); setOpMsg("");
    try {
      const r = await fetch("/api/agent-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, agent_id: me.agent_id || agentId, service_name }),
      });
      const d = await r.json();
      if (d.error) setOpMsg(`⚠ ${d.error}`);
      else {
        setOpMsg(action === "grant" ? `✅ 已授权 ${service_name}` : `✅ 已取消 ${service_name} 授权`);
        setTimeout(() => window.location.reload(), 800);
      }
    } catch (e: any) { setOpMsg(`⚠ ${e.message}`); }
    finally { setBusySvc(null); }
  };
  // 2026-09-14 权限可编辑(用户反馈"无法在 agent 详情中对 agent 权限进行调整"):
  //   此前"权限"列是只读文本, 操作只有整服务"授权/取消授权"—— 后者还会**换发新 key**, 拿它改权限会让
  //   在跑的客户端立刻掉线。现在: 逐项勾选 + 保存, 走 set_permissions(**只改权限集合, 不换 key**)。
  const [permBusy, setPermBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [tierBusy, setTierBusy] = useState(false);
  const parseList = (v: any): string[] => {
    if (Array.isArray(v)) return v as string[];
    if (typeof v === "string" && v.trim()) {
      try { const j = JSON.parse(v); return Array.isArray(j) ? j : [v]; } catch { return v.split(",").map((s) => s.trim()).filter(Boolean); }
    }
    return [];
  };
  const draftOf = (name: string, current: string[]) => (draft[name] !== undefined ? draft[name] : current);
  const togglePerm = (name: string, current: string[], p: string) => {
    const cur = draftOf(name, current);
    setDraft({ ...draft, [name]: cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p] });
  };
  const savePerms = async (name: string, current: string[]) => {
    const perms = draftOf(name, current);
    setPermBusy(name); setOpMsg("");
    try {
      const r = await fetch("/api/agent-permissions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_permissions", agent_id: me.agent_id || agentId, service_name: name, permissions: perms }),
      });
      const d = await r.json();
      const err = d?.error;
      if (err) setOpMsg("⚠ " + (typeof err === "string" ? err : JSON.stringify(err)).slice(0, 300));
      else {
        setOpMsg(`✅ 已保存 ${name} 权限: ${perms.join(", ") || "(空)"} — 密钥未变更, 客户端无需重启`);
        setDraft({ ...draft, [name]: perms });
        setTimeout(() => window.location.reload(), 900);
      }
    } catch (e: any) { setOpMsg("⚠ " + e.message); }
    finally { setPermBusy(null); }
  };
  const profile = (() => { try { return me.profile ? JSON.parse(String(me.profile)) : {}; } catch { return {}; } })();
  const curTier: number | null = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const TIERS = ["T0 纯文本(只能产出文本)", "T1 只读查证(可读平台数据核验)", "T2 提案式写(可建候选/开任务)", "T3 直接写(可改代码/查库/部署)"];
  const saveTier = async (t: number) => {
    setTierBusy(true); setOpMsg("");
    try {
      const r = await fetch("/api/agent-permissions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_tier", agent_id: me.agent_id || agentId, tier: t, reason: "console 详情页手工设置" }),
      });
      const d = await r.json();
      if (d?.error) setOpMsg("⚠ " + String(d.error).slice(0, 300));
      else { setOpMsg(`✅ 能力分级已设为 ${TIERS[t]} — 立即影响能否认领 [机制修复] 类任务`); setTimeout(() => window.location.reload(), 900); }
    } catch (e: any) { setOpMsg("⚠ " + e.message); }
    finally { setTierBusy(false); }
  };
  const permMap: Record<string, any> = {};
  for (const p of (me.permissions ?? [])) permMap[p.service_name] = p;
  return (<div className="layout-with-sidebar"><main className="main">
    <AgentHeader me={me} agentId={agentId} />
    {/* 2026-10-16 round 77-AH（决策③逐源 + 77-M 清单最后一项）: 本页有 **2 个源** ——
        /api/agent-list（智能体本体, 顶层有 asOf）与 /api/agent-services（业务授权矩阵）。
        后者按上面第 24 行自己写明的：返回的是**裸数组** ✗ -> 加不了顶层键,
        故按 77-AB 建立的口径**显式传 null 让它显示「未知」**, 绝不借用 agent-list 的时刻 ✓。 */}
    <div className="tiny" style={{ textAlign: "right", color: "var(--text-dim)" }}>
      <DataMoment
        items={[
          { label: "智能体", at: (a as any)?.asOf },
          { label: "业务授权", at: Array.isArray(data) ? null : (data as any)?.asOf },
        ]}
        style={{ marginLeft: 0 }}
      />
    </div>
    <div style={{ marginBottom: "var(--sp-3)" }}>
      <Link href={`/terminals/detail?agent_id=${encodeURIComponent(agentId)}`} style={{ color: "var(--primary)", fontSize: "var(--fs-sm)" }}>
        查看终端详情（12 层信息结构）→
      </Link>
    </div>
    {(error || listError) && <div style={{ marginBottom: "var(--sp-3)" }}><Alert type="error" message="智能体详情加载失败" description={String(((error || listError) as Error)?.message || (error || listError)).slice(0, 200)} /></div>}
    <div className="grid-2">
      <AgentBaseInfo me={me} agentId={agentId} />

      <AgentServiceMatrix
        loading={loading}
        services={services}
        permMap={permMap}
        parseList={parseList}
        draftOf={draftOf}
        togglePerm={togglePerm}
        savePerms={savePerms}
        actSvc={actSvc}
        busySvc={busySvc}
        permBusy={permBusy}
        opMsg={opMsg}
        me={me}
        agentId={agentId}
      />

      {/* 2026-09-14 新增: 能力分级 T0-T3 的可视化编辑(此前只有 seed 脚本能写, 详情页无从调整) */}
      <AgentTierPanel
        curTier={curTier}
        TIERS={TIERS}
        profile={profile}
        tierBusy={tierBusy}
        saveTier={saveTier}
        me={me}
        agentId={agentId}
      />
    </div>
    {/* 2026-09-10: 通用讨论模块 (针对该 agent 的沟通记录) */}
    <DiscussionPanel entityType="agent" entityId={me.agent_id || agentId} title="智能体讨论与协作" />
    {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/agents">全部智能体 →</Link>
      <Link href="/system/permissions">业务授权矩阵 →</Link>
    </div>
  </main></div>);
}

export default function AgentDetailPage() {
  return (<Suspense fallback={<div>加载中...</div>}><AgentDetailInner /></Suspense>);
}
