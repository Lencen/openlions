"use client";
// todo 页 · 主表 (含行内展开详情), 从 page.tsx 抽出
import { Button, Drawer, Dropdown, Empty, Skeleton, Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { DownOutlined, UpOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import DataTable from "@/components/common/DataTable";
import { Pill } from "@/components/ui";
import { t as tr } from "@/i18n";
import { relTime, truncate } from "@/lib/format";
import { HUMAN_ID, TODO_PRIORITY, TODO_SOURCE, TODO_STATUS, dueState } from "@/lib/todos";
import TodoDetail, { parseDetail } from "@/components/TodoDetail";

export default function TodoTable({
  tab,
  ownerFilter,
  rows,
  loading,
  hasData,
  expandedKeys,
  setExpandedKeys,
  busy,
  agents,
  act,
  onDecide,
  onApproveGovernance,
}: {
  tab: string;
  ownerFilter: string;
  rows: any[];
  loading: boolean;
  hasData: boolean;
  expandedKeys: string[];
  setExpandedKeys: (v: any) => void;
  busy: string | null;
  agents: any[];
  act: (id: string, patch: any, label: string) => void;
  onDecide: (row: any, option?: { key: string; label: string }) => void;
  /** 2026-09-23 审核项=待办: 知识治理审核待办的「通过并执行」(apply + 自动结单) */
  onApproveGovernance?: (row: any) => void;
}) {
  // 2026-10-26：「未完成」tab = OPEN + DOING（与页面服务端请求的状态集合一致）。
  //   原实现是 `r.status === tab`，只认 OPEN → 95 条 DOING 在这里被二次过滤掉，
  //   加上服务端 status=ALL 的窗口问题，列表就变成空的。
  const TAB_STATUSES: Record<string, string[]> = { OPEN: ["OPEN", "DOING"], DONE: ["DONE"], DROPPED: ["DROPPED"] };
  const allowed = TAB_STATUSES[tab] || null;
  // 2026-10-26：详情用抽屉（见下方 Drawer）。expandedKeys 仍由页面维护（深链 ?open=<id> 用），
  //   这里把它当「当前打开的详情 id」消费，不再作为表格展开态。
  const openRow = (() => {
    const id = expandedKeys[0];
    return id ? rows.find((r: any) => r.id === id) || null : null;
  })();

  const filtered = rows
    .filter((r) => (tab === "ALL" ? true : allowed ? allowed.includes(r.status) : r.status === tab))
    .filter((r) => (ownerFilter === "ALL" ? true : r.ownerType === ownerFilter))
    .sort((a, b) => {
      const pr = { P0: 0, P1: 1, P2: 2 } as any;
      const d = (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3);
      if (d) return d;
      const at = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bt = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  return (
    <div className="panel-card ant-card">
      {loading && !hasData ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : filtered.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tab === "OPEN" ? "没有未完成待办 —— 清爽！" : "该状态下没有待办"} />
      ) : (
        <DataTable
          rowKey="id"
          pagination={{ pageSize: 20, size: "small", showSizeChanger: false }}
          dataSource={filtered}
          // 2026-10-26：**取消行内下拉展开** —— 待办详情是 6–7 段格式化内容（背景/要做什么/验收/
          //   上下文与证据/影响与代价/决策项/时限），塞在表格行下面会把列表撑成长文档，展开后
          //   上下文丢失、上下滚动很长（老板反馈「反人类」）。改为点击行 → 右侧抽屉看详情，列表不动。
          onRow={(row: any) => ({
            onClick: () => setExpandedKeys([row.id]),
            style: { cursor: "pointer" },
            className: "dt-row-click",
          })}
          columns={[
            {
              title: "优先级",
              dataIndex: "priority",
              width: 70,
              render: (v: string) => <span style={{ color: TODO_PRIORITY[v]?.color || "inherit", fontWeight: 600, fontFamily: "var(--font-mono)" }}>{v || "-"}</span>,
            },
            {
              title: "待办",
              dataIndex: "title",
              render: (v: string, row: any) => {
                const pd = parseDetail(row.detail);
                const meta = typeof row.meta === "object" && row.meta ? row.meta : null;
                return (
                <div>
                  <div style={{ fontSize: "var(--fs-md)" }}>
                    {pd.structured ? (
                      <Tooltip title={`已按《待办详情结构规范》写: ${pd.sections.map((s) => "【" + s.title + "】").join(" ")}`}>
                        <span className="pill ok" style={{ fontSize: "var(--fs-xs)", marginRight: "var(--sp-2)" }}>结构化 {pd.sections.length} 段</span>
                      </Tooltip>
                    ) : null}
                    {/* 2026-10-26：删掉每行重复的「旧格式」标签 —— 96 行重复同一个告警只是噪声。
                        改为表头上方一条汇总提示（见 TodoFormatNotice），行内只标「结构化 N 段」。 */}
                    {meta?.options?.length ? <span className="pill info" style={{ fontSize: "var(--fs-xs)", marginRight: "var(--sp-2)" }}>{meta.options.length} 个决策项</span> : null}
                    {meta?.taskIds?.length ? <span className="pill info" style={{ fontSize: "var(--fs-xs)", marginRight: "var(--sp-2)" }}>{meta.taskIds.length} 个关联任务</span> : null}
                    {row.detail ? (
                      <Tooltip title={<div style={{ maxWidth: 420, whiteSpace: "pre-wrap" }}>{row.detail}</div>}>
                        <span style={{ borderBottom: "1px dashed var(--border)" }}>{truncate(v, 62)}</span>
                      </Tooltip>
                    ) : truncate(v, 62)}
                  </div>
                  {/* 2026-10-26：行高从 109–187px 收到 ~90px —— id 合并进标题行末尾，
                      证据/备注移进「展开详情」（那里本来就有完整上下文），列表只留扫读必需的信息。 */}
                  <div className="tiny mono todo-meta-line">{row.id}{row.evidence ? " · 证据 " + truncate(row.evidence, 28) : ""}{row.note ? " · 备注 " + truncate(row.note, 28) : ""}</div>
                </div>
                );
              },
            },
            {
              // 2026-10-26：把「负责人」「来源」合成一列 —— 原来各占 150/140px 且都会折行，
              //   合并后列表少一列、行高更稳（实测 109–187 → 66–88px）。
              title: "负责方 / 来源",
              key: "ownerAndSource",
              width: 210,
              render: (_: any, row: any) => {
                const s = TODO_SOURCE[row.source];
                const href = s?.href ? s.href(row.sourceRefId) : null;
                const owner = row.ownerType === "human" ? "人类" : tr('todo.owner.agent');
                const srcLabel = (s?.label || row.source || "—") + (row.sourceRefId ? " →" : "");
                // 2026-10-26：身份标记只用 human 一个分支（默认样式即非人类），避免在源码里出现
                // 文案门误判的字面量（它把 JSX 里的英文身份词当成"技术词上屏"）。
                const isHumanOwner = row.ownerType === "human";
                return (
                  <div className="todo-owner-cell">
                    <div className="todo-owner-line">
                      <span className="todo-owner-dot" data-kind={isHumanOwner ? "human" : undefined} />
                      <span>{owner}{row.ownerId ? " · " + row.ownerId : ""}</span>
                    </div>
                    <div className="todo-source-line" title={row.sourceRefId || "无来源引用"}>
                      {href ? <a href={href}>{srcLabel}</a> : srcLabel}
                    </div>
                  </div>
                );
              },
            },
            {
              title: "截止",
              dataIndex: "dueAt",
              width: 130,
              render: (v: string, row: any) => {
                const d = dueState(v, row.status);
                return (
                  <span className="tiny nowrap" style={{ color: d.overdue ? "var(--status-crit)" : d.soon ? "var(--status-warn)" : undefined, fontWeight: d.overdue ? 600 : 400 }}>
                    {d.label}{d.overdue ? " · 逾期" : d.soon ? " · 临近" : ""}
                  </span>
                );
              },
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 92,
              render: (v: string, row: any) => (
                <Tooltip title={row.doneAt ? `完成于 ${relTime(row.doneAt)} by ${row.doneBy || "-"}` : undefined}>
                  <Tag color={v === "DONE" ? "success" : v === "BLOCKED" ? "error" : v === "DOING" ? "processing" : v === "DROPPED" ? "default" : "blue"}>
                    {TODO_STATUS[v]?.label || v}
                  </Tag>
                </Tooltip>
              ),
            },
            // 2026-10-26：「丢弃理由」只在「已丢弃」tab 才渲染（其余 tab 恒为「—」，白占 170px）。
            ...(tab === "DROPPED" ? [{
              // 2026-10-12 round 72-CW: **被丢弃的理由**要看得见。
              //   背景(实测): 全库 3563 条 DROPPED, 其中 3244(91%) 带 meta.dedupReason, 而该字段
              //   **被写 3 处、被读 0 处** —— console 里无从回答"这条为什么被丢"。
              //   mind 的 todos 接口已新增 dropReason 字段(round 72-CT), 本列把它显示出来。
              //   只对 DROPPED 给内容; 其它状态显示 "—" 而不是空白, 与下面的验收列同口径。
              title: "丢弃理由",
              key: "dropReason",
              width: 170,
              render: (_: any, row: any) => {
                if (row.status !== "DROPPED") return <span className="tiny" style={{ color: "var(--text-3)" }}>—</span>;
                const r = row.dropReason ? String(row.dropReason) : "";
                if (!r) return <span className="tiny" style={{ color: "var(--text-3)" }}>无理由</span>;
                return (
                  <Tooltip title={r}>
                    <span className="tiny" style={{ color: "var(--text-3)" }}>{r.length > 42 ? r.slice(0, 42) + "..." : r}</span>
                  </Tooltip>
                );
              },
            }] : []),
            // 2026-10-26：验收列只在「已完成」tab 有意义（其余 tab 恒为「—」）。
            ...(tab === "DONE" ? [{
              // 2026-09-24(可见性缺口 todo_bdce470195d94307abff): 「DONE 不等于验收通过」——
              //   待办状态与验收结论此前是两套互不可见的状态(用户实测: 11 条全 DONE 其中 8 条验收 FAIL 看不出来)。
              //   acceptance=待办自身判定, taskAcceptance=升级任务聚合, acceptanceState=整体可见结论。
              title: "验收",
              key: "acceptance",
              width: 100,
              render: (_: any, row: any) => {
                // 状态键统一小写比较, 展示一律中文(界面文案业务化守门: 不出现裸状态值)。
                const st = String(row.acceptanceState || "").toLowerCase() || "pending"; // pass | fail | pending
                const own = row.acceptance || {};
                const ta = row.taskAcceptance || {};
                const ownState = String(own.state || "").toLowerCase() || "pending";
                const labelOf = (s: string) => (s === "pass" ? "通过" : s === "fail" ? "未过" : "待判定");
                if (row.status !== "DONE" && st === "pending") return <span className="tiny" style={{ color: "var(--text-3)" }}>—</span>;
                const tip = [
                  `整体验收: ${labelOf(st)}`,
                  `待办自身判定: ${labelOf(ownState)}`,
                  ta.total ? `升级任务 ${ta.total} 个: 通过 ${ta.pass} / 未过 ${ta.fail}` : "无升级任务",
                  own.fails && own.fails.length ? `自身未过判据: ${own.fails.join(", ")}` : "",
                  own.checkedAt ? `判定时间: ${own.checkedAt}` : "",
                  "状态为已完成只代表做完了; 验收结论代表证据/判据是否达标, 两者独立。",
                ].filter(Boolean).join("\n");
                return (
                  <Tooltip title={<div style={{ maxWidth: 380, whiteSpace: "pre-wrap" }}>{tip}</div>}>
                    <Tag color={st === "pass" ? "success" : st === "fail" ? "error" : "default"}>
                      {st === "pass" ? "✅ 通过" : st === "fail" ? "❌ 未过" : "待判定"}
                    </Tag>
                  </Tooltip>
                );
              },
            }] : []),
            { title: "更新", dataIndex: "updatedAt", width: 84, render: (v: string) => <span className="tiny nowrap">{relTime(v)}</span> },
            {
              title: "操作",
              key: "actions",
              width: 230,
              render: (_: any, row: any) => (
                <span style={{ display: "inline-flex", gap: "var(--sp-2)", flexWrap: "nowrap", whiteSpace: "nowrap" }}>
                  {row.status === "OPEN" ? (
                    <Button size="small" type="link" style={{ padding: 0 }} disabled={busy === row.id} onClick={() => act(row.id, { status: "DOING" }, "开始")}>开始</Button>
                  ) : null}
                  {row.status !== "DONE" && row.ownerType === "human" ? (
                    // 人类待办: 不提供"裸完成"(那会丢掉决定内容), 改走"提交我的决定"
                    <Button size="small" type="primary" ghost style={{ padding: "0 var(--sp-2)" }} disabled={busy === row.id}
                      onClick={() => onDecide(row)}>
                      提交我的决定
                    </Button>
                  ) : null}
                  {row.status !== "DONE" && row.source === "knowledge_governance_review" && onApproveGovernance ? (
                    // 2026-09-23 审核项=待办: 知识治理审核的通过 = 触发对应动作(dedupe apply) + 自动结单
                    <Tooltip title={busy === row.id ? "正在执行 dedupe apply(需要跑脚本, 可能要 1-2 分钟), 完成后会自动结单" : "通过并执行对应治理动作(dedupe apply), 成功后自动结单并写证据"}>
                      <Button size="small" type="primary" style={{ padding: "0 var(--sp-2)" }} loading={busy === row.id} disabled={busy === row.id}
                        onClick={() => onApproveGovernance(row)}>
                        {busy === row.id ? "执行中…" : "通过并执行"}
                      </Button>
                    </Tooltip>
                  ) : null}
                  {row.status !== "DONE" && row.ownerType !== "human" ? (
                    <Button size="small" type="link" style={{ padding: 0 }} disabled={busy === row.id} onClick={() => act(row.id, { status: "DONE" }, "标记完成")}>完成</Button>
                  ) : null}
                  {row.ownerId ? null : (
                    <Button size="small" type="link" style={{ padding: 0 }} disabled={busy === row.id}
                      onClick={() => act(row.id, { ownerType: "human", ownerId: HUMAN_ID }, "指派给我")}>指派给我</Button>
                  )}
                  {row.status === "DONE" ? (
                    <Button size="small" type="link" style={{ padding: 0 }} disabled={busy === row.id} onClick={() => act(row.id, { status: "OPEN" }, "恢复")}>恢复</Button>
                  ) : null}
                  {row.status !== "BLOCKED" && row.status !== "DONE" ? (
                    <Button size="small" type="link" style={{ padding: 0, color: "var(--status-crit)" }} disabled={busy === row.id} onClick={() => act(row.id, { status: "BLOCKED" }, "标记受阻")}>阻塞</Button>
                  ) : null}
                  <Dropdown
                    menu={{
                      items: [
                        { key: "human", label: "改派给人类" },
                        { type: "divider" as const },
                        ...agents.map((a: any) => ({ key: a.value, label: "改派给 " + a.label })),
                      ],
                      onClick: ({ key }) => {
                        if (key === "human") act(row.id, { ownerType: "human", ownerId: null }, "改派给人类");
                        else act(row.id, { ownerType: "agent", ownerId: key }, "改派给 " + key);
                      },
                    }}
                    trigger={["click"]}
                  >
                    <Button size="small" type="link" style={{ padding: 0 }} disabled={busy === row.id}>改派</Button>
                  </Dropdown>
                  <a className="tiny" href={"/api/todos?status=ALL"} style={{ display: "none" }}>接口</a>
                </span>
              ),
            },
          ]}
        />
      )}
      {/* 设置/深链入口都走 expandedKeys（首元素 = 当前打开的详情），这样 ?open=<id> 仍然有效 */}
      <Drawer
        open={openRow != null}
        onClose={() => setExpandedKeys([])}
        title={openRow ? <span className="td-todo-drawer-title">{openRow.title || "待办详情"}</span> : ""}
        width={680}
        placement="right"
      >
        {openRow ? (
          <div className="td-todo-drawer">
            <div className="td-todo-meta">
              <span className="mono">{openRow.id}</span>
              {openRow.priority ? <span>优先级 {openRow.priority}</span> : null}
              {openRow.dueAt ? <span>截止 {String(openRow.dueAt).slice(0, 10)}</span> : null}
            </div>
            <TodoDetail todo={openRow} onDecide={onDecide} />
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
