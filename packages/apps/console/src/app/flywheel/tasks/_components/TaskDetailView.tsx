"use client";
import { useState, type ReactNode } from "react";
import { scopeDef, scopeOfType } from "@/config/taskScopes";
import { artifactLabel } from "@/config/artifactTypes";
import { t } from "@/i18n";
import { badgeCls } from "./shared";
import type { Detail } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "var(--sp-3)" }}>
      <div style={{ fontWeight: 600, fontSize: "var(--fs-md)", marginBottom: "var(--sp-1-5)", color: "var(--primary)" }}>{title}</div>
      {children}
    </div>
  );
}
function KV({ k, v }: { k: string; v: ReactNode }) {
  return <div style={{ fontSize: "var(--fs-base)", marginBottom: "var(--sp-0-5)" }}><span style={{ color: "var(--text-dim)" }}>{k}: </span>{v}</div>;
}
function Pre({ s }: { s: string }) {
  return <pre style={{ fontSize: "var(--fs-sm)", whiteSpace: "pre-wrap", margin: 0, maxHeight: 260, overflow: "auto" }}>{s}</pre>;
}

/**
 * 来源/关联待办内联(2026-09-21, 用户反馈"由待办升级的任务看不到原待办内容"):
 *   由待办升级的任务 task.sourceTaskId 为空, 反向链接存在 Todo.meta.taskIds/sourceRefId;
 *   API(flywheel-tasks?detail=) 已反查 sourceTodos(含完整 detail), 这里原样展示。
 */
