"use client";
// 2026-09-10 新增: 待办中心 (TODO 独立成平台一等实体)
// 与飞轮"改进任务"(机制修复) 分开: TODO 是具体行动项, 含只有人能做的事(授权/采购/决策/签字)。
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数/状态与拼装 (<200 行)。
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Form, ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { useMergedApi } from "@/lib/useMergedApi";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { OPEN_STATUSES, createTodo, dueState, isToday, patchTodo, HUMAN_ID } from "@/lib/todos";
import TodoHero from "./_components/TodoHero";
import TodoMetrics from "./_components/TodoMetrics";
import TodoBacklogTrend from "./_components/TodoBacklogTrend";
import TodoDistribution from "./_components/TodoDistribution";
import TodoFilterBar from "./_components/TodoFilterBar";
import TodoTable from "./_components/TodoTable";
import TodoDecideModal from "./_components/TodoDecideModal";
import TodoCreateModal from "./_components/TodoCreateModal";
import TodoFooter from "./_components/TodoFooter";
import QueueBoundary from "@/components/common/QueueBoundary";

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
  // 2026-10-26 修（老板报「待办列表空」）：原实现用 `status=ALL` 取 500 条再在客户端按 tab 过滤，
  //   而 status=ALL 在 mind 侧是「不加状态条件」→ 窗口被 4000+ 条 DONE/DROPPED 占满，
  //   未完成 96 条一条都进不来，页面显示「没有未完成待办 —— 清爽！」。
  //   现在改为**服务端按 tab 状态过滤**：未完成 tab = OPEN + DOING 两次请求合并（mind 不支持多状态）。
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
    } catch { /* ignore */ }
  }, []);
  const { data: agentRaw } = useApi<any>("/api/agent-list");
  const agents = useMemo(() => {
    const list = Array.isArray(agentRaw) ? agentRaw : (agentRaw?.items ?? agentRaw?.result?.data ?? []);
    return (Array.isArray(list) ? list : []).filter((a: any) => a?.agent_id).map((a: any) => ({ value: a.agent_id, label: `${a.display_name || a.agent_id} (${a.agent_id})` }));
  }, [agentRaw]);

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

  return (
    <main className="page">
      <TodoHero
        openCount={openAll}
        humanOpen={data?.humanOpen ?? 0}
        overdueCount={overdue.length}
        doneTodayCount={doneToday.length}
        rowsCount={rows.length}
        asOf={data?.asOf}
        onRefresh={() => setNonce((n) => n + 1)}
      />

      {/* UI-9: 说清「改进任务」与「待办」的区别 (从哪来 / 谁做) */}
      <QueueBoundary current="todo" />

      {/* 2026-10-15（规范 §2「错误态必须给下一步动作」）：原来只有一行报错文本, 没有动作 ✗ -> 补[重试]。 */}
      {error ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
          <Alert type="error" showIcon style={{ flex: 1 }} title="待办加载失败" description={String(error?.message || "") + "（可重试）"} />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => mutate()}>重试</Button>
        </div>
      ) : null}
      {data && data.ok === false && data.error ? (
        <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-3)" }} title="上游提示" description={data.error} />
      ) : null}
      {feedback ? (
        <Alert
          type={feedback.type === "ok" ? "success" : "error"}
          showIcon
          closable
          style={{ marginBottom: "var(--sp-3)" }}
          title={feedback.msg}
          onClose={() => setFeedback(null)}
        />
      ) : null}

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

      <TodoFilterBar
        tab={tab}
        onTab={setTab}
        ownerFilter={ownerFilter}
        onOwnerFilter={setOwnerFilter}
        rowsCount={rows.length}
        counts={counts}
        loading={loading && !data}
        onCreate={() => setCreateOpen(true)}
      />

      <TodoTable
        tab={tab}
        ownerFilter={ownerFilter}
        rows={rows}
        loading={loading}
        hasData={!!data}
        expandedKeys={expandedKeys}
        setExpandedKeys={setExpandedKeys}
        busy={busy}
        agents={agents}
        act={act}
        onDecide={(row, option) => { setDecideRow(row); setDecideText(option ? "采纳选项 " + option.key + "：" + option.label : String(row.note || "")); }}
        onApproveGovernance={approveGovernance}
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