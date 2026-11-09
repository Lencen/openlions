"use client";
// 2026-10-26 K 的 agent key 审批页（老板排期后落地）。
// 必须与 /agents/approvals 分清楚（那条线是「服务授权」）：
//   本页 = key 生命周期（机器身份 / 管理身份、TTL、轮换、401 排障）。
// 文案全部来自后端（scopeLabel / permissions[].label+why / impact），前端只渲染、不编词。
import { useCallback, useEffect, useState } from "react";
import { Button, Modal } from "@/components/primitives";
import { Pill, StateBlock } from "@/components/ui";
import DataTable, { StateChip } from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { humanError } from "@/lib/humanError";
import { fmtNum, fmtStamp, relTime } from "@/lib/format";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
// 2026-11-05 P2 批8：内联 style 清零 + 手写 .tbl 表换白名单 DataTable（列只留纯数据，单元格预先算好）；
//   取数（/api/agent-keys/*）、字段、文案、审批流程与二次确认弹窗语义未动。
import styles from "./page.module.css";

interface KeyPerm { id: string; label: string; risk?: string; why?: string; dailyRequired?: boolean }
interface KeyReq {
  requestId: string; agentId: string; requestedAt?: string | null;
  scope: string; scopeLabel?: string; permissions?: KeyPerm[];
  impact?: string; requiresHumanConfirm?: boolean; expiresInDays?: number; note?: string;
}
interface PendingResp { ok?: boolean; items?: KeyReq[]; contractVersion?: string; error?: string }
interface StatusResp {
  ok?: boolean; agentId?: string; scopeLabel?: string; scope?: string; keyId?: string; status?: string;
  expiresAt?: string | null; nextRotationAt?: string | null; autoRenew?: boolean; defaultTtlDays?: number;
  auth401Recent?: { at?: string; path?: string }[]; observed?: { lastSeenAt?: string; lastPath?: string };
  error?: string;
}

const RISK_TONE: Record<string, "ok" | "warn" | "crit" | "mute"> = { low: "mute", medium: "warn", high: "crit" };
const RISK_LABEL: Record<string, string> = { low: "低风险", medium: "中风险", high: "高风险" };

// 2026-11-05 P2 批8：待审批表改为「纯数据列 + 单元格 ReactNode」—— 列定义与行数据都在本文件预算好，
//   不给 DataTable 传 render/rowKey/onRow 等函数 props（客户端页虽允许，但保持零函数 props 更稳）。
//   单元格的 class（mono/nowrap/key-scope/key-perms/key-impact）与改前一一对应。
type KeyRow = {
  agentId: React.ReactNode;
  requestedAt: React.ReactNode;
  scope: React.ReactNode;
  permissions: React.ReactNode;
  impact: React.ReactNode;
  expiresInDays: React.ReactNode;
  actions: React.ReactNode;
};
const KEY_COLUMNS: DataColumn<KeyRow>[] = [
  { key: "agentId", title: "申请方" },
  { key: "requestedAt", title: "申请时间" },
  { key: "scope", title: "身份" },
  { key: "permissions", title: "要的权限" },
  { key: "impact", title: "影响面" },
  { key: "expiresInDays", title: "有效期", align: "right" },
  { key: "actions", title: "操作", width: 150 },
];

