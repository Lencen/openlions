"use client";
// /agents/transfer —— 数据卡 8（data-cards/card-8-agents-transfer.md · 2026-11-05 准）呈现层 + 字段展示改造
// ---------------------------------------------------------------------------
// 只改呈现层与字段展示：转派写入端点 POST /api/agent-transfer、请求体、dry-run/force 语义一行未改。
// 只读数据全部来自既有端点（不新增接口）：
//   · /api/agent-list            —— agent 注册表 + MACS 合并（卡片 8 §10 agent → 详情）
//   · /api/todos?limit=500       —— 可转派任务数（Todo，status∈{OPEN,DOING}，按 ownerId 汇总）
//   · /api/todos?status=DOING    —— 主查询失败时的「进行中」可见兜底（同一端点、不同筛选）
//   · /api/agent-approvals/history —— 审计日志数(24h) 的「近似：AuditLog」（最多 200 条）
// 缺口口径（卡片 8 §8，硬条件）：
//   · 转派批次记录表未上线 → 页面上固定「不可得」+ 原因，不写 0、不留空；
//   · 可转派任务数 / 审计日志数 / agent 任务成功率取不到时同样「不可得」+ 原因，不拿 0 冒充。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { t } from "@/i18n";
import FlywheelFlow from "@/components/FlywheelFlow";
import TableCopyButton from "@/components/TableCopyButton";
import DataMoment from "@/components/DataMoment";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle, Pill, KpiCard, StateBlock } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import styles from "./page.module.css";

type AgentItem = {
  agent_id: string;
  display_name?: string | null;
  status?: string | null;
  source?: string | null;
  macsStatus?: string | null;
  channel?: string | null;
  host?: string | null;
};

type TodoRow = { id: string; status?: string | null; ownerType?: string | null; ownerId?: string | null };
type AuditRow = { createdAt?: string | number | null; action?: string | null; agent_id?: string | null };

/** 按 ownerId 汇总的 Todo（只统计 OPEN/DOING 且 ownerType=agent） */
type OwnerCount = { open: number; doing: number; total: number };

type AgentRow = {
  id: string;
  name: string;
  source: string;
  status: string;
  /** 进行中（DOING）；接口取不到时为 null（显示不可得） */
  doing: number | null;
  /** 可转派任务数（OPEN+DOING）；该 agent 无对应任务或接口取不到时为 null（字典：不写 0） */
  transferable: number | null;
};

type CountRow = { k: string; n: number };

/** 时间戳归一：数字（ms）/可解析字符串 -> ms；无法解析返回 null（不拿 0 冒充时刻） */
function tsOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : null;
}

const DAY_MS = 86400000;

