"use client";
import { interactiveProps } from "@/components/a11y";
import { Fragment } from "react";
import { t } from "@/i18n";
import { scopeDef, scopeOfType, stripTypePrefix } from "@/config/taskScopes";
import DetailView from "./TaskDetailView";
import { badgeCls, fmtTs } from "./shared";
import type { Detail, Item } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";

// 2026-09-15 用户反馈: 「改进任务列表里我看不出来这个任务是哪个 agent 做的」。
//   原因有二: ① mind 侧 API 根本没返回承接执行体(assignedAgent), 只有 completedBy;
//   ② completedBy 在未完成任务上恒为 null, 在 cron 自产任务上又是 cron:v16:improving-tasks 这类系统串。
//   现在: 列表新增「执行体」一栏(承接者 + 完成者分开写), 并在表头给出本页执行体分布。
const isSystemActor = (v: string) => v.startsWith("cron:") || v.startsWith("system:");
const actorLabel = (v: string) => (isSystemActor(v) ? "平台定时任务" : v);

/** 任务列表（点击行展开结构化详情 / 执行链 / 数据流向） */
export default function TasksTable({
  items,
  loading,
  expandedId,
  details,
  detailLoading,
  onToggle,
}: {
  items: Item[];
  loading: boolean;
  expandedId: string | null;
  details: Record<string, Detail>;
  detailLoading: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="panel"><div className="panel-header">
      <span className="panel-title">任务列表（点击行展开结构化详情 / 执行链 / 数据流向）</span>
      {/* 2026-09-15: 一屏看清"这些活是谁在干"(用户反馈看不出执行体) */}
      <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>
        执行体分布: {(() => {
          const m = new Map<string, number>();
          for (const it of items) {
            const k = it.assignedAgent || (it.completedBy ? actorLabel(it.completedBy) : "未指派(公开队列)");
            m.set(k, (m.get(k) || 0) + 1);
          }
          // 注意: 本仓库 tsconfig 未开 downlevelIteration, Map 迭代器不能直接展开(会报 TS2802), 用 Array.from。
          const top = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
          return top.length ? top.map(([k, v]) => k + " " + v).join(" · ") : "—";
        })()}
      </span>
    </div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>状态</th><th>{t('tasks.col.scope')}</th><th>标题</th><th>主题</th><th>优先级</th><th title="承接该任务的执行体 / 真正完成它的执行体(两者不同时分行显示)">执行体</th><th>更新时间</th><th style={{ width: 96 }}>操作</th></tr></thead><tbody>
        {items.length === 0 && (<tr><td colSpan={8} style={{ textAlign: "center", color: "var(--text-dim)", padding: "var(--sp-4)" }}>{loading ? "加载中…" : "无任务"}</td></tr>)}
        {items.map((m) => {
          const open = expandedId === m.id;
          return (
            <Fragment key={m.id}>
              <tr {...interactiveProps(expandedId === m.id)} style={{ cursor: "pointer" }} onClick={() => onToggle(m.id)}>
                <td><span className={badgeCls(m.status)}>{m.status}</span></td>
                <td className="nowrap" style={{ fontSize: "var(--fs-base)" }}>
                  {(() => {
                    const sd = scopeDef(m.scope || scopeOfType(m.type));
                    return (
                      <>
                        <span title={sd.desc} style={{ color: sd.color, fontWeight: 600 }}>{sd.short}</span>
                        <span style={{ color: "var(--text-muted)", marginLeft: "var(--sp-1)" }}>{m.type || "-"}</span>
                      </>
                    );
                  })()}
                </td>
                <td style={{ color: open ? "var(--primary)" : "inherit", fontSize: "var(--fs-md)" }}>{stripTypePrefix(m.title, m.type).slice(0, 110) || m.id}</td>
                <td className="nowrap" style={{ fontSize: "var(--fs-base)" }}>{m.theme || "-"}</td>
                <td className="nowrap" style={{ fontSize: "var(--fs-base)" }}>{m.priority || "-"}</td>
                <td className="nowrap" style={{ fontSize: "var(--fs-base)" }}>
                  {(() => {
                    const assigned = m.assignedAgent || null;
                    const done = m.completedBy || null;
                    if (!assigned && !done) return <span style={{ color: "var(--text-dim)" }} title="没有承接执行体, 留在公开队列等认领">未指派</span>;
                    const head = assigned || (done ? actorLabel(done) : "");
                    const showDone = !!done && done !== assigned;
                    return (
                      <>
                        <div style={{ fontWeight: 600 }} title={assigned ? "承接执行体: " + assigned : "无承接执行体, 由平台任务产生"}>{
                          done && !assigned && isSystemActor(done) ? "平台定时任务" : head
                        }</div>
                        {showDone && <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }} title={"完成者: " + done}>完成 {actorLabel(done)}</div>}
                      </>
                    );
                  })()}
                </td>
                <td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTs(m.updatedAt ?? m.createdAt)}</td>
                <td className="nowrap">
                  {/* 2026-09-10: 任务详情独立页 + 针对该任务的讨论 */}
                  <a
                    href={"/flywheel/tasks/" + m.id}
                    onClick={(e) => e.stopPropagation()}
                    style={{ fontSize: "var(--fs-base)", color: "var(--primary)", textDecoration: "none" }}
                    title={t('tasks.open.tip')}
                  >
                    详情 →
                  </a>
                </td>
              </tr>
              {open && (
                <tr><td colSpan={8} style={{ background: "var(--bg-hover)", padding: 0, borderTop: "1px solid var(--border)" }}>
                  <div style={{ padding: "var(--sp-3-5) 18px" }}>
                    {detailLoading === m.id ? "详情加载中…" : details[m.id] ? <DetailView d={details[m.id]} fmtTs={fmtTs} /> : "详情加载失败"}
                  </div>
                </td></tr>
              )}
            </Fragment>
          );
        })}
      </tbody></table>
    </div>
  );
}
