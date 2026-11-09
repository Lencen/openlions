"use client";
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
// 2026-11-05 P2 批6：本文件 13 处内联 style 清零，样式追加到同目录 ./page.module.css（apr* 前缀）；
//   一次性领取券的代码块/复制/收起、命令折叠区（details）、页脚出链都在，取数、URL 与文案未动。
import { useEffect, useState } from "react";
import Link from "next/link";
import KPICard from "@/components/KPICard";
import PendingApprovalsTable from "./_components/PendingApprovalsTable";
import ApprovalHistoryTable from "./_components/ApprovalHistoryTable";
import type { AuditRow, PendingAgent } from "./_components/shared";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import { useGlobalNonce } from "@/components/GlobalFilter";
import { t } from "@/i18n";
import styles from "./page.module.css";

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
      {/* 2026-11-05 页头口径（PAGE-HEADER-31 §3 第 6 行）：成员 / 接入审批 · 待接入与待审批的智能体列表。
          原来页头在 ./_components/ApprovalsHeader，本页 page.tsx 里没有 <PageHeader>（survey 统计口径看不到），
          故把面包屑 + 页头 + 错误提示并回本文件；"共 N 待处理" 的计数改由下方 KPI 卡承担，不再在页头重复。 */}
      <div className="breadcrumb"><span className={styles.crumbDim}>成员</span><span className="sep">/</span><span className="current">接入审批</span></div>
      <PageHeader>
        <PageTitle>接入审批</PageTitle>
        <div className="page-subtitle">待接入与待审批的智能体列表</div>
      </PageHeader>
      {error && <div className={styles.err}>⚠ {error}</div>}
        {/* 2026-10-19 B4: 修前本页**没有任何首屏大号数字**(实测 0 个) ✗ —— "有几条待批"只在标题小字里。
            补 ≤3 张: 待审批 / 审批记录 / 涉及智能体(去重)。数据时刻由既有全局机制提供(单源, 不重复标注)✓ */}
        <div className={"kpi-grid " + styles.aprKpi}>
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
        <div className={styles.aprTicket}>
          <div className={styles.aprTicketTitle}>
            {t('approvals.ticket.title', { agent: ticket.agent_id })}
          </div>
          <div className={styles.aprTicketRow}>
            <code className={styles.aprTicketCode}>{ticket.value}</code>
            <button onClick={() => navigator.clipboard.writeText(ticket.value)}
              className={styles.aprTicketBtn}>
              {t('approvals.ticket.copy')}
            </button>
            <button onClick={() => setTicket(null)}
              className={styles.aprTicketBtn}>
              {t('approvals.ticket.dismiss')}
            </button>
          </div>
          <div className={styles.aprTicketNote}>
            {t('approvals.ticket.note', {
              services: ticket.services.join(", ") || t('common.none'),
              expiresAt: ticket.expires_at,
              // 券有效期由服务端给(ttl_seconds), 页面只说"领取后 N 分钟内有效", 不写死 15 分钟。
              ttl: Math.max(1, Math.round(Number(ticket.ttl_seconds || 0) / 60) || 15),
            })}
          </div>
          {/* 2026-10-15 文案业务化: 端点与命令是**给装机人的原文**, 收进折叠区(与 flywheel/lineage 页既有做法一致),
              正文只说业务语言 —— 既不把内部术语写在正文, 也不删掉可执行细节。 */}
          <details className={styles.aprTicketDetails}>
            <summary className={styles.aprTicketSummary}>{t('approvals.ticket.commandSummary')}</summary>
            <pre className={styles.aprTicketPre}>
{`curl -X POST <MIND>/api/v1/agent/claim-service-key \\
  -H 'Content-Type: application/json' \\
  -d '{"agent_id":"${ticket.agent_id}","ticket":"${ticket.value}"}'

MCP_API_KEY=${ticket.value} ./install-agent.sh ${ticket.agent_id}`}
            </pre>
            <div className={styles.aprTicketHint}>
              {t('approvals.ticket.commandHint')}
            </div>
          </details>
        </div>
      )}

      <ApprovalHistoryTable history={history} onRefresh={loadHistory} />
      {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className={"tiny " + styles.aprLinks}>
        <span>相关视图：</span>
        <Link href="/agents">智能体总览 →</Link>
        <Link href="/system/permissions">业务授权矩阵 →</Link>
      </div>
    </main></div>
  );
}
