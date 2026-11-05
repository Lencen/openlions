"use client";
// 组织架构 (2026-09-21 重做, 用户规格): Tab[组织架构|小组]
//   组织架构: 部门树(根=平台名, 每级 [+][-]), 点部门右侧=部门信息+agent列表(进详情/移出/添加)
//   小组: 与组织同级, 右上角添加(按条件(平台/终端/IP/岗位/模型)或手动), 组信息+成员+添加agent
import { useEffect, useState } from "react";
import KPICard from "@/components/KPICard";
import { useUrlParam } from "@/lib/useUrlParam";
import Link from "next/link";
import { Button, Input, Modal, Segmented, Select, Tag } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

interface OrgData { departments: any[]; groups: any[]; agents: any[]; platformName?: string }
const EMPTY: OrgData = { departments: [], groups: [], agents: [], platformName: "lions" };

export default function OrgPage() {
  const [data, setData] = useState<OrgData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  // 2026-10-19 B3: 页签进 URL —— 该页原无任何 URL API, "我在看组织架构还是小组"没法分享/回退 ✗
  const [tab, setTab] = useUrlParam("tab", "dept");
  // 部门树
  const [selectedDept, setSelectedDept] = useState<any | null>(null);
  const [deptInput, setDeptInput] = useState<{ parent: string; name: string } | null>(null);
  const [pickAgentFor, setPickAgentFor] = useState<{ type: "dept" | "group"; id: string; existing: string[] } | null>(null);
  const [pickAgentSel, setPickAgentSel] = useState<string[]>([]);
  // 小组
  const [groupModal, setGroupModal] = useState(false);
  const [gName, setGName] = useState("");
  const [gDesc, setGDesc] = useState("");
  const [gMode, setGMode] = useState<"manual" | "condition">("manual");
  const [gCond, setGCond] = useState<any>({});

  // 2026-10-13 round 76-DL: 接入全局刷新(本页只挂载拉一次)。
  const gf = useGlobalNonce();
  const load = async () => {
    try { const r = await fetch(`/api/org?_gf=${gf}`, { cache: "no-store" }); const j = await r.json(); // 2026-10-13 (round 74-Y): 原来 if(j.ok) setData(j) 之后 catch (e) { setMsg("失败: " + String(e)); } 吞掉一切 -> ok:false 与网络/解析失败
      //   在界面上**完全不可见**(页面像"没有数据")。复用本页既有的 msg 通道显示失败, 不新增 JSX。
      if (j.ok) setData(j); else setMsg("失败: " + (j.error || "加载失败")); }
    catch (e) { setMsg("失败: " + String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [gf]);

  const post = async (body: any, okMsg: string, then?: () => void) => {
    const r = await fetch("/api/org", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    setMsg(j.ok ? okMsg : ("失败: " + (j.error || "")));
    if (j.ok) { then && then(); load(); }
  };

  const flattenDept = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...flattenDept(n.children || [])]);
  const allDepts = flattenDept(data.departments || []);
  const agentLabel = (id: string) => { const a = (data.agents || []).find((x: any) => x.agent_id === id); return a ? (a.display_name + " (" + a.agent_id + ")") : id; };

  // ===== 部门树 =====
  const renderDeptNode = (d: any, depth: number): any => (
    <div key={d.id} style={{ marginLeft: `calc(var(--sp-4) * ${depth})` }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)", padding: "var(--sp-1)", cursor: "pointer", borderRadius: "var(--radius-sm)",
        background: selectedDept?.id === d.id ? "var(--primary-dim)" : "transparent", fontSize: "var(--fs-md)" }}
        onClick={() => setSelectedDept(d)}>
        <span>📁 {d.name}</span><span className="tiny">({d.agentCount})</span>
        <Button size="small" type="link" style={{ padding: "0 var(--sp-1)" }} title="新增子部门" onClick={(e: any) => { e.stopPropagation(); setDeptInput({ parent: d.id, name: "" }); }}>＋</Button>
        <Button size="small" type="link" style={{ padding: "0 var(--sp-1)", color: "var(--status-crit)" }} title="删除该部门及其子部门"
          onClick={(e: any) => { e.stopPropagation(); if (confirm("删除部门「" + d.name + "」将连同其全部子部门一并删除，确认？")) post({ kind: "deleteDepartment", id: d.id }, "已删除"); }}>－</Button>
      </div>
      {d.children && d.children.map((c: any) => renderDeptNode(c, depth + 1))}
    </div>
  );

  const openPickAgent = (type: "dept" | "group", id: string, existing: string[]) => {
    setPickAgentFor({ type, id, existing }); setPickAgentSel([]);
  };
  const confirmPickAgent = () => {
    if (!pickAgentFor) return;
    const kind = pickAgentFor.type === "dept" ? "deptMember" : "groupMember";
    for (const a of pickAgentSel) post({ kind, agentId: a, departmentId: pickAgentFor.type === "dept" ? pickAgentFor.id : undefined, groupId: pickAgentFor.type === "group" ? pickAgentFor.id : undefined }, "已添加");
    setPickAgentFor(null);
  };

  const availableForPick = (pickAgentFor ? (data.agents || []).filter((a: any) => !pickAgentFor!.existing.includes(a.agent_id)) : []);

  return (
    <main className="page">
      <PageHeader><PageTitle>组织架构</PageTitle>
        <div className="page-subtitle">部门树（根 = 平台「{data.platformName || "lions"}」）· 小组（按条件或手动）</div></PageHeader>
      {msg ? <div className="tiny" style={{ color: msg.startsWith("失败") ? "var(--status-crit)" : "var(--status-ok)", marginBottom: "var(--sp-2)" }}>{msg}</div> : null}
      <div style={{ marginBottom: "var(--sp-3)" }}>
        <Segmented options={[{ label: "组织架构", value: "dept" }, { label: "小组", value: "group" }]} value={tab} onChange={(v) => setTab(v as "dept" | "group")} />
      </div>      {/* 2026-10-19 B4: 修前首屏大号数字 **0 个** ✗(只有一棵树)。补 ≤3 张: 部门/小组/智能体 ✓ */}
      <div className="kpi-grid" style={{ marginBottom: "var(--sp-3)" }}>
        <KPICard label="部门（个）" value={data.departments.length} delta={data.platformName || "lions"} />
        <KPICard label="小组（个）" value={data.groups.length} delta="手动或按条件" />
        <KPICard label="智能体（个）" value={data.agents.length} delta="平台在册" />
      </div>

      {loading ? <div className="tiny">加载中…</div> : tab === "dept" ? (
        <div style={{ display: "grid", gap: "var(--sp-4)", gridTemplateColumns: "320px 1fr" }}>
          <div className="panel"><div className="panel-header"><span className="panel-title">部门树</span>
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setDeptInput({ parent: "", name: "" })}>＋ 根部门</Button></div>
            {(data.departments || []).map((d: any) => renderDeptNode(d, 0))}
            {data.departments.length === 0 && <div className="tiny">暂无部门（平台名「{data.platformName || "lions"}」为根）</div>}
          </div>
          <div className="panel">
            {selectedDept ? (
              <>
                <div className="panel-header"><span className="panel-title">📁 {selectedDept.name}</span>
                  <Button size="small" type="primary" onClick={() => openPickAgent("dept", selectedDept.id, selectedDept.agents || [])}>＋ 添加智能体</Button></div>
                <div style={{ display: "grid", gap: "var(--sp-2)", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", marginBottom: "var(--sp-3)" }} className="tiny">
                  <span>标识 <span className="mono">{selectedDept.id}</span></span>
                  <span>名称 {selectedDept.name}</span>
                  <span>智能体 {selectedDept.agentCount} 个</span>
                  <span>说明 {selectedDept.desc || "—"}</span>
                </div>
                {selectedDept.agents && selectedDept.agents.length ? selectedDept.agents.map((a: string) => (
                  <div key={a} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "var(--sp-1) var(--sp-2)", borderBottom: "1px solid var(--border)", fontSize: "var(--fs-md)" }}>
                    <Tag style={{ marginInlineEnd: 0 }}>{a}</Tag><span className="tiny">{agentLabel(a)}</span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: "var(--sp-2)" }}>
                      <Link href={"/agents/" + encodeURIComponent(a) + "/overview"} className="tiny">详情 →</Link>
                      <Button size="small" type="link" style={{ padding: 0, color: "var(--status-crit)" }} onClick={() => post({ kind: "deptMemberRemove", agentId: a, departmentId: selectedDept.id }, "已移出")}>移出</Button>
                    </span>
                  </div>
                )) : <div className="tiny">该部门暂无智能体，点「＋ 添加智能体」加入</div>}
              </>
            ) : <div className="tiny">点击左侧部门查看智能体列表</div>}
          </div>
        </div>
      ) : (
        <div className="panel"><div className="panel-header"><span className="panel-title">小组</span>
          <Button size="small" type="primary" onClick={() => setGroupModal(true)}>＋ 添加小组</Button></div>
          {(data.groups || []).length === 0 ? <div className="tiny">暂无小组</div> : (data.groups || []).map((g: any) => (
            <div key={g.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "var(--sp-3)", marginBottom: "var(--sp-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
                <b style={{ fontSize: "var(--fs-md)" }}>{g.name}</b>
                <span className="tiny">标识 <span className="mono">{g.id}</span></span>
                <span className="tiny">智能体 {g.members.length} 个</span>
                {g.conditions ? <Tag variant="outlined">条件组: {Object.entries(g.conditions).map(([k, v]) => k + "=" + String(v)).join(" ")}</Tag> : <Tag variant="outlined">手动组</Tag>}
                <span style={{ marginLeft: "auto" }}><Button size="small" type="primary" ghost onClick={() => openPickAgent("group", g.id, g.members.map((m: any) => m.agentId))}>＋ 添加智能体</Button></span>
              </div>
              <div className="tiny" style={{ margin: "var(--sp-2) 0" }}>说明: {g.desc || "—"}</div>
              <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
                {g.members.map((m: any) => <Tag key={m.agentId} style={{ marginInlineEnd: 0 }}>{m.agentId}{m.roleInGroup === "leader" ? " 👑" : ""}</Tag>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新增部门弹窗 */}
      <Modal open={!!deptInput} title="新增部门" onCancel={() => setDeptInput(null)} onOk={() => {
        if (!deptInput || !deptInput.name.trim()) return;
        post({ kind: "department", name: deptInput.name.trim(), parentId: deptInput.parent || null }, "部门已建"); setDeptInput(null);
      }} okText="创建">
        <Input placeholder="部门名称" value={deptInput?.name || ""} onChange={(e: any) => setDeptInput((d) => d ? { ...d, name: e.target.value } : d)} autoFocus />
      </Modal>

      {/* 选择智能体弹窗 */}
      <Modal open={!!pickAgentFor} title={"选择智能体加入" + (pickAgentFor?.type === "dept" ? "部门" : "小组")} onCancel={() => setPickAgentFor(null)} onOk={confirmPickAgent} okText="加入">
        <div style={{ maxHeight: 320, overflow: "auto" }}>
          {availableForPick.length === 0 ? <div className="tiny">没有可添加的智能体</div> : availableForPick.map((a: any) => (
            <label key={a.agent_id} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "var(--sp-1) 0", fontSize: "var(--fs-md)" }}>
              <input type="checkbox" checked={pickAgentSel.includes(a.agent_id)}
                onChange={() => setPickAgentSel((s) => s.includes(a.agent_id) ? s.filter((x) => x !== a.agent_id) : [...s, a.agent_id])} />
              {agentLabel(a.agent_id)}
            </label>
          ))}
        </div>
      </Modal>

      {/* 添加小组弹窗 */}
      <Modal open={groupModal} title="添加小组" onCancel={() => setGroupModal(false)} onOk={() => {
        if (!gName.trim()) return;
        const conditions = gMode === "condition" ? gCond : null;
        post({ kind: "group", name: gName.trim(), desc: gDesc, conditions, manual: gMode === "manual" }, "小组已建");
        setGroupModal(false); setGName(""); setGDesc(""); setGCond({});
      }} okText="创建" width={520}>
        <div style={{ display: "grid", gap: "var(--sp-2)" }}>
          <Input placeholder="小组名称" value={gName} onChange={(e: any) => setGName(e.target.value)} />
          <Input placeholder="说明描述" value={gDesc} onChange={(e: any) => setGDesc(e.target.value)} />
          <Segmented options={[{ label: "手动添加", value: "manual" }, { label: "按条件创建", value: "condition" }]} value={gMode} onChange={(v) => setGMode(v as "manual" | "condition")} />
          {gMode === "condition" ? (
            <div style={{ display: "grid", gap: "var(--sp-2)", gridTemplateColumns: "1fr 1fr" }}>
              {(["channel", "host", "ip", "position", "model"] as const).map((c) => (
                <div key={c}><label className="tiny">{c}</label>
                  <Input placeholder={"条件值" + (c === "channel" ? "（AI 平台）" : c === "host" ? "（终端）" : c === "ip" ? "（IP 段）" : c === "position" ? "（岗位）" : "（模型）")}
                    value={gCond[c] || ""} onChange={(e: any) => setGCond((q) => ({ ...q, [c]: e.target.value }))} /></div>
              ))}
            </div>
          ) : <div className="tiny">创建后从右侧小组列表「＋ 添加智能体」选择成员</div>}
        </div>
      </Modal>
      {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/agents">智能体总览 →</Link>
        <Link href="/system/permissions">业务授权矩阵 →</Link>
      </div>
    </main>
  );
}