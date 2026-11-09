"use client";
// 组织页签的交互内容 (2026-10-13 round 76-AC: 从 org/page.tsx 抽出)。
// 为什么要抽: 原 org/page.tsx 是客户端组件且**没有套 AgentShell** —— 于是该页签丢失了
//   面包屑/头部/对象页签, 且内容不在 layout-with-sidebar > main.main 容器里(页面塌陷)。
//   现在由服务端 org/page.tsx 取数并套 AgentShell, 这里只负责交互(部门/小组展示 + RBAC 授权)。
import { useEffect, useState } from "react";
import { Button, Input, Select, Tag } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
// 2026-11-05 P2 批9：内联 style 清零（10 -> 0），下沉到同目录 AgentOrgPanel.module.css；
//   提示行的成功 / 失败颜色改为 data-tone 属性选择器，其余为静态布局与三处输入宽度。
//   取数、接口、文案、授权字段与 props 形状未动；本组件不含表格。
import styles from "./AgentOrgPanel.module.css";

export default function AgentOrgPanel({ agentId }: { agentId: string }) {
  const [data, setData] = useState<any>(null);
  const [rbac, setRbac] = useState<any>(null);
  const [rt, setRt] = useState("");
  const [rk, setRk] = useState("");
  const [rp, setRp] = useState("read");
  const [msg, setMsg] = useState<string | null>(null);

  // 2026-10-13 round 76-DL: 接入全局刷新(本面板只挂载拉一次)。
  const gf = useGlobalNonce();
  const load = () => {
    fetch(`/api/org?_gf=${gf}`, { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setData(j); else setMsg("失败: " + (j.error || "加载失败")); }).catch((e) => setMsg("失败: " + String(e)));
    fetch("/api/rbac?agent=" + encodeURIComponent(agentId) + "&_gf=" + gf, { cache: "no-store" }).then((r) => r.json()).then((j) => j.ok && setRbac(j)).catch(() => {});
  };
  useEffect(() => { load(); }, [agentId, gf]);

  // 2026-10-13 round 76-AE: 加载失败时 msg 已写但被这个 early-return 吞掉 -> 永远显示"加载中"。改为把 msg 显示出来。
  if (!data) return <div className={"tiny " + styles.msg} data-tone={msg?.startsWith("失败") ? "crit" : undefined}>{msg || "加载组织数据…"}</div>;

  const flatten = (ns: any[]): any[] => ns.flatMap((n) => [n, ...flatten(n.children || [])]);
  const myDept = flatten(data.departments || []).find((d: any) => (d.agents || []).includes(agentId));
  const myGroups = (data.groups || []).filter((g: any) => g.members.some((m: any) => m.agentId === agentId));

  const grant = async () => {
    const r = await fetch("/api/rbac", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "grant", subjectType: "agent", subjectId: agentId, resourceType: rt, resourceKey: rk, permission: rp }) });
    const j = await r.json();
    setMsg(j.ok ? "已授权" : ("失败: " + (j.error || "")));
    if (j.ok) { setRt(""); setRk(""); load(); }
  };

  return (
    <div className={styles.wrap}>
      {msg ? <div className={"tiny " + styles.msg} data-tone={msg.startsWith("失败") ? "crit" : "ok"}>{msg}</div> : null}
      <div className={styles.grid}>
        <div className="panel"><div className="panel-header"><span className="panel-title">部门归属</span></div>
          {myDept ? <div><b>📁 {myDept.name}</b> <span className="tiny">({myDept.desc || ""})</span></div> : <div className="tiny">未加入部门（组织架构页可将智能体加入部门）</div>}
        </div>
        <div className="panel"><div className="panel-header"><span className="panel-title">所在小组</span></div>
          {myGroups.length === 0 ? <div className="tiny">未加入小组</div> : myGroups.map((g: any) => (
            <div key={g.id} className={styles.groupRow}><Tag className={styles.tagRight}>{g.name}</Tag><span className="tiny">({g.members.length} 成员)</span></div>
          ))}
        </div>
        <div className="panel"><div className="panel-header"><span className="panel-title">资源权限</span></div>
          <div className={styles.rbacBar}>
            <Input placeholder="资源类型" value={rt} onChange={(e: any) => setRt(e.target.value)} className={styles.inputType} />
            <Input placeholder="资源键" value={rk} onChange={(e: any) => setRk(e.target.value)} className={styles.inputKey} />
            <Select className={styles.selectPerm} value={rp} onChange={(v: any) => setRp(String(v))}
              options={[{ value: "read", label: "只读" }, { value: "write", label: "读写" }, { value: "exec", label: "执行" }, { value: "admin", label: "管理" }]} />
            <Button size="small" type="primary" disabled={!rt || !rk} onClick={grant}>授权</Button>
          </div>
          {(rbac?.resolved || []).length === 0 ? <div className="tiny">暂无资源权限</div> : (rbac.resolved || []).map((r: any) => (
            <div key={r.resourceType + r.resourceKey} className="tiny">{r.resourceType}/{r.resourceKey} · 允许 {r.allowed.map((p: string) => ({ read: "只读", write: "读写", exec: "执行", admin: "管理" }[p] || p)).join(", ")}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
