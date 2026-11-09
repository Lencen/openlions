"use client";
import { useEffect, useState } from "react";
import KPICard from "@/components/KPICard";
import { Alert } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import ConfirmWriteDialog, { type WriteChange } from "@/components/ConfirmWriteDialog";
import styles from "./page.module.css";

// 2026-11-05 P2 批8 呈现层：本页内联 style 清零 + 手写 .tbl 表换白名单 DataTable。
//   · 取数（/api/agent-permissions + 全局刷新 nonce）、字段名、路由与文案一条未动；
//   · 表内原来的「加载中...」「暂无业务服务密钥」两行交给 DataTable 的 loading / empty（四态不删）；
//   · 本页是客户端组件（"use client"），列里的加粗 / 色标才可以用 render 函数。

interface KeyRow { svc: string; active: number; revoked: number }

// 2026-11-09 · 0.4.40-04：本页原来纯只读。按 PLATFORM-WRITE-UX 增加**唯一一个**写操作：
//   「取消该服务的全部有效授权」。它天然是批量（N 个智能体），正好用规范 §3 的
//   「一次提交 >20 项时先展示前 20 项 + 另有 N 项」。写入走既有 POST /api/agent-permissions，不改后端。

export default function AuthPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // 2026-10-13 round 76-DL: 接入全局刷新(本页只挂载拉一次)。
  const gf = useGlobalNonce();
  // 0.4.40-04：批量取消授权的确认态（一次提交 N 项，N>20 时弹窗只列前 20）
  const [revokeSvc, setRevokeSvc] = useState<string | null>(null);
  const [acked, setAcked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogErr, setDialogErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 写入成功后重取（本页原先是"挂载拉一次"，没有 load 函数；用 nonce 触发同一段 useEffect）
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    fetch(`/api/agent-permissions?_gf=${gf}`, { cache: "no-store" })
      // 2026-10-13 round 76-AF: 原来不检查 r.ok —— 接口 500 时错误体不是数组, 被静默当成"无密钥", 用户看不到失败。
      .then((r) => { if (!r.ok) throw new Error("请求失败（状态码 " + r.status + "）"); return r.json(); }).then((d) => setAgents(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [gf, reloadKey]);

  // 每业务: 签发 key 数 (ACTIVE) + 取消数 (REVOKED)
  const svcStat: Record<string, { active: number; revoked: number }> = {};
  for (const a of agents) {
    for (const p of (a.permissions || [])) {
      const s = p.service_name;
      if (!svcStat[s]) svcStat[s] = { active: 0, revoked: 0 };
      if (p.status === "ACTIVE") svcStat[s].active++;
      else if (p.status === "REVOKED") svcStat[s].revoked++;
    }
  }
  const totalActive = Object.values(svcStat).reduce((s, v) => s + v.active, 0);
  const totalRevoked = Object.values(svcStat).reduce((s, v) => s + v.revoked, 0);

  // 2026-11-05 P2 批8：列定义与原 <thead> 逐列对应（业务服务 / 有效密钥 / 已取消 / 认证）。
  //   数值列改走 DataTable 的 align="right"（= 原来的 td.num 右对齐 + 等宽数字）。
  // 某业务服务下所有「ACTIVE」授权的智能体（批量取消的对象）
  const activeAgentsOf = (svc: string): string[] =>
    (agents || []).filter((a: any) => (a.permissions || []).some((p: any) => p.service_name === svc && p.status === "ACTIVE")).map((a: any) => a.agent_id);

  const rows: KeyRow[] = Object.entries(svcStat).map(([svc, v]) => ({ svc, active: v.active, revoked: v.revoked }));
  const columns: DataColumn<KeyRow>[] = [
    { key: "svc", title: "业务服务", render: (r) => <b>{r.svc}</b> },
    { key: "active", title: "有效密钥", align: "right", render: (r) => r.active },
    { key: "revoked", title: "已取消", align: "right", render: (r) => r.revoked },
    { key: "auth", title: "认证", render: () => <span className="badge badge-green">sk-mind</span> },
    // 2026-11-09 0.4.40-04：唯一写入口（批量取消），点击只开确认弹窗
    { key: "op", title: "操作", width: 120, render: (r) => (
      <button
        type="button"
        className={styles.revokeBtn}
        disabled={r.active === 0}
        title={r.active === 0 ? "没有有效授权可取消" : "取消该服务的全部有效授权（会二次确认）"}
        onClick={() => { setRevokeSvc(r.svc); setAcked(false); setDialogErr(null); }}
      >
        取消全部授权
      </button>
    ) },
  ];

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>业务与系统</span><span className="sep">/</span><span className="current">统一认证</span></div>
    <PageHeader><PageTitle>统一认证</PageTitle><div className="page-subtitle">平台密钥认证体系（每业务独立密钥）· 单点登录 / 角色权限预留</div></PageHeader>
    {error && <div className={styles.errorWrap}><Alert type="error" message="密钥数据加载失败" description={String(error).slice(0, 200)} /></div>}
    <div className="kpi-grid">
      <KPICard label="认证方式" value="接口密钥" />
      <KPICard label="有效密钥" value={String(totalActive)} />
      <KPICard label="已取消" value={String(totalRevoked)} />
      <KPICard label="业务服务" value={String(Object.keys(svcStat).length)} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">业务服务密钥签发状态（实时）</span></div>
      <TableCopyButton />
      <DataTable<KeyRow>
        columns={columns}
        rows={rows}
        loading={loading}
        empty={{ title: error ? "密钥数据加载失败（见上方提示）" : "暂无业务服务密钥" }}
      />
      <div className={styles.footNote}>
        Key 由接入审批签发 (勾选业务), 取消授权即失效。细粒度授权矩阵见 <a href="/system/permissions" className={styles.link}>权限管理</a>。
        单点登录 / 授权登录 / 目录账号与角色权限为非商业版预留（架构字段已存在）。
      </div>
    </div>

    {/* 2026-11-09 · 0.4.40-04：批量取消授权的二次确认（PLATFORM-WRITE-UX §1–§3、§5）。
        N 个智能体逐个提交；任一条失败即保留弹窗并把失败条数写清楚，不谎报"全部成功"。 */}
    <ConfirmWriteDialog
      open={!!revokeSvc}
      changes={revokeSvc ? activeAgentsOf(revokeSvc).map((aid) => ({
        field: "授权 · " + aid + " / " + revokeSvc,
        before: "ACTIVE（已授权）",
        after: "REVOKED（已取消）",
        change: "删除" as WriteChange["change"],
      })) : []}
      summary={revokeSvc ? "本次将取消该服务的 " + activeAgentsOf(revokeSvc).length + " 项授权，变更立即生效（相关密钥立即失效）。" : ""}
      risk="取消后这些智能体将无法调用该服务；恢复需重新授权并签发新密钥。"
      acknowledged={acked}
      onAcknowledge={setAcked}
      busy={busy}
      error={dialogErr}
      confirmText="确认取消授权"
      onCancel={() => { if (!busy) { setRevokeSvc(null); setDialogErr(null); } }}
      onConfirm={async () => {
        if (!revokeSvc) return;
        setBusy(true); setDialogErr(null);
        const targets = activeAgentsOf(revokeSvc);
        const failed: string[] = [];
        const auditIds: string[] = [];
        for (const aid of targets) {
          try {
            const r = await fetch("/api/agent-permissions", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "revoke", agent_id: aid, service_name: revokeSvc, confirm: true }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || j?.error) failed.push(aid + ": " + String(j?.error || r.status));
            else if (typeof j?.auditId === "string" && j.auditId) auditIds.push(j.auditId);
          } catch (e: any) {
            failed.push(aid + ": " + String(e?.message || e));
          }
        }
        if (failed.length) {
          // 规范 §5：失败保留弹窗与输入，展示错误原文；部分成功也如实说明
          setDialogErr("有 " + failed.length + "/" + targets.length + " 条未成功：" + failed.slice(0, 3).join("；") + (failed.length > 3 ? " 等" : ""));
          setBusy(false);
          return;
        }
        // 规范 §1.3：成功回显审计 id（后端现在按条返回 auditId）。批量时：全部有值才列全，
        //   部分缺值就说明"已记录 N/M 条"，不编造。
        const idText = auditIds.length === 0
          ? "审计已记录（接口未返回 id）"
          : auditIds.length === targets.length
            ? "审计记录 " + auditIds[0] + (auditIds.length > 1 ? " 等 " + auditIds.length + " 条" : "")
            : "审计记录 " + auditIds.length + "/" + targets.length + " 条（其余未返回 id）";
        setToast("已保存 · " + targets.length + " 项授权已取消 · " + idText);
        setRevokeSvc(null);
        setBusy(false);
        setReloadKey((k) => k + 1);
      }}
    />
    {toast ? <div className={styles.toast} role="status">{toast}<button type="button" className={styles.toastX} onClick={() => setToast(null)} aria-label="关闭提示">×</button></div> : null}
  </main></div>);
}
