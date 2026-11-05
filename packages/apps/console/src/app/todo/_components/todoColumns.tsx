"use client";
// /todo · 列定义（P1 试点页 ord-20261104-032 · 列表模板 A）
// 从旧 TodoTable.tsx 的表格搬过来：判定逻辑/操作/权限一字不改，
// 只换成白名单 DataTable 的列定义；固定色值改为 CSS Module 的 data-* 选择器（不再内联 style）。
import { Button, Dropdown, Tooltip } from "@/components/primitives";
import { StateChip, Pill } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import { t as tr } from "@/i18n";
import { relTime, truncate } from "@/lib/format";
import { HUMAN_ID, TODO_SOURCE, TODO_STATUS, dueState } from "@/lib/todos";
import { parseDetail } from "@/components/TodoDetail";
import styles from "../page.module.css";

/** 状态 → StateChip 的 state（状态文案仍走 TODO_STATUS.label，界面不出现裸英文状态值）。 */
function chipState(status: string): "ok" | "warn" | "crit" | "idle" {
  if (status === "DONE") return "ok";
  if (status === "BLOCKED") return "crit";
  if (status === "DOING") return "warn";
  return "idle";
}

export function buildTodoColumns({
  tab,
  busy,
  act,
  onDecide,
  onApproveGovernance,
  agents,
}: {
  tab: string;
  busy: string | null;
  act: (id: string, patch: any, label: string) => void;
  onDecide: (row: any, option?: { key: string; label: string }) => void;
  onApproveGovernance?: (row: any) => void;
  agents: any[];
}): DataColumn<any>[] {
  return [
    {
      key: "priority",
      title: "优先级",
      width: "70px",
      render: (row: any) => <span className={styles.prio} data-prio={row.priority || ""}>{row.priority || "-"}</span>,
    },
    {
      key: "title",
      title: "待办",
      render: (row: any) => {
        const v = row.title;
        // 2026-11-05 修复：detail 可能是对象（历史数据），直接给 Tooltip/truncate 会触发 React #31
        const detailText = typeof row.detail === 'string' ? row.detail : row.detail ? JSON.stringify(row.detail) : '';
        const pd = parseDetail(detailText);
        const meta = typeof row.meta === "object" && row.meta ? row.meta : null;
        return (
          <div>
            <div className={styles.titleLine}>
              {pd.structured ? (
                <Tooltip title={`已按《待办详情结构规范》写: ${pd.sections.map((s) => "【" + s.title + "】").join(" ")}`}>
                  <span className={styles.tagRow}><Pill tone="ok">结构化 {pd.sections.length} 段</Pill></span>
                </Tooltip>
              ) : null}
              {meta?.options?.length ? <span className={styles.tagRow}><Pill tone="info">{meta.options.length} 个决策项</Pill></span> : null}
              {meta?.taskIds?.length ? <span className={styles.tagRow}><Pill tone="info">{meta.taskIds.length} 个关联任务</Pill></span> : null}
              {detailText ? (
                <Tooltip title={detailText}>
                  <span className={styles.dashed}>{truncate(v, 62)}</span>
                </Tooltip>
              ) : (
                truncate(v, 62)
              )}
            </div>
            {/* 2026-10-26：行高从 109–187px 收到 ~90px —— id 合并进标题行末尾，
                证据/备注移进「展开详情」（那里本来就有完整上下文），列表只留扫读必需的信息。 */}
            <div className="tiny mono todo-meta-line">
              {row.id}
              {row.evidence ? " · 证据 " + truncate(row.evidence, 28) : ""}
              {row.note ? " · 备注 " + truncate(row.note, 28) : ""}
            </div>
          </div>
        );
      },
    },
    {
      // 2026-10-26：把「负责人」「来源」合成一列 —— 原来各占 150/140px 且都会折行，合并后列表少一列、行高更稳。
      // TODO(数据卡 卡4 §8)：「来源会话」（session id）尚未入库（mind 侧 11-08 前补），补齐前这一列只显示
      //   来源类型 + 来源引用（sourceRefId 可点），不编造会话号。
      title: "负责方 / 来源",
      key: "ownerAndSource",
      width: "210px",
      render: (row: any) => {
        const s = TODO_SOURCE[row.source];
        const href = s?.href ? s.href(row.sourceRefId) : null;
        const owner = row.ownerType === "human" ? "人类" : tr("todo.owner.agent");
        const srcLabel = (s?.label || row.source || "—") + (row.sourceRefId ? " →" : "");
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
      key: "due",
      title: "截止",
      width: "130px",
      render: (row: any) => {
        const d = dueState(row.dueAt, row.status);
        return (
          <span className={styles.due} data-due={d.overdue ? "crit" : d.soon ? "warn" : "none"}>
            {d.label}{d.overdue ? " · 逾期" : d.soon ? " · 临近" : ""}
          </span>
        );
      },
    },
    {
      key: "status",
      title: "状态",
      width: "92px",
      render: (row: any) => (
        <Tooltip title={row.doneAt ? `完成于 ${relTime(row.doneAt)} by ${row.doneBy || "-"}` : undefined}>
          <StateChip state={chipState(row.status)} text={TODO_STATUS[row.status]?.label || row.status || "-"} />
        </Tooltip>
      ),
    },
    // 2026-10-26：「丢弃理由」只在「已丢弃」tab 才渲染（其余 tab 恒为「—」，白占 170px）。
    ...(tab === "DROPPED"
      ? [{
          // 2026-10-12 round 72-CW: **被丢弃的理由**要看得见（全库 3563 条 DROPPED，3244 带 meta.dedupReason）。
          title: "丢弃理由",
          key: "dropReason",
          width: "170px",
          render: (row: any) => {
            if (row.status !== "DROPPED") return <span className="tiny">—</span>;
            const r = row.dropReason ? String(row.dropReason) : "";
            if (!r) return <span className="tiny">无理由</span>;
            return (
              <Tooltip title={r}>
                <span className={styles.ellipsis}>{r.length > 42 ? r.slice(0, 42) + "..." : r}</span>
              </Tooltip>
            );
          },
        } as DataColumn<any>]
      : []),
    // 2026-10-26：验收列只在「已完成」tab 有意义（其余 tab 恒为「—」）。
    ...(tab === "DONE"
      ? [{
          // 2026-09-24：DONE 不等于验收通过 —— 待办状态与验收结论是两套状态，这里给整体可见结论。
          title: "验收",
          key: "acceptance",
          width: "100px",
          render: (row: any) => {
            const st = String(row.acceptanceState || "").toLowerCase() || "pending";
            const own = row.acceptance || {};
            const ta = row.taskAcceptance || {};
            const ownState = String(own.state || "").toLowerCase() || "pending";
            const labelOf = (s: string) => (s === "pass" ? "通过" : s === "fail" ? "未过" : "待判定");
            if (row.status !== "DONE" && st === "pending") return <span className="tiny">—</span>;
            const tip = [
              `整体验收: ${labelOf(st)}`,
              `待办自身判定: ${labelOf(ownState)}`,
              ta.total ? `升级任务 ${ta.total} 个: 通过 ${ta.pass} / 未过 ${ta.fail}` : "无升级任务",
              own.fails && own.fails.length ? `自身未过判据: ${own.fails.join(", ")}` : "",
              own.checkedAt ? `判定时间: ${own.checkedAt}` : "",
              "状态为已完成只代表做完了; 验收结论代表证据/判据是否达标, 两者独立。",
            ].filter(Boolean).join("\n");
            return (
              <Tooltip title={<div className={styles.tipBox}>{tip}</div>}>
                <StateChip
                  state={st === "pass" ? "ok" : st === "fail" ? "crit" : "idle"}
                  text={st === "pass" ? "通过" : st === "fail" ? "未过" : "待判定"}
                />
              </Tooltip>
            );
          },
        } as DataColumn<any>]
      : []),
    {
      key: "updated",
      title: "更新",
      width: "84px",
      render: (row: any) => <span className={styles.nowrap}>{relTime(row.updatedAt)}</span>,
    },
    {
      key: "actions",
      title: "操作",
      width: "230px",
      render: (row: any) => (
        <span className={styles.actions}>
          {row.status === "OPEN" ? (
            <Button size="small" type="link" className={styles.btnFlat} disabled={busy === row.id} onClick={() => act(row.id, { status: "DOING" }, "开始")}>开始</Button>
          ) : null}
          {row.status !== "DONE" && row.ownerType === "human" ? (
            // 人类待办: 不提供"裸完成"(那会丢掉决定内容), 改走"提交我的决定"
            <Button size="small" type="primary" ghost className={styles.btnFlat} disabled={busy === row.id} onClick={() => onDecide(row)}>
              提交我的决定
            </Button>
          ) : null}
          {row.status !== "DONE" && row.source === "knowledge_governance_review" && onApproveGovernance ? (
            // 2026-09-23 审核项=待办: 知识治理审核的通过 = 触发对应动作(dedupe apply) + 自动结单
            <Tooltip title={busy === row.id ? "正在执行 dedupe apply(需要跑脚本, 可能要 1-2 分钟), 完成后会自动结单" : "通过并执行对应治理动作(dedupe apply), 成功后自动结单并写证据"}>
              <Button size="small" type="primary" className={styles.btnFlat} loading={busy === row.id} disabled={busy === row.id} onClick={() => onApproveGovernance(row)}>
                {busy === row.id ? "执行中…" : "通过并执行"}
              </Button>
            </Tooltip>
          ) : null}
          {row.status !== "DONE" && row.ownerType !== "human" ? (
            <Button size="small" type="link" className={styles.btnFlat} disabled={busy === row.id} onClick={() => act(row.id, { status: "DONE" }, "标记完成")}>完成</Button>
          ) : null}
          {row.ownerId ? null : (
            <Button size="small" type="link" className={styles.btnFlat} disabled={busy === row.id} onClick={() => act(row.id, { ownerType: "human", ownerId: HUMAN_ID }, "指派给我")}>指派给我</Button>
          )}
          {row.status === "DONE" ? (
            <Button size="small" type="link" className={styles.btnFlat} disabled={busy === row.id} onClick={() => act(row.id, { status: "OPEN" }, "恢复")}>恢复</Button>
          ) : null}
          {row.status !== "BLOCKED" && row.status !== "DONE" ? (
            <Button size="small" type="link" className={styles.btnFlatDanger} disabled={busy === row.id} onClick={() => act(row.id, { status: "BLOCKED" }, "标记受阻")}>阻塞</Button>
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
            <Button size="small" type="link" className={styles.btnFlat} disabled={busy === row.id}>改派</Button>
          </Dropdown>
          <a className={styles.hidden} href="/api/todos?status=ALL" aria-hidden="true" tabIndex={-1}>接口</a>
        </span>
      ),
    },
    {
      key: "open",
      title: "",
      width: "48px",
      align: "right",
      render: (row: any) => <span className={styles.rowLink} aria-hidden="true">›</span>,
    },
  ];
}