export default function AgentKeysPage() {
  const [data, setData] = useState<PendingResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  // 二次确认 / 拒绝弹窗共用
  const [dlg, setDlg] = useState<{ req: KeyReq; mode: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const [ttl, setTtl] = useState<string>("");

  const [statusAgent, setStatusAgent] = useState("");
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/agent-keys/pending", { cache: "no-store" });
      const j = (await r.json()) as PendingResp;
      if (!r.ok) throw new Error(j?.error || "取待审批列表失败");
      setData(j); setErr(null);
    } catch (e) {
      setErr(humanError(e, "待审批列表"));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const askStatus = async (agentId: string) => {
    setStatusErr(null); setStatus(null);
    if (!agentId.trim()) { setStatusErr("先填一个执行体名，例如 agent-f"); return; }
    try {
      const r = await fetch("/api/agent-keys/status?agent_id=" + encodeURIComponent(agentId.trim()), { cache: "no-store" });
      const j = (await r.json()) as StatusResp;
      if (!r.ok) throw new Error(j?.error || "查询失败");
      setStatus(j);
    } catch (e) { setStatusErr(humanError(e, "钥匙状态")); }
  };

  const submit = async () => {
    if (!dlg) return;
    setBusy(dlg.req.requestId); setErr(null); setResult(null); setWarn(null);
    try {
      const body: any = { requestId: dlg.req.requestId, decision: dlg.mode, note: note.trim() };
      if (dlg.mode === "approve") {
        body.confirm = true;                        // 前端弹窗即二次确认；后端也强制校验
        if (ttl && Number.isFinite(Number(ttl))) body.ttlDays = Number(ttl);
      }
      const r = await fetch("/api/agent-keys/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "审批失败");
      if (dlg.mode === "approve") {
        // 后端 approve 可能是"静默空操作"（见 BFF 注释）：有 warning 时**不许**报成功。
        if (j.warning) setWarn(String(j.warning));
        else {
          // 2026-10-27：approve 回包此前没有 expiresInDays（与 pending 列表不对称，后端已补）。
          //   有就显示天数（用户看得懂"还有多久"），没有就只显示日期，不编造。
          const days = typeof j.expiresInDays === "number" ? `（还剩 ${j.expiresInDays} 天）` : "";
          setResult(`已批准 ${dlg.req.agentId} 的钥匙：到期 ${fmtStamp(j.expiresAt) || "—"}${days}，下次轮换 ${fmtStamp(j.nextRotationAt) || "—"}；同一把 key 立即生效，无需重启。`);
        }
      } else {
        setResult(`已拒绝 ${dlg.req.agentId} 的申请（${dlg.req.requestId}）。`);
      }
      setDlg(null); setNote(""); setTtl("");
      await load();
    } catch (e) {
      setErr(humanError(e, "审批动作"));
    } finally { setBusy(null); }
  };

  const items = data?.items || [];

  // 2026-11-05 P2 批8：待审批行的单元格在此预算成 ReactNode（列见文件头 KEY_COLUMNS）。
  //   与改前 <td> 一一对应：mono / nowrap / key-scope / key-perms / key-impact / 操作列不换行。
  const keyRows: KeyRow[] = items.map((it) => ({
    agentId: <span className="mono">{it.agentId}</span>,
    requestedAt: <span className="nowrap">{it.requestedAt ? relTime(it.requestedAt) : "—"}</span>,
    scope: (
      <>
        <div className="key-scope">{it.scopeLabel || it.scope || "—"}</div>
        {it.requiresHumanConfirm ? <div className="tiny key-danger">需要人工确认</div> : null}
      </>
    ),
    permissions: (
      <div className="key-perms">
        {(it.permissions || []).map((p) => (
          <span key={p.id} title={p.why || ""}>
            <Pill tone={RISK_TONE[String(p.risk || "").toLowerCase()] || "mute"}>{p.label}</Pill>
          </span>
        ))}
        {!it.permissions?.length ? <span className="tiny">—</span> : null}
      </div>
    ),
    impact: <div className="key-impact">{it.impact || "—"}</div>,
    expiresInDays: <span className="nowrap">{it.expiresInDays != null ? fmtNum(it.expiresInDays) + " 天" : "—"}</span>,
    actions: (
      <span className={styles.actionsCell}>
        <Button size="small" type="primary" ghost disabled={busy === it.requestId}
          onClick={() => { setDlg({ req: it, mode: "approve" }); setNote(""); setTtl(String(it.expiresInDays || "")); }}>
          批准
        </Button>
        <Button size="small" className={styles.rejectBtn} disabled={busy === it.requestId}
          onClick={() => { setDlg({ req: it, mode: "reject" }); setNote(""); }}>
          拒绝
        </Button>
      </span>
    ),
  }));

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb"><span className={styles.crumbDim}>智能体</span><span className="sep">/</span><span className="current">钥匙审批</span></div>
      <PageHeader>
        <PageTitle>钥匙审批{items.length ? <StateChip state="warn" text={`${items.length} 条待处理`} /> : null}</PageTitle>
        <div className="page-subtitle">
          批准这把钥匙 = 允许它「开线、发凭证、改归属、看全局、代发通知」；日常收发消息不需要这把。
          与「接入审批」（服务授权）是两件事：这里管的是 key 本身的生命周期。
          {data?.contractVersion ? <span className={"tiny " + styles.contractTag}>契约 {data.contractVersion}</span> : null}
        </div>
      </PageHeader>

      {warn ? <div className="data-health" data-state="warn"><span className="dh-text">{warn}</span></div> : null}
      {err ? <div className="data-health" data-state="crit"><span className="dh-text">{err}</span></div> : null}
      {result ? <div className="data-health" data-state="ok"><span className="dh-text">{result}</span></div> : null}

      <DetailLikeSection title={`待审批（${items.length}）`}>
        {loading ? <StateBlock loading rows={3} /> : items.length === 0 ? (
          <div className="empty-quiet">
            当前没有待审批的钥匙申请。若某个执行体申请了更高身份，这里会出现一条记录（含它要的权限与影响面）。
          </div>
        ) : (
          <DataTable columns={KEY_COLUMNS} rows={keyRows} />
        )}
      </DetailLikeSection>

      <DetailLikeSection title="钥匙状态（排障）">
        <div className="key-status-bar">
          <input className="dt-input" value={statusAgent} onChange={(e) => setStatusAgent(e.target.value)}
            placeholder="输入执行体名（见智能体总览）" aria-label="执行体名" />
          <Button size="small" onClick={() => askStatus(statusAgent)}>查询</Button>
          <span className="tiny">查身份、到期时间、自动续期与最近的鉴权失败</span>
        </div>
        {statusErr ? <div className={"data-health " + styles.mtLabel} data-state="crit"><span className="dh-text">{statusErr}</span></div> : null}
        {status?.ok ? (
          <dl className={"dt-fields " + styles.statusFields}>
            <div className="dt-field"><dt>身份</dt><dd>{status.scopeLabel || status.scope || "—"}</dd></div>
            <div className="dt-field"><dt>状态</dt><dd>{status.status || "—"}</dd></div>
            <div className="dt-field"><dt>到期</dt><dd>{fmtStamp(status.expiresAt) || "—"}</dd></div>
            <div className="dt-field"><dt>下次轮换</dt><dd>{fmtStamp(status.nextRotationAt) || "—"}</dd></div>
            <div className="dt-field"><dt>自动续期</dt><dd>{status.autoRenew ? "是" : "否"}</dd></div>
            <div className="dt-field"><dt>默认 TTL</dt><dd>{status.defaultTtlDays != null ? status.defaultTtlDays + " 天" : "—"}</dd></div>
            <div className="dt-field"><dt>最近活跃</dt><dd>{status.observed?.lastSeenAt ? fmtStamp(status.observed.lastSeenAt) : "—"}</dd></div>
            <div className="dt-field"><dt>最近 401</dt><dd>{status.auth401Recent?.length ? `${status.auth401Recent.length} 次（最近 ${fmtStamp(status.auth401Recent[0]?.at)}）` : "无"}</dd></div>
          </dl>
        ) : null}
      </DetailLikeSection>

      <Modal open={!!dlg} title={dlg?.mode === "approve" ? "确认批准这把钥匙" : "拒绝这把钥匙的申请"}
        onCancel={() => { setDlg(null); setNote(""); }} onOk={submit}
        okText={dlg?.mode === "approve" ? "确认批准（立即生效）" : "确认拒绝"} cancelText="取消">
        {dlg ? (
          <div className="key-dialog">
            <div className="key-dialog-row"><span>申请方</span><b className="mono">{dlg.req.agentId}</b></div>
            <div className="key-dialog-row"><span>身份</span><b>{dlg.req.scopeLabel || dlg.req.scope}</b></div>
            <div className="key-dialog-impact" data-tone={dlg.req.requiresHumanConfirm ? "crit" : "mute"}>
              <div className="key-dialog-impact-title">影响面（后端原文）</div>
              <div>{dlg.req.impact || "后端未提供影响面描述"}</div>
            </div>
            {dlg.mode === "approve" ? (
              <>
                <div className="key-dialog-row"><span>有效期（天）</span>
                  <input className="dt-input" value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder={String(dlg.req.expiresInDays || 90)} aria-label="有效期天数" />
                </div>
                <div className="tiny">批准后<b>同一把 key 立即生效</b>（缓存全量失效），不需要重启或等待。</div>
              </>
            ) : null}
            <label className="key-dialog-note">
              <span>{dlg.mode === "reject" ? "拒绝理由（必填，进审计）" : "备注（可选）"}</span>
              <textarea className="dt-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder={dlg.mode === "reject" ? "例：日常收发不需要管理身份，请先说明用途" : "例：已核对工单 #123"} />
            </label>
          </div>
        ) : null}
      </Modal>
    </main></div>
  );
}

/** 轻量区块壳（与详情页 DetailSection 视觉一致，但本页在列表语境下不需要引入详情命名空间） */
function DetailLikeSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="dt-section">
      <header className="dt-section-head"><h3 className="dt-section-title">{title}</h3></header>
      <div className="dt-section-body">{children}</div>
    </section>
  );
}
