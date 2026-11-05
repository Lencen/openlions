"use client";
// 2026-09-10 新增: 待办中心 (TODO 独立成平台一等实体)
// 与飞轮"改进任务"(机制修复) 分开: TODO 是具体行动项, 含只有人能做的事(授权/采购/决策/签字)。
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数/状态与拼装 (<200 行)。
//
// 2026-11-04 ord-20261104-032 P1 列表模板改造（只改呈现层）：
//   页头 PageHeader/PageTitle → 指标带 KpiCard(4) → 工具条(搜索 + FilterBar) → DataTable → 计数。
//   取数（useMergedApi 的两个 /api/todos 请求、端点、status/ownerType/limit 参数）一行未改。
import { useEffect, useState } from "react";
import { Alert, Button, Form, Select, PlusOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { useMergedApi } from "@/lib/useMergedApi";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { OPEN_STATUSES, createTodo, dueState, isToday, patchTodo, HUMAN_ID, TODO_STATUS } from "@/lib/todos";
import { PageHeader, PageTitle, DataTable, FilterBar, StateBlock } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import TodoHero from "./_components/TodoHero";
import TodoMetrics from "./_components/TodoMetrics";
import TodoBacklogTrend from "./_components/TodoBacklogTrend";
import TodoDistribution from "./_components/TodoDistribution";
import TodoDetailDrawer from "./_components/TodoDetailDrawer";
import { buildTodoColumns } from "./_components/todoColumns";
import TodoDecideModal from "./_components/TodoDecideModal";
import TodoCreateModal from "./_components/TodoCreateModal";
import TodoFooter from "./_components/TodoFooter";
import RowClick from "./_components/RowClick";
import QueueBoundary from "@/components/common/QueueBoundary";
import styles from "./page.module.css";

/** 四态之「无权限」：API 401/403 或错误文案带权限字样时整页替换（TEMPLATES §1）。 */
const FORBIDDEN_RE = /401|403|无权限|未授权/;

/** 表格的 tab 顺序（「全部」在最左，与模板 A「视图分段」一致）。 */
const TABS = ["ALL", "OPEN", "DOING", "BLOCKED", "DONE"] as const;
/** 每页 20 条（与改前 TodoTable 的 pagination.pageSize 一致；白名单 DataTable 不做分页，由页面切页）。 */
const PAGE_SIZE = 20;

const SORTS = [
  { value: "default", label: "优先级 + 截止（默认，需人决策优先）" },
  { value: "due", label: "截止时间最早" },
  { value: "created", label: "创建时间倒序" },
];

/** 与改前 TodoTable 完全相同的 tab → status 映射（服务端请求集合见 page 的 tabStatuses）。 */
const TAB_STATUSES: Record<string, string[]> = { OPEN: ["OPEN", "DOING"], DONE: ["DONE"], DROPPED: ["DROPPED"] };

export default function TodoCenterPage() {
  const f = useGlobalFilter();
  const [tab, setTab] = useState<string>("OPEN");
  const [ownerFilter, setOwnerFilter] = useState<string>("ALL");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // 2026-09-11 用户反馈"待办中心没有详情, 人类看不到上下文": 行内展开渲染七段结构 (docs/platform-logic/todo.md)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [form] = Form.useForm();
  const [decideRow, setDecideRow] = useState<any | null>(null);
  const [decideText, setDecideText] = useState("");

  // 搜索（模板 A §搜索）：只搜标题 / ID（数据卡 卡4 §12 声明的可搜索字段），250ms 防抖；?q= 进 URL。
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [sort, setSort] = useState("default");
  const [page, setPage] = useState(1);

  const submitDecision = async () => {
    const row = decideRow;
    if (!row) return;
    const text = decideText.trim();
    if (text.length < 5) { setFeedback({ type: "err", msg: "请写下你的决定(至少 5 个字), 它会作为证据留档" }); return; }
    setBusy(row.id);
    // 决定文本同时写 note 与 evidence: note 给人看, evidence 进审计(平台按"有证据"口径统计)
    const r = await patchTodo({ id: row.id, status: "DONE", note: text, evidence: "human:" + HUMAN_ID + " 决定: " + text });
    setBusy(null);
    if (r.ok) {
      setFeedback({ type: "ok", msg: "决定已提交并留档: " + text.slice(0, 40) });
      setDecideRow(null); setDecideText(""); setNonce((n) => n + 1);
    } else {
      setFeedback({ type: "err", msg: "提交失败: " + (r.error || "未知错误") });
    }
  };

  // 2026-09-24 修(徽标与列表打架): 深链 ?owner=human 必须走**服务端过滤**。
  //   原实现 = "拉 status=ALL 最新 500 条, 再在前端按 ownerType 过滤" —— 实测徽标 humanOpen=2
  //   而进来只看到 1 条: 另一条人类待办不在最新 500 行内, 被**静默截断**(顶栏徽标与本页列表互相矛盾,
  //   而徽标正是本平台唯一的人类入口)。改为 ownerType=<x> 且不带 status -> mind 侧走默认活跃口径
  //   (status NOT IN ('DONE','DROPPED')), 与徽标 humanOpen 同口径(实测 2 == 2)。
  //   注: mind 侧 status=ALL 是"不加状态条件"(会带出 1531 条 DROPPED), 不是"仅未结", 故必须去掉它。
  // 2026-10-26 修（老板报「待办列表空」）：改为**服务端按 tab 状态过滤**：未完成 tab = OPEN + DOING 两次请求合并。
  const tabStatuses = tab === "OPEN" ? ["OPEN", "DOING"] : [tab];
  const listUrls = tabStatuses.map((st) =>
    `/api/todos?${ownerFilter === "ALL" ? "" : "ownerType=" + ownerFilter + "&"}status=${st}&limit=500&_n=${nonce}_${f.nonce}`
  );
  // 2026-10-13 round 76-DI: 本页原来**只**依赖页面自有的 nonce —— 于是**顶栏全局刷新对本页无效**
  //   (全站其它页走 f.withQuery/f.nonce)。这里把两个 nonce 一起拼进 cache-buster:
  //   页面右上角的"刷新"仍有效, 顶栏的"刷新"也**终于能刷新本页**。
  const { data, loading, error, mutate } = useMergedApi<any>(listUrls);

  // 2026-09-11: 支持 /todo?open=<todoId> 直接展开某条待办 (任务详情页"相关待办"反向跳转用)
  // 2026-09-24 增: 支持 /todo?owner=human —— 顶栏「待办」徽标深链到"只要我处理的"。
  //   IA 整改(2026-09-21): 同一实体的过滤视图不另占菜单位, 走同页筛选态/深链;
  //   故独立审批页已撤, 由本页的「负责人」筛选承担(该筛选与 humanOpen 指标本就在此页)。
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const open = sp.get("open");
      if (open) {
        setExpandedKeys((prev) => (prev.includes(open) ? prev : [...prev, open]));
        setTab("ALL");
      }
      const owner = sp.get("owner");
      if (owner === "human" || owner === "agent") { setOwnerFilter(owner); setTab("ALL"); }
      const qv = sp.get("q");
      if (qv) { setQ(qv); setQApplied(qv.trim().toLowerCase()); }
      const sv = sp.get("sort");
      if (sv && SORTS.some((s) => s.value === sv)) setSort(sv);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setQApplied(q.trim().toLowerCase()), 250);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (qApplied) sp.set("q", qApplied);
      else sp.delete("q");
      sp.set("sort", sort); // 排序进 URL（?sort=），返回 / 刷新不丢（open/owner 等其它参数原样保留）
      const next = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (next ? "?" + next : ""));
    } catch { /* ignore */ }
  }, [qApplied, sort]);

  const { data: agentRaw } = useApi<any>("/api/agent-list");
  const agents = (() => {
    const list = Array.isArray(agentRaw) ? agentRaw : (agentRaw?.items ?? agentRaw?.result?.data ?? []);
    return (Array.isArray(list) ? list : []).filter((a: any) => a?.agent_id).map((a: any) => ({ value: a.agent_id, label: `${a.display_name || a.agent_id} (${a.agent_id})` }));
  })();

  const rows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const counts: Record<string, number> = {};
  for (const c of data?.counts ?? []) counts[c.status] = Number(c.c ?? 0);

  const openRows = rows.filter((r) => OPEN_STATUSES.includes(r.status));
  // 2026-10-20 R9：页首"未完成"原来用 openRows.length（只数当前取回的 500 行），
  //   与「待办构成」面板的全表未完成（57）对不上（实测 19 vs 57）——同页两个数让人不敢信。
  //   改用接口 counts 聚合（全表口径），当前视图条数放到 hint。
  const openAll = (counts.OPEN || 0) + (counts.DOING || 0) + (counts.BLOCKED || 0);
  const openInView = openRows.length;
  const overdue = openRows.filter((r) => dueState(r.dueAt, r.status).overdue);
  const doneToday = rows.filter((r) => r.status === "DONE" && isToday(r.doneAt));
  const agentOpen = openRows.filter((r) => r.ownerType === "agent");

  // 改搜索 / 筛选 / 排序时页码回到 1（模板 A §排序·组合）。
  useEffect(() => { setPage(1); }, [tab, ownerFilter, qApplied, sort]);

  const act = async (id: string, patch: any, label: string) => {
    setBusy(id);
    setFeedback(null);
    const r = await patchTodo({ id, ...patch });
    setBusy(null);
    if (r.ok) {
      setFeedback({ type: "ok", msg: label + " 成功" });
      setNonce((n) => n + 1);
    } else {
      setFeedback({ type: "err", msg: label + " 失败: " + (r.error || "未知错误") });
    }
  };

  // 2026-09-23 审核项=待办 (todo_land_jp7xab44pb6g): 知识治理审核待办的「通过并执行」——
  //   走 console 内部操作门禁(同源+CSRF), 服务端调 knowledge-dedupe-review-todo.cjs --decide approve,
  //   内部跑 dedupe --apply 并在成功后自动结单(写 evidence), 前端只负责发起 + 刷新。
  const approveGovernance = async (row: any) => {
    if (!row?.id) return;
    const okConfirm = typeof window === "undefined" ? true : window.confirm("通过并执行 dedupe 合并? 此操作会改写 Knowledge.supersededBy 链。");
    if (!okConfirm) return;
    setBusy(row.id);
    try {
      const tok = await fetch("/api/knowledge-dedupe/csrf", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      const res = await fetch("/api/knowledge-dedupe/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-console-csrf": tok?.csrf || "" },
        body: JSON.stringify({ dryRun: false, confirm: "APPLY", todoId: row.id, actorId: HUMAN_ID }),
      });
      const j = await res.json().catch(() => null);
      if (j?.ok) {
        setFeedback({ type: "ok", msg: "已通过并执行, 待办自动结单: " + String(j.summary || "").split("\n").filter(Boolean).slice(-1)[0] });
        setNonce((n) => n + 1);
      } else {
        setFeedback({ type: "err", msg: "执行失败: " + (j?.error || ("服务返回异常(状态 " + res.status + ")")) });
      }
    } finally {
      setBusy(null);
    }
  };

  const submitCreate = async () => {
    try {
      const v = await form.validateFields();
      let metaObj: any = null;
      if (v.meta && String(v.meta).trim()) {
        try { metaObj = JSON.parse(v.meta); } catch { setFeedback({ type: "err", msg: "meta 不是合法 JSON" }); return; }
      }
      const r = await createTodo({
        title: v.title,
        detail: v.detail || null,
        source: v.source || "human",
        ownerType: v.ownerType || "human",
        ownerId: v.ownerId || null,
        priority: v.priority || "P2",
        dueAt: v.dueAt ? v.dueAt.toISOString() : null,
        evidence: v.evidence || null,
        meta: metaObj,
      });
      if (r.ok) {
        setCreateOpen(false);
        form.resetFields();
        setFeedback({ type: "ok", msg: "已创建待办: " + (r.todo?.title || "") });
        setNonce((n) => n + 1);
      } else {
        setFeedback({ type: "err", msg: "创建失败: " + (r.error || "未知错误") });
      }
    } catch { /* 表单校验失败 */ }
  };

  const errText = error ? String((error as Error)?.message || error) : "";
  const forbidden = FORBIDDEN_RE.test(errText);

  // 表格行 = 服务端结果 → tab 状态 → 负责人 → 搜索词 → 排序（与改前 TodoTable 同一套判定，
  // 只是承载从旧表格换成了白名单 DataTable）。
  const allowed = TAB_STATUSES[tab] || null;
  const tableRows = rows
    .filter((r) => (tab === "ALL" ? true : allowed ? allowed.includes(r.status) : r.status === tab))
    .filter((r) => (ownerFilter === "ALL" ? true : r.ownerType === ownerFilter))
    .filter((r) => {
      if (!qApplied) return true;
      return (String(r.title || "") + " " + String(r.id || "")).toLowerCase().includes(qApplied);
    })
    .sort((a, b) => {
      const pr = { P0: 0, P1: 1, P2: 2 } as any;
      if (sort === "created") return String(b.createdAt).localeCompare(String(a.createdAt));
      if (sort === "due") {
        const due = (x: any) => (x.dueAt ? new Date(x.dueAt).getTime() : Number.MAX_SAFE_INTEGER);
        const d = due(a) - due(b);
        if (d) return d;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      }
      const d = (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3);
      if (d) return d;
      const at = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bt = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

  // 分页在排序之后：先对全量筛选结果排序，再切页（模板 A §排序·顺序）。
  const totalPages = Math.max(1, Math.ceil(tableRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = tableRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const tabItems = TABS.map((t) => ({
    key: t,
    label: t === "ALL" ? "全部" : TODO_STATUS[t]?.label || t,
    count: loading ? undefined : t === "ALL" ? rows.length : counts[t] || 0,
  }));

  const tableEmpty = {
    title: qApplied ? "没有匹配的待办" : tab === "OPEN" ? "当前没有未完成待办" : "该状态下暂无待办",
    desc: qApplied
      ? "标题 / 编号里没有匹配项 —— 清空搜索，或切回「全部」视图。"
      : "触发条件：服务端 status=" + tabStatuses.join("/") + (ownerFilter === "ALL" ? "" : " · 负责人 " + ownerFilter) + " 返回 0 条。未完成视图只含 待办/进行中；已完成的单请切「已完成」，被丢弃的单在「已丢弃」视图。",
    action: qApplied ? (
      <button type="button" className="btn" onClick={() => setQ("")}>清除搜索</button>
    ) : ownerFilter !== "ALL" ? (
      <button type="button" className="btn" onClick={() => setOwnerFilter("ALL")}>清除负责人筛选</button>
    ) : (
      <Button size="small" onClick={() => setCreateOpen(true)}>新建待办</Button>
    ),
  };

  const columns: DataColumn<any>[] = buildTodoColumns({
    tab,
    busy,
    act,
    onDecide: (row, option) => { setDecideRow(row); setDecideText(option ? "采纳选项 " + option.key + "：" + option.label : String(row.note || "")); },
    onApproveGovernance: approveGovernance,
    agents,
  });

  const openRow = expandedKeys[0] ? rows.find((r: any) => r.id === expandedKeys[0]) || null : null;

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>待办中心</PageTitle>
        <TodoHero
          openCount={openAll}
          humanOpen={data?.humanOpen ?? 0}
          overdueCount={overdue.length}
          doneTodayCount={doneToday.length}
          rowsCount={rows.length}
          asOf={data?.asOf}
          onRefresh={() => setNonce((n) => n + 1)}
        />
      </PageHeader>

      {/* UI-9: 说清「改进任务」与「待办」的区别 (从哪来 / 谁做) —— 页首对照提示 + 互链 */}
      <QueueBoundary current="todo" />

      {feedback ? (
        <div className={styles.notice}>
          <Alert
            type={feedback.type === "ok" ? "success" : "error"}
            showIcon
            closable
            title={feedback.msg}
            onClose={() => setFeedback(null)}
          />
        </div>
      ) : null}
      {data && data.ok === false && data.error ? (
        <div className={styles.notice}>
          <Alert type="warning" showIcon title="上游提示" description={data.error} />
        </div>
      ) : null}

      {forbidden ? (
        // 四态之「无权限」：整页替换 —— 指标带 / 趋势 / 构成 / 工具条 / 表格一律不渲染，
        // 只留页头与这一块，免得用户对着半屏假空态猜。
        <StateBlock
          title="无权限访问"
          desc={
            <>
              当前账号缺少待办读权限 <code>任务读取</code>（或后端返回 403）。请联系平台管理员在权限配置里
              为该线开通 <code>任务读取</code>；写操作（新建 / 改派 / 提交决定）另需 <code>任务修改</code>。
            </>
          }
        />
      ) : (
        <>
          <TodoMetrics
            data={data}
            counts={counts}
            loadingAll={loading && !data}
            errorAll={!!error}
            openCount={openAll}
            openInView={openInView}
            overdueCount={overdue.length}
            doneTodayCount={doneToday.length}
            agentOpenCount={agentOpen.length}
          />

          {/* 2026-10-20 B7 收尾：补 /todo 的积压趋势（原有 6/7 页有趋势，缺的就是本页）。
              数据来源：/api/todo-backlog-trend（只读 mind 库，按 createdAt/doneAt 按天复算）。 */}
          <TodoBacklogTrend />
          <TodoDistribution />
          {/* 工具条：最左搜索 → 状态视图（FilterBar）→ 右侧筛选后计数 */}
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQ("");
                if (e.key === "Enter") setQApplied(q.trim().toLowerCase());
              }}
              placeholder="搜索待办标题 / 编号"
              aria-label="搜索待办：标题、编号"
            />
            <FilterBar
              items={tabItems}
              active={tab}
              onSelect={setTab}
              right={<>共 {tableRows.length} 条（筛选后）· 只读列表，写操作在行内</>}
            />
          </div>
          <div className={styles.subToolbar}>
            <span>负责人</span>
            <Select
              ariaLabel="按负责人筛选"
              className={styles.sortSelect}
              value={ownerFilter}
              onChange={(v: any) => setOwnerFilter(String(v ?? "ALL"))}
              options={[
                { value: "ALL", label: "全部负责人" },
                { value: "human", label: "人类" },
                { value: "agent", label: "智能体" },
              ]}
            />
            <span>排序</span>
            <Select
              ariaLabel="排序方式"
              className={styles.sortSelect}
              value={sort}
              onChange={(v: any) => setSort(String(v || "default"))}
              options={SORTS}
            />
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建待办</Button>
          </div>

          <RowClick className={styles.clickable} onPick={(i) => { const r = pagedRows[i]; if (r) setExpandedKeys([r.id]); }}>
            <DataTable
              rows={pagedRows}
              columns={columns}
              rowKey={(r: any, i: number) => r.id || i}
              loading={loading && !data}
              error={error ? errText : null}
              onRetry={() => { mutate(); }}
              empty={tableEmpty}
            />
          </RowClick>
          <div className={styles.pager}>
            <span>
              共 {rows.length} 条（服务端结果）· 当前视图 {tableRows.length} 条（筛选后）
              {openInView !== rows.length ? ` · 其中未完成 ${openInView} 条` : ""}
              {" · "}默认按优先级+截止排序
            </span>
            <span className={styles.pagerLinks}>
              <span>第 {safePage}/{totalPages} 页 · 每页 {PAGE_SIZE}</span>
              <button type="button" className={styles.pagerBtn} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>上一页</button>
              <button type="button" className={styles.pagerBtn} disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>下一页</button>
            </span>
          </div>
        </>
      )}

      {/* 详情抽屉：expandedKeys 仍由页面维护（深链 ?open=<id> 用），首元素 = 当前打开的详情 */}
      <TodoDetailDrawer
        row={openRow}
        onClose={() => setExpandedKeys([])}
        onDecide={(row, option) => { setDecideRow(row); setDecideText(option ? "采纳选项 " + option.key + "：" + option.label : String(row.note || "")); }}
      />

      {/* 2026-09-14: 人类决策入口 —— 决定内容必须留档, 不能再"点一下完成就没了" */}
      <TodoDecideModal
        decideRow={decideRow}
        decideText={decideText}
        setDecideText={setDecideText}
        busy={busy}
        onCancel={() => { setDecideRow(null); setDecideText(""); }}
        onOk={submitDecision}
      />

      <TodoCreateModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        form={form}
        agents={agents}
      />

      <TodoFooter asOf={data?.asOf} agentAsOf={agentRaw?.asOf} />
    </main>
  );
}
