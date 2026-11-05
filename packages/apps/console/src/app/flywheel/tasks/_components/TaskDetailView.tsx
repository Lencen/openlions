"use client";
// /flywheel/tasks · 详情渲染（结构化摘要 / 执行结论 / 执行链 / 数据流向）
// 2026-11-04 P1 收尾（ord-20261104-032）：
//   ① 34 处内联样式全部换成 page.module.css 的类（.section/.kv/.pre/.mark…），页面里不再有内联样式；
//   ② 2 张旧原表（className="tbl"）换成白名单 DataTable（列 = 原表格的四列/三列，未删列、未改字段）；
//      原表本来没有表头，DataTable 必须给列名 → 补了「标记/条目/说明」「流转/执行体/时间/原因」。
//   逻辑、文案、fmtTs 格式化、取数调用一律未改。
import { useState, type ReactNode } from "react";
import { scopeDef, scopeOfType } from "@/config/taskScopes";
import { artifactLabel } from "@/config/artifactTypes";
import { t } from "@/i18n";
import { DataTable } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import { badgeCls } from "./shared";
import type { Detail } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";
import styles from "../page.module.css";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}
function KV({ k, v }: { k: string; v: ReactNode }) {
  return <div className={styles.kv}><span className={styles.kvKey}>{k}: </span>{v}</div>;
}
function Pre({ s }: { s: string }) {
  return <pre className={styles.pre}>{s}</pre>;
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
      <div className={styles.todoGrid}>
        {todos.map((t) => (
          <div key={t.id} className={styles.todoCard}>
            <div className={styles.todoHead}>
              <span className={badgeCls(t.status)}>{t.status}</span>
              <span className={styles.todoTitle}>{t.title}</span>
              <span className={"mono tiny " + styles.pushRight}>{t.id}</span>
            </div>
            {t.ownerType ? (
              <div className={"tiny " + styles.todoMeta}>
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

/** 执行结论逐项：原表格三列（标记 / 条目 / 说明），无表头 → DataTable 补列名。 */
type FlagRow = { key: number; st: string; tone: "ok" | "warn" | "crit"; name: string; text: string };
const FLAG_COLUMNS: DataColumn<FlagRow>[] = [
  {
    key: "st",
    title: "标记",
    width: "96px",
    render: (r) => <span className={styles.mark} data-tone={r.tone}>{r.st}</span>,
  },
  { key: "name", title: "条目", width: "200px", render: (r) => <span className="mono nowrap">{r.name}</span> },
  { key: "text", title: "说明", render: (r) => r.text },
];

/** 执行链：原表格四列（流转 / 执行体 / 时间 / 原因），无表头 → DataTable 补列名。 */
type ChainRow = { key: number; flow: string; actor: string; at: string; reason: string };
const CHAIN_COLUMNS: DataColumn<ChainRow>[] = [
  { key: "flow", title: "流转", width: "190px", render: (r) => <span className="nowrap">{r.flow}</span> },
  { key: "actor", title: "执行体", width: "180px", render: (r) => <span className="nowrap">{r.actor}</span> },
  { key: "at", title: "时间", width: "150px", render: (r) => <span className="mono nowrap">{r.at}</span> },
  { key: "reason", title: "原因", render: (r) => <span className={styles.cellDim}>{r.reason}</span> },
];

export default function DetailView({ d, fmtTs }: { d: Detail; fmtTs: (v?: string | null) => string }) {
  const task = d.task;
  const ps = d.payloadSummary;
  let payloadRaw: any = null;
  try { payloadRaw = JSON.parse(task?.improvementPayload || "null"); } catch { payloadRaw = null; }
  let mat: any = null;
  try { mat = task?.materials ? JSON.parse(task.materials) : null; } catch { mat = task?.materials; }
  return (
    <div>
      <div className={styles.head}>
        <a href={"/flywheel/tasks/" + task?.id} className={styles.openLink}>{t('tasks.open.link')}</a>
        <span className={badgeCls(task?.status)}>{task?.status}</span>
        <span className={styles.scopeLine}>
          {(() => { const sd = scopeDef(scopeOfType(task?.improvementType)); return <span className={styles.scopeName} data-scope={sd.key}>{sd.label}</span>; })()}
          {" · "}{task?.improvementType || "-"} · 主题: {task?.theme || "-"} · 优先级: {task?.priority || "-"}{task?.manualReview ? " · 需人审" : ""}
        </span>
        <span className={styles.createdLine}>创建 {fmtTs(task?.createdAt)}{task?.completedBy ? " · 完成 " + task?.completedBy + " " + fmtTs(task?.completedAt) : ""}</span>
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
        ) : <span className={styles.mutedBase}>无 payload</span>}
        {payloadRaw && (
          <details className={styles.details}><summary className={styles.summary}>查看原始数据（动作/发现/循环/别名主题）</summary>
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
          <details><summary className={styles.summary}>查看 materials</summary>
            <Pre s={typeof mat === "string" ? mat : JSON.stringify(mat, null, 1).slice(0, 3200)} />
          </details>
        </Section>
      )}
      <Section title="执行结论 / 失败明细（逐项审视结果，来自 Transition.reason）">
        {(() => {
          const trs = d.transitions || [];
          const last = trs[trs.length - 1];
          if (!last) return <div className={styles.mutedBase}>无执行记录</div>;
          const full = String(last.reason || "");
          const failed = task?.status === "FAILED" || last.toStatus === "FAILED";
          const lines = full.split("\n");
          const detailLines = lines.filter((l) => /\[(DONE|SKIP|SKIPPED|ERROR|DRYRUN)\]/i.test(l));
          const flagRows: FlagRow[] = detailLines.map((l, i) => {
            const m = l.match(/\[(\w+)\]\s*([^:]+):\s*(.*)/);
            const st = m ? m[1] : "";
            const tone: FlagRow["tone"] = /ERROR/i.test(st) ? "crit" : /SKIP/i.test(st) ? "warn" : "ok";
            return { key: i, st, tone, name: m ? m[2] : "", text: m ? m[3] : l };
          });
          return (
            <div>
              <div className={styles.reasonHead}>
                {last.fromStatus} → {last.toStatus} · {last.actor} · {fmtTs(last.createdAt)} · 明细 {detailLines.length} 项{failed ? " · 失败需复核" : ""}
              </div>
              {detailLines.length > 0 && (
                <DataTable
                  rows={flagRows}
                  columns={FLAG_COLUMNS}
                  rowKey={(r) => r.key}
                  empty={{ title: "无" }}
                />
              )}
              <details open={failed}><summary className={styles.summary}>查看完整结论全文（{full.length} 字符）</summary>
                <Pre s={full.slice(0, 4000)} />
              </details>
            </div>
          );
        })()}
      </Section>
      <Section title="执行链（任务状态流转审计）">
        <TableCopyButton />
        <DataTable
          rows={(d.transitions || []).map((tr, i) => ({
            key: i,
            flow: (tr.fromStatus || "?") + " → " + tr.toStatus,
            actor: tr.actor,
            at: fmtTs(tr.createdAt),
            reason: (tr.reason || "").slice(0, 220),
          }))}
          columns={CHAIN_COLUMNS}
          rowKey={(r) => r.key}
          empty={{ title: "无" }}
        />
      </Section>
      {(d.executions || []).length > 0 && (
        <Section title={t('tasks.l2.title')}>
          {d.executions.map((e, i) => (
            <div key={i} className={styles.exec}>
              <div className={styles.execHead}>{e.agentId} · {e.status}{e.completedAt ? " · " + fmtTs(e.completedAt) : ""}</div>
              <Pre s={(e.output || e.problemsEncountered || "").slice(0, 1000)} />
            </div>
          ))}
        </Section>
      )}
      <Section title="数据流向：本任务完成后落库的产物">
        {(d.produced || []).length === 0 && <div className={styles.mutedBase}>{t('tasks.noProduct')}</div>}
        {(d.produced || []).map((p) => (
          <div key={p.type} className={styles.prodItem}>
            <div><strong>{artifactLabel(p.type)}</strong> · {p.count} {t('biz.sourceType.taskProduct')}</div>
            <div className={styles.prodSamples}>
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
