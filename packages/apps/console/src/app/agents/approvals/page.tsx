"use client";
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useEffect, useState } from "react";
import Link from "next/link";
import KPICard from "@/components/KPICard";
import ApprovalsHeader from "./_components/ApprovalsHeader";
import PendingApprovalsTable from "./_components/PendingApprovalsTable";
import ApprovalHistoryTable from "./_components/ApprovalHistoryTable";
import type { AuditRow, PendingAgent } from "./_components/shared";
import { useGlobalNonce } from "@/components/GlobalFilter";
import { t } from "@/i18n";

export default function ApprovalsPage() {
  const [agents, setAgents] = useState<PendingAgent[]>([]);
  const [history, setHistory] = useState<AuditRow[]>([]);
  // 2026-10-13 round 76-CZ: 初值改 **true** —— 本页**挂载即加载**(useEffect 里 load())。
  //   初值 false 时首帧会把 loading 当"已加载", 页头就显示"共 0 待处理"(假计数)。
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // 2026-10-15 钥匙治理(item 1): 审批不再直发业务钥匙, 只发**一次性领取券** —— 券值只在 approve 响应里
  //   出现一次, 所以必须在这里接住并展示(否则管理员只能再去调 agent.issueClaimTicketForAgent 重签)。
  const [ticket, setTicket] = useState<{ agent_id: string; value: string; expires_at: string; ttl_seconds?: number; services: string[] } | null>(null);
  // 2026-09-07: 审批时选择授权业务 (默认不勾, 必须手动勾选至少 1 个)
  const [services, setServices] = useState<Array<{ name: string }>>([]);
  const [selected, setSelected] = useState<Record<string, Record<string, boolean>>>({});
  // 2026-10-13 round 76-DK: 接入全局刷新(本页只挂载拉一次, 无轮询)。
  const gf = useGlobalNonce();

  const loadHistory = async () => {
    try {
      const r = await fetch(`/api/agent-approvals/history?_gf=${gf}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.error) setHistory(Array.isArray(d) ? d : []);
    } catch { /* history 失败不阻塞主列表 */ }
  };

  const load = async () => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/agent-approvals?_gf=${gf}`, { cache: "no-store" });
      const d = await r.json();
      if (d.error) setError(d.error);
      else {
        const list = Array.isArray(d) ? d : [];
        setAgents(list);
        // 2026-09-07: agent 注册时声明了想接的业务 (profile.requested_services) → 预勾选, 管理员可增删
        const prefill: Record<string, Record<string, boolean>> = {};
        for (const ag of list) {
          const req = ag?.profile?.requested_services;
          if (Array.isArray(req) && req.length > 0) {
            const m: Record<string, boolean> = {};
            for (const s of req) m[s] = true;
            prefill[ag.agent_id] = m;
          }
        }
        if (Object.keys(prefill).length > 0) setSelected((prev) => ({ ...prefill, ...prev }));
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    // 2026-10-13 round 76-DK: 本页只挂载拉一次(无轮询) -> 让顶栏刷新也能重取。
    load(); loadHistory();
    fetch(`/api/agent-services?_gf=${gf}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { const s = Array.isArray(d) ? d : (d?.services || []); setServices(s); })
      .catch(() => {});
  }, [gf]);

  const toggleSvc = (agent_id: string, name: string) => {
    setSelected((prev) => {
      const cur = { ...(prev[agent_id] || {}) };
      cur[name] = !cur[name];
      return { ...prev, [agent_id]: cur };
    });
  };

  const act = async (agent_id: string, action: "approve" | "reject", services?: Array<{ name: string }>) => {
    setBusyId(agent_id); setError("");
    try {
      const r = await fetch("/api/agent-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, agent_id, services }),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); }
      else {
        // approve 的响应体形如 { result: { data: { json: {...} } } }(tRPC 代理) —— 两种形态都兜住
        const payload = d?.result?.data?.json || d?.result?.data || d;
        const t = payload?.claim_ticket;
        if (action === "approve" && t?.value) {
          setTicket({ agent_id, value: t.value, expires_at: t.expires_at, ttl_seconds: t.ttl_seconds, services: t.services || [] });
        }
        load(); loadHistory();
      }
    } catch (e: any) { setError(e.message); }
    finally { setBusyId(null); }
  };

  return (
    <div className="layout"><main className="main">
      <ApprovalsHeader agentCount={agents.length} error={error} loading={loading} />
        {/* 2026-10-19 B4: 修前本页**没有任何首屏大号数字**(实测 0 个) ✗ —— "有几条待批"只在标题小字里。
            补 ≤3 张: 待审批 / 审批记录 / 涉及智能体(去重)。数据时刻由既有全局机制提供(单源, 不重复标注)✓ */}
        <div className="kpi-grid" style={{ marginBottom: "var(--sp-3)" }}>
          <KPICard label="待审批（个）" value={agents.length} delta={loading ? "加载中" : agents.length ? "需处理" : "暂无待处理"} deltaDir={agents.length ? "down" : "up"} />
          <KPICard label="审批记录（条）" value={history.length} delta="长期保留" />
          <KPICard label="涉及智能体（个）" value={new Set((history as any[]).map((h: any) => h.entity_id)).size} delta="按实体去重" />
        </div>


      <PendingApprovalsTable
        agents={agents}
        loading={loading}
        services={services}
        selected={selected}
        busyId={busyId}
        onRefresh={load}
        onToggleSvc={toggleSvc}
        act={act}
        setError={setError}
      />

      {ticket && (
        <div style={{ margin: "var(--sp-3) 0", padding: "var(--sp-3)", borderRadius: "var(--radius-md)", background: "var(--bg-surface)", border: "1px solid var(--primary)" }}>
          <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, marginBottom: "var(--sp-1-5)" }}>
            {t('approvals.ticket.title', { agent: ticket.agent_id })}
          </div>
          <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", marginBottom: "var(--sp-1-5)" }}>
            <code style={{ flex: 1, fontSize: "var(--fs-base)", wordBreak: "break-all", padding: "var(--sp-1) var(--sp-2)", borderRadius: "var(--radius-xs)", background: "var(--bg)" }}>{ticket.value}</code>
            <button onClick={() => navigator.clipboard.writeText(ticket.value)}
              style={{ padding: "var(--sp-1) var(--sp-2)", fontSize: "var(--fs-sm)", borderRadius: "var(--radius-xs)", cursor: "pointer", background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)" }}>
              {t('approvals.ticket.copy')}
            </button>
            <button onClick={() => setTicket(null)}
              style={{ padding: "var(--sp-1) var(--sp-2)", fontSize: "var(--fs-sm)", borderRadius: "var(--radius-xs)", cursor: "pointer", background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)" }}>
              {t('approvals.ticket.dismiss')}
            </button>
          </div>
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
            {t('approvals.ticket.note', {
              services: ticket.services.join(", ") || t('common.none'),
              expiresAt: ticket.expires_at,
              // 券有效期由服务端给(ttl_seconds), 页面只说"领取后 N 分钟内有效", 不写死 15 分钟。
              ttl: Math.max(1, Math.round(Number(ticket.ttl_seconds || 0) / 60) || 15),
            })}
          </div>
          {/* 2026-10-15 文案业务化: 端点与命令是**给装机人的原文**, 收进折叠区(与 flywheel/lineage 页既有做法一致),
              正文只说业务语言 —— 既不把内部术语写在正文, 也不删掉可执行细节。 */}
          <details style={{ marginTop: "var(--sp-1-5)" }}>
            <summary style={{ cursor: "pointer", fontSize: "var(--fs-sm)" }}>{t('approvals.ticket.commandSummary')}</summary>
            <pre style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-2)", borderRadius: "var(--radius-sm)", background: "var(--bg)", overflowX: "auto", margin: "var(--sp-1-5) 0 0" }}>
{`curl -X POST <MIND>/api/v1/agent/claim-service-key \\
  -H 'Content-Type: application/json' \\
  -d '{"agent_id":"${ticket.agent_id}","ticket":"${ticket.value}"}'

MCP_API_KEY=${ticket.value} ./install-agent.sh ${ticket.agent_id}`}
            </pre>
            <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginTop: "var(--sp-1)" }}>
              {t('approvals.ticket.commandHint')}
            </div>
          </details>
        </div>
      )}

      <ApprovalHistoryTable history={history} onRefresh={loadHistory} />
      {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/agents">智能体总览 →</Link>
        <Link href="/system/permissions">业务授权矩阵 →</Link>
      </div>
    </main></div>
  );
}