export default function TransferPage() {
  // —— 转派写入：状态与请求体保持改前一致（端点、参数、dry-run/force 语义未改） ——
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // —— 只读数据（卡片 8 §6/§12）；5min 聚合口径 -> 页面不轮询（pollMs: 0），仍受顶栏全局刷新驱动 ——
  const agentsQ = useApi<any>("/api/agent-list", { pollMs: 0 });
  const todosQ = useApi<any>("/api/todos?limit=500", { pollMs: 0 });
  const doingQ = useApi<any>("/api/todos?status=DOING&limit=500", { pollMs: 0 });
  const auditQ = useApi<any>("/api/agent-approvals/history?limit=200", { pollMs: 0 });

  // —— 搜索：agent ID / 名称，250ms 防抖，进 URL ?q=（卡片 8 §12） ——
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(qInput.trim()), 250);
    return () => clearTimeout(id);
  }, [qInput]);

  // 首帧从 URL 恢复 q / from / to（卡片 8 §10：返回保留 from/to）
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const qv = sp.get("q");
      if (qv) { setQInput(qv); setQ(qv.trim()); }
      const fv = sp.get("from");
      if (fv) setFromId(fv);
      const tv = sp.get("to");
      if (tv) setToId(tv);
    } catch { /* ignore */ }
  }, []);

  // q / from / to 写回 URL（replaceState，不新增路由、不进历史栈）
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (q) sp.set("q", q); else sp.delete("q");
      if (fromId) sp.set("from", fromId); else sp.delete("from");
      if (toId) sp.set("to", toId); else sp.delete("to");
      const next = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (next ? "?" + next : ""));
    } catch { /* ignore */ }
  }, [q, fromId, toId]);

  // —— 可转派任务数（Todo）：ok=false / 行数被截断 / 请求失败 -> null（不可得，不写 0） ——
  const todosPayload: any = todosQ.data;
  const todosRows: TodoRow[] = Array.isArray(todosPayload?.rows) ? (todosPayload.rows as TodoRow[]) : [];
  const todosOk = !todosQ.error && todosPayload?.ok === true;
  const todosIncomplete = todosOk && Number(todosPayload?.count) > todosRows.length;
  const transferOk = todosOk && !todosIncomplete;
  const transferReason = transferOk
    ? ""
    : todosPayload?.error
      ? "待办接口返回错误：" + String(todosPayload.error)
      : (todosQ.error ? String((todosQ.error as Error)?.message || todosQ.error) : "")
        || (todosIncomplete ? "接口只返回 " + todosRows.length + "/" + Number(todosPayload?.count) + " 行（截断）" : "待办接口未返回可用数据");

  const counts = useMemo<Map<string, OwnerCount>>(() => {
    const m = new Map<string, OwnerCount>();
    if (!transferOk) return m;
    for (const r of todosRows) {
      const st = String(r.status || "");
      if (st !== "OPEN" && st !== "DOING") continue;
      if (String(r.ownerType || "") !== "agent") continue;
      const id = String(r.ownerId || "");
      if (!id) continue;
      const cur = m.get(id) || { open: 0, doing: 0, total: 0 };
      if (st === "OPEN") cur.open += 1; else cur.doing += 1;
      cur.total += 1;
      m.set(id, cur);
    }
    return m;
  }, [todosRows, transferOk]);

  // —— DOING 兜底（主查询不可得时仍给出一个真实的「进行中」列；它是子集，不冒充可转派合计） ——
  const doingPayload: any = doingQ.data;
  const doingRows: TodoRow[] = Array.isArray(doingPayload?.rows) ? (doingPayload.rows as TodoRow[]) : [];
  const doingOk = !doingQ.error && doingPayload?.ok === true;
  const doingCounts = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    if (!doingOk) return m;
    for (const r of doingRows) {
      if (String(r.status || "") !== "DOING") continue;
      if (String(r.ownerType || "") !== "agent") continue;
      const id = String(r.ownerId || "");
      if (!id) continue;
      m.set(id, (m.get(id) || 0) + 1);
    }
    return m;
  }, [doingRows, doingOk]);

  // —— 可转派合计：只有一致的全量快照才给数字 ——
  const transferableTotal: number | null = transferOk
    ? Array.from(counts.values()).reduce((a, c) => a + c.total, 0)
    : null;

  // —— 审计日志数(24h)：近似 AuditLog；接口 401/非数组 -> 不可得 + 原因 ——
  const auditRows: AuditRow[] = Array.isArray(auditQ.data) ? (auditQ.data as AuditRow[]) : [];
  const auditOk = !auditQ.error && Array.isArray(auditQ.data);
  const audit24: number | null = auditOk
    ? auditRows.filter((r) => {
        const ts = tsOf(r.createdAt);
        return ts !== null && Date.now() - ts <= DAY_MS;
      }).length
    : null;
  const auditReason = auditOk
    ? ""
    : (auditQ.data && auditQ.data._error) || (auditQ.error ? String((auditQ.error as Error)?.message || auditQ.error) : "") || "审计接口未返回数组";

  // —— agent 表行：注册表（真实）+ 可转派/进行中（取不到 -> null -> 不可得） ——
  const agentItems: AgentItem[] = Array.isArray(agentsQ.data?.items) ? (agentsQ.data.items as AgentItem[]) : [];
  const rows = useMemo<AgentRow[]>(() => {
    const kw = q.toLowerCase();
    const list = agentItems
      .filter((a) => {
        if (!kw) return true;
        return [a.agent_id, a.display_name, a.channel, a.host, a.status]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(kw);
      })
      .map((a) => {
        const id = String(a.agent_id || "");
        const c = counts.get(id);
        const doing = c ? c.doing : (doingOk ? (doingCounts.get(id) ?? 0) : null);
        return {
          id,
          name: String(a.display_name || id),
          source: a.source === "macs" ? "消息通道（未登记认知库）" : a.source === "both" ? "认知库 + 消息通道" : "认知库",
          status: String(a.macsStatus || a.status || "UNKNOWN"),
          doing,
          transferable: transferOk ? (c ? c.total : null) : null,
        };
      });
    // 默认按可转派任务数降序（卡片 8 §12）；不可得时退到「进行中」降序，再按 ID 稳定排序。
    return list.sort((x, y) => {
      if (x.transferable != null || y.transferable != null) return (y.transferable ?? -1) - (x.transferable ?? -1);
      return (y.doing ?? -1) - (x.doing ?? -1) || x.id.localeCompare(y.id);
    });
  }, [agentItems, counts, doingCounts, doingOk, transferOk, q]);

  const agentColumns: DataColumn<AgentRow>[] = [
    {
      key: "name",
      title: "智能体",
      width: "260px",
      render: (r) => (
        <Link className={styles.agentLink} href={"/agents/detail?agentId=" + encodeURIComponent(r.id)} title={"查看 " + r.id + " 详情"}>
          <span className={styles.agentName}>{r.name}</span>
          <span className={styles.agentId}>{r.id}</span>
        </Link>
      ),
    },
    { key: "source", title: "来源", width: "160px" },
    { key: "status", title: "状态", width: "120px" },
    {
      key: "doing",
      title: "进行中（DOING）",
      align: "right",
      width: "150px",
      render: (r) => (r.doing != null ? fmtNum(r.doing) : <span className={styles.na} title="待办接口取不到进行中记录">不可得</span>),
    },
    {
      key: "transferable",
      title: "可转派任务数（OPEN+DOING）",
      align: "right",
      width: "220px",
      render: (r) =>
        r.transferable != null ? (
          <Link className={styles.countLink} href="/todo?owner=agent" title="去待办看板（按智能体过滤；暂不支持按具体智能体筛选）">
            {fmtNum(r.transferable)}
          </Link>
        ) : (
          <span className={styles.na} title={(transferReason || "查不到 ownerId 对应任务") + "（字典：不写 0）"}>不可得</span>
        ),
    },
  ];

  // —— 转派执行（POST /api/agent-transfer，行为与改前逐字一致） ——
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

  const moved = result?.counts || result?.moved || {};
  const countRows: CountRow[] = Object.entries(moved).map(([k, v]) => ({ k, n: Number(v) }));
  const countColumns: DataColumn<CountRow>[] = [
    { key: "k", title: "表" },
    { key: "n", title: "条数", align: "right", render: (r) => fmtNum(r.n) },
  ];

  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb">
        <span className={styles.crumbDim}>{t('transfer.crumb')}</span>
        <span className="sep">/</span>
        <span className="current">AI 离开/接手</span>
      </div>
      <PageHeader>
        <PageTitle>AI 离开/接手</PageTitle>
        <div className="page-subtitle">
          权限转移 + 数据继承 + 无中断切换 · 转不转：先看可转派任务量与审计留痕，再决定 dry-run 还是真转
        </div>
        <div className={styles.headMeta}>
          <Pill tone="mute">只读展示</Pill>
          <Pill tone="warn">执行转派需管理员 · 默认 dry-run</Pill>
        </div>
      </PageHeader>

      {/* ---------- 指标带（≤4 KpiCard，卡片 8 §6） ---------- */}
      <div className="kpi-grid">
        <KpiCard
          label="可转派任务数"
          value={todosQ.loading ? "…" : transferableTotal != null ? fmtNum(transferableTotal) : "不可得"}
          delta={transferableTotal != null ? "覆盖 " + counts.size + " 个智能体" : ""}
          hint={transferableTotal != null
            ? "口径：待办中状态为待办/进行中、负责人为智能体（按负责人汇总）· 源：待办库"
            : "原因：" + (transferReason || "待办接口未返回可用数据") + " · 不写 0"}
        />
        <KpiCard
          label="审计日志数（24h）"
          value={auditQ.loading ? "…" : audit24 != null ? fmtNum(audit24) : "不可得"}
          hint={auditOk
            ? "近似：AuditLog（仅 AGENT 实体生命周期，最多 200 条；近 24h 过滤）"
            : "原因：" + (auditReason || "审计接口取不到") + " · 不写 0"}
        />
        <KpiCard
          label="智能体任务成功率"
          value="不可得"
          hint="无按智能体聚合验收结论与待办的只读接口；字典条目「成员 · 智能体任务成功率」当前不可调用 · 不写 0"
        />
        <KpiCard
          label="转派批次记录"
          value="不可得"
          hint="转派批次记录表未上线（11-12 前补）；11-11 前固定不可得 · 不写 0"
        />
      </div>

      {/* ---------- 按 agent 的可转派任务（真实字段 + 不可得标注） ---------- */}
      <section className="panel" aria-label="按智能体的可转派任务">
        <div className="panel-header">
          <span className="panel-title">按智能体的可转派任务</span>
          <span className="tiny">搜索智能体编号 / 名称 · 输入即搜 · 默认可转派任务数降序</span>
        </div>
        <div className={styles.toolbar}>
          <input
            className={styles.search}
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQInput("");
              if (e.key === "Enter") setQ(qInput.trim());
            }}
            placeholder="搜索智能体编号 / 名称"
            aria-label="搜索智能体编号或名称"
          />
          <span className={styles.count}>共 {rows.length} 个智能体 · 可转派不可得时按「进行中」降序</span>
          <TableCopyButton />
        </div>
        <DataTable
          columns={agentColumns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={agentsQ.loading && !agentsQ.data}
          error={agentsQ.error ? String((agentsQ.error as Error)?.message || agentsQ.error) : null}
          onRetry={() => { agentsQ.mutate(); }}
          empty={{
            title: q ? "没有匹配的智能体" : "没有可展示的智能体",
            desc: q ? "智能体编号 / 名称里没有匹配项 —— 清空搜索或到智能体页查看注册表。" : "注册表接口返回 0 条（/api/agent-list）。",
            action: q ? <button type="button" className="btn" onClick={() => { setQInput(""); setQ(""); }}>清除搜索</button> : <Link className="btn" href="/agents">去智能体总览</Link>,
          }}
        />
        <div className={styles.count}>
          可转派任务数口径：待办中状态为待办/进行中、负责人为智能体；该智能体无对应任务时按字典显示「不可得」，不写 0。
          进行中（DOING）是同一口径的子集，单独成列只为在合计不可得时仍能看到真实快照。
        </div>
      </section>

      {/* ---------- 转派批次记录：卡片 8 §8 缺口 -> 不可得 + 原因（不写 0、不留空） ---------- */}
      <section className="panel" aria-label="转派批次记录">
        <div className="panel-header">
          <span className="panel-title">转派批次记录</span>
          <span className="tiny">卡片 8 §8 · 11-12 前补</span>
        </div>
        <StateBlock
          title="转派批次记录表未上线"
          desc={
            <>
              <b>不可得</b>：平台还没有转派批次表（无批次编号 / 每批条数 / 执行人 / 时间），因此本页无法列出批次记录。
              <br />
              补齐计划：11-12 前；11-11 前本项固定显示「不可得」，不写 0、不留空。
              <br />
              <span className="tiny">
                （原页面这里是一行硬编码的静态记录「继承 ut→leo 2026-07-30」——静态样例不是批次表，已移除，避免被当成实时历史。）
              </span>
            </>
          }
        />
      </section>

      {/* ---------- 接手流程（既有说明块，未改语义） ---------- */}
      <section className="panel">
        <div className="panel-header"><span className="panel-title">接手流程</span></div>
        <FlywheelFlow steps={[{ label: "AI 离开" }, { label: "权限转移", active: true }, { label: "数据继承", active: true }, { label: "新 AI 接手" }, { label: "无中断切换", active: true }]} />
      </section>

      {/* ---------- 执行转派（写入口：端点/参数/语义与改前一致） ---------- */}
      <section className="panel" aria-label="执行转派">
        <div className="panel-header">
          <span className="panel-title">{t('transfer.inherit.title')}</span>
          <span className="tiny">默认 dry-run（仅预览、不写入）；执行转派需管理员</span>
        </div>
        <div className={styles.formRow}>
          <input
            className={styles.input}
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            placeholder={t('transfer.from')}
            aria-label={t('transfer.from')}
          />
          <span className={styles.arrow}>→</span>
          <input
            className={styles.input}
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            placeholder={t('transfer.to')}
            aria-label={t('transfer.to')}
          />
          <label className={styles.checkRow}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> 仅预览（不写入）
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={loading || !fromId || !toId}
            className={styles.submit}
            data-tone={dryRun ? "preview" : "exec"}
          >
            {loading ? "处理中..." : dryRun ? "预览迁移" : "执行迁移"}
          </button>
        </div>
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        {result ? (
          <div className={styles.result}>
            <div className={styles.resultHead}>
              状态:{" "}
              <strong className={styles.resultStrong} data-tone={result.status === "done" ? "ok" : "preview"}>{result.status}</strong>
              {result.status === "done" && <> · {result.fromAgentId} → {result.toAgentId} · 共 <strong>{result.total}</strong> 条</>}
              {result.status === "preview" && <> · {result.fromAgentId} → {result.toAgentId} · 将迁移 <strong>{result.total}</strong> 条</>}
            </div>
            <TableCopyButton />
            <DataTable
              columns={countColumns}
              rows={countRows}
              rowKey={(r) => r.k}
              empty={{ title: "本次转派没有返回表级条数", desc: "接口返回的 counts/moved 为空 —— 这不等于「迁移了 0 条」，请以接口原文为准。" }}
            />
          </div>
        ) : null}
      </section>

      <footer className={styles.foot}>
        <DataMoment
          items={[
            { label: "智能体", at: agentsQ.data?.asOf, loading: agentsQ.loading },
            { label: "待办", at: todosQ.data?.asOf, loading: todosQ.loading },
          ]}
          showPrefix={false}
        />
        <span className="tiny">
          口径：可转派任务数 = 待办（待办 / 进行中，按负责人）；审计日志数（近 24 小时）≈ 审计流水；智能体任务成功率 = 验收结论与待办聚合（当前不可得）；转派批次记录表未上线。
          取不到一律「不可得」+ 原因，不写 0；from/to 与搜索词进 URL，返回不丢。
        </span>
      </footer>

      <div className={styles.related}>
        <span>相关视图：</span>
        <Link href="/agents">智能体总览 →</Link>
        <Link href="/system/permissions">业务授权矩阵 →</Link>
        <Link href="/todo">待办看板 →</Link>
      </div>
    </main></div>
  );
}