function SourceTodoSection({ todos }: { todos?: Detail["sourceTodos"] }) {
  if (!todos || !todos.length) return null;
  return (
    <Section title={"来源/关联待办（" + todos.length + "）—— 升级任务展示来源待办详情"}>
      <div style={{ display: "grid", gap: "var(--sp-2)" }}>
        {todos.map((t) => (
          <div key={t.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg-surface)", padding: "var(--sp-2) var(--sp-3)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap", marginBottom: "var(--sp-1)" }}>
              <span className={badgeCls(t.status)}>{t.status}</span>
              <span style={{ fontSize: "var(--fs-base)", fontWeight: 600 }}>{t.title}</span>
              <span className="mono tiny" style={{ marginLeft: "auto" }}>{t.id}</span>
            </div>
            {t.ownerType ? (
              <div className="tiny" style={{ marginBottom: "var(--sp-1)" }}>
                负责人 {t.ownerType}:{t.ownerId || "未指派"} · 来源 {t.source || "-"}
              </div>
            ) : null}
            {t.detail ? <Pre s={String(t.detail)} /> : <span className="tiny">（该待办无 detail）</span>}
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function DetailView({ d, fmtTs }: { d: Detail; fmtTs: (v?: string | null) => string }) {
  const task = d.task;
  const ps = d.payloadSummary;
  let payloadRaw: any = null;
  try { payloadRaw = JSON.parse(task?.improvementPayload || "null"); } catch { payloadRaw = null; }
  let mat: any = null;
  try { mat = task?.materials ? JSON.parse(task.materials) : null; } catch { mat = task?.materials; }
  return (
    <div>
      <div style={{ display: "flex", gap: "var(--sp-2-5)", alignItems: "center", marginBottom: "var(--sp-2)", flexWrap: "wrap" }}>
        <a href={"/flywheel/tasks/" + task?.id} style={{ fontSize: "var(--fs-base)", color: "var(--primary)" }}>{t('tasks.open.link')}</a>
        <span className={badgeCls(task?.status)}>{task?.status}</span>
        <span style={{ fontSize: "var(--fs-base)" }}>
          {(() => { const sd = scopeDef(scopeOfType(task?.improvementType)); return <span style={{ color: sd.color, fontWeight: 600 }}>{sd.label}</span>; })()}
          {" · "}{task?.improvementType || "-"} · 主题: {task?.theme || "-"} · 优先级: {task?.priority || "-"}{task?.manualReview ? " · 需人审" : ""}
        </span>
        <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>创建 {fmtTs(task?.createdAt)}{task?.completedBy ? " · 完成 " + task?.completedBy + " " + fmtTs(task?.completedAt) : ""}</span>
      </div>
      {/* 2026-09-21: 由待办升级的任务 —— 内联来源待办完整详情(用户反馈"内容不显示在任务详情") */}
      <SourceTodoSection todos={d.sourceTodos} />
      <Section title="来源与关联（结构化）">
        <KV k="反思ID (sourceReflectionIds)" v={task?.sourceReflectionIds || "-"} />
        {d.structured?.reflectionId && <KV k="FlywheelReflection id" v={d.structured.reflectionId} />}
        {d.structured?.reflectionUpdatedAt && <KV k="反思更新时间" v={fmtTs(d.structured.reflectionUpdatedAt)} />}
        {d.structured?.sourceChain && <KV k="来源链" v={JSON.stringify(d.structured.sourceChain)} />}
        {d.structured?.relatedMemoryCount != null && <KV k="关联活跃记忆数" v={String(d.structured.relatedMemoryCount)} />}
        {ps?.relatedMemoryIds && ps.relatedMemoryIds.length > 0 && (
          <KV k="关联记忆ID（真实）" v={ps.relatedMemoryIds.slice(0, 16).map((i) => i.slice(-6)).join(", ") + (ps.relatedMemoryIds.length > 16 ? " …" : "")} />
        )}
      </Section>
      <Section title="结构化摘要（payload: 动作 / 发现 / 反思轮次）">
        {ps ? (
          <div>
            <KV k="动作数" v={String(ps.actionCount) + "（" + Object.entries(ps.actionTypes).map(([k, v]) => k + "×" + v).join(", ") + "）"} />
            <KV k="发现数 findings" v={String(ps.findingCount)} />
            <KV k="反思轮次 cycles" v={String(ps.cycleCount)} />
                {ps.aliasedThemes && ps.aliasedThemes.length > 0 && <KV k="别名并入主题 (aliasedThemes)" v={ps.aliasedThemes.join(", ")} />}
            {ps.coverageScore != null && <KV k="coverage" v={ps.coverageScore.toFixed(4)} />}
          </div>
        ) : <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>无 payload</span>}
        {payloadRaw && (
          <details style={{ marginTop: "var(--sp-1-5)" }}><summary style={{ cursor: "pointer", fontSize: "var(--fs-base)" }}>查看原始数据（动作/发现/循环/别名主题）</summary>
            <Pre s={JSON.stringify(payloadRaw, null, 1).slice(0, 4200)} />
          </details>
        )}
      </Section>
      <Section title="完整描述（进入任务即可见上下文）"><Pre s={task?.description || "(无)"} /></Section>
      {task?.background && <Section title="背景 / 来源"><Pre s={task.background} /></Section>}
      {task?.requirements && <Section title="要求"><Pre s={task.requirements} /></Section>}
      {task?.acceptanceCriteria && <Section title="验收标准"><Pre s={task.acceptanceCriteria} /></Section>}
      {mat != null && (
        <Section title="素材 materials（源反思/关联数据）">
          <details><summary style={{ cursor: "pointer", fontSize: "var(--fs-base)" }}>查看 materials</summary>
            <Pre s={typeof mat === "string" ? mat : JSON.stringify(mat, null, 1).slice(0, 3200)} />
          </details>
        </Section>
      )}
      <Section title="执行结论 / 失败明细（逐项审视结果，来自 Transition.reason）">
        {(() => {
          const trs = d.transitions || [];
          const last = trs[trs.length - 1];
          if (!last) return <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>无执行记录</div>;
          const full = String(last.reason || "");
          const failed = task?.status === "FAILED" || last.toStatus === "FAILED";
          const lines = full.split("\n");
          const detailLines = lines.filter((l) => /\[(DONE|SKIP|SKIPPED|ERROR|DRYRUN)\]/i.test(l));
          return (
            <div>
              <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)", marginBottom: "var(--sp-1)" }}>
                {last.fromStatus} → {last.toStatus} · {last.actor} · {fmtTs(last.createdAt)} · 明细 {detailLines.length} 项{failed ? " · 失败需复核" : ""}
              </div>
              {detailLines.length > 0 && (
                <table className="tbl" style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--sp-1-5)" }}><tbody>
                  {detailLines.map((l, i) => {
                    const m = l.match(/\[(\w+)\]\s*([^:]+):\s*(.*)/);
                    const st = m ? m[1] : "";
                    const color = /ERROR/i.test(st) ? "var(--status-crit)" : /SKIP/i.test(st) ? "var(--status-warn)" : "var(--status-ok)";
                    return (
                      <tr key={i}>
                        <td className="nowrap"><span style={{ color, fontWeight: 600 }}>{st}</span></td>
                        <td className="nowrap mono">{m ? m[2] : ""}</td>
                        <td style={{ color: "var(--text-dim)" }}>{m ? m[3] : l}</td>
                      </tr>
                    );
                  })}
                </tbody></table>
              )}
              <details open={failed}><summary style={{ cursor: "pointer", fontSize: "var(--fs-base)" }}>查看完整结论全文（{full.length} 字符）</summary>
                <Pre s={full.slice(0, 4000)} />
              </details>
            </div>
          );
        })()}
      </Section>
      <Section title="执行链（任务状态流转审计）">
        <TableCopyButton />
        <table className="tbl" style={{ fontSize: "var(--fs-sm)" }}><tbody>
          {(d.transitions || []).map((tr, i) => (
            <tr key={i}><td className="nowrap">{tr.fromStatus || "?"} → {tr.toStatus}</td><td className="nowrap">{tr.actor}</td><td className="nowrap mono">{fmtTs(tr.createdAt)}</td><td style={{ color: "var(--text-dim)" }}>{(tr.reason || "").slice(0, 220)}</td></tr>
          ))}
          {(d.transitions || []).length === 0 && <tr><td colSpan={4} style={{ color: "var(--text-dim)" }}>无</td></tr>}
        </tbody></table>
      </Section>
      {(d.executions || []).length > 0 && (
        <Section title={t('tasks.l2.title')}>
          {d.executions.map((e, i) => (
            <div key={i} style={{ marginBottom: "var(--sp-2)", padding: "var(--sp-2)", background: "rgba(127,127,127,.08)", borderRadius: "var(--radius-sm)" }}>
              <div style={{ color: "var(--text-dim)", marginBottom: "var(--sp-1)", fontSize: "var(--fs-base)" }}>{e.agentId} · {e.status}{e.completedAt ? " · " + fmtTs(e.completedAt) : ""}</div>
              <Pre s={(e.output || e.problemsEncountered || "").slice(0, 1000)} />
            </div>
          ))}
        </Section>
      )}
      <Section title="数据流向：本任务完成后落库的产物">
        {(d.produced || []).length === 0 && <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>{t('tasks.noProduct')}</div>}
        {(d.produced || []).map((p) => (
          <div key={p.type} style={{ marginBottom: "var(--sp-2)", fontSize: "var(--fs-base)" }}>
            <div><strong>{artifactLabel(p.type)}</strong> · {p.count} {t('biz.sourceType.taskProduct')}</div>
            <div style={{ color: "var(--text-dim)", marginTop: "var(--sp-0-5)" }}>
              {p.samples.map((s) => (
                <div key={s.id}>• <span className="mono">{s.id.slice(-8)}</span> {s.title}（{fmtTs(s.createdAt)}）</div>
              ))}
              {p.count > p.samples.length && <div>… 共 {p.count} 条</div>}
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
