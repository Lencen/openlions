"use client";
// reflections 页 · 展开详情 (本体 / 审计 / 日结 / 派生任务回显) (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import type { ReactNode } from "react";
import type { Refl } from "./reflectionsShared";
import { badge, chipStyle } from "./reflectionsShared";
import { fmtPct } from "@/lib/format";
import TableCopyButton from "@/components/TableCopyButton";

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return <div style={{ marginBottom: "var(--sp-3)" }}><div style={{ fontWeight: 600, fontSize: "var(--fs-md)", marginBottom: "var(--sp-1-5)", color: "var(--primary)" }}>{title}</div>{children}</div>;
}
function KV({ k, v }: { k: string; v: ReactNode }) { return <div style={{ fontSize: "var(--fs-base)", marginBottom: "var(--sp-0-5)" }}><span style={{ color: "var(--text-dim)" }}>{k}: </span>{v}</div>; }

function fmtMap(o: any): string { if (!o) return "-"; const e = Object.entries(o); return e.length ? e.map(([k, v]) => k + "=" + String(v)).join(" ") : "-"; }

function DayDetail({ ds }: { ds: any }) {
  const src = ds.source || {};
  const ths: any[] = Array.isArray(src.themesReflected) ? src.themesReflected : [];
  const themesCount = src.themesReflectedCount != null ? src.themesReflectedCount : (typeof ds.themesReflected === "number" ? ds.themesReflected : ths.length);
  const sessions = src.sessions || { active: ds.sessionsActive ?? 0, messages: ds.sessionMessages ?? 0 };
  const prod = ds.products || {};
  const memP = prod.memory || { created: 0, qualityBuckets: { high: 0, mid: 0, low: 0, unscored: 0 }, superseded: 0 };
  const pcOld = ds.productsCreated || {};
  const memCreated = memP.created ?? pcOld.memory ?? 0;
  const tasks = ds.tasks || {};
  const tc = tasks.created || { total: 0, byType: {} };
  const td = tasks.done || { total: 0, byType: {} };
  const tf = tasks.failed || { total: 0, byType: {}, samples: [] };
  const produced = ds.produced || { memory: 0, knowledge: 0, practice: 0 };
  const fa = ds.findings || { total: 0, recurring: 0, resolved: 0, byActionType: {}, byPriority: {} };
  const leftover: any[] = ds.leftover || [];
  const suggested: any[] = ds.suggested || [];
  const avgCov = ds.quality?.avgMemoryQuality != null ? ds.quality.avgMemoryQuality : (ds.avgCoverage ?? null);
  const qb = memP.qualityBuckets || {};
  return (
    <div>
      <Sec title="来源: 昨日反思主题 / 会话 (结构化)">
        <KV k="主题反思数" v={String(themesCount)} />
        <KV k="平均覆盖" v={avgCov != null ? String(avgCov) : "-"} />
        <KV k="活跃会话 / 消息" v={String(sessions.active ?? 0) + " / " + String(sessions.messages ?? 0)} />
        {ths.length > 0 && (<table className="tbl" style={{ fontSize: "var(--fs-sm)" }}><tbody>{ths.slice(0, 20).map((t: any, i: number) => (<tr key={i}><td>{t.theme}</td><td className="mono">{t.coverage != null ? (Number(t.coverage) * 100).toFixed(1) + "%" : "-"}</td><td className="mono">{t.delta != null ? (t.delta >= 0 ? "+" : "") + (Number(t.delta) * 100).toFixed(1) + "%" : "-"}</td><td className="mono">{t.findingsCount ?? "-"}</td></tr>))}</tbody></table>)}
      </Sec>
      <Sec title="产物 (新增 / 质量)">
        <KV k="Memory" v={String(memCreated) + " 条 (质量桶 高=" + (qb.high ?? 0) + " 中=" + (qb.mid ?? 0) + " 低=" + (qb.low ?? 0) + " 未评分=" + (qb.unscored ?? 0) + "; 被合并淘汰 " + (memP.superseded ?? 0) + ")"} />
        <KV k="Knowledge / Practice" v={String(prod.knowledge?.created ?? pcOld.knowledge ?? 0) + " / " + String(prod.practice?.created ?? pcOld.practice ?? 0)} />
      </Sec>
      <Sec title="发现聚合（昨日主题反思的结构化发现）">
        <KV k="总数 / 复发 / 已解决" v={String(fa.total) + " / " + String(fa.recurring) + " / " + String(fa.resolved)} />
        <KV k="按优先级" v={fmtMap(fa.byPriority)} />
        <KV k="按动作类型" v={fmtMap(fa.byActionType)} />
      </Sec>
      <Sec title="任务 (昨日)">
        <KV k="新增" v={String(tc.total) + " " + (tc.byType ? "(" + fmtMap(tc.byType) + ")" : "")} />
        <KV k="完成" v={String(td.total) + " " + (td.byType ? "(" + fmtMap(td.byType) + ")" : "")} />
        <KV k="失败" v={String(tf.total) + " " + (tf.byType ? "(" + fmtMap(tf.byType) + ")" : "")} />
        <KV k="任务执行" v={String(tasks.executions ?? 0)} />
        {(tf.samples || []).length > 0 && <div style={{ marginTop: "var(--sp-1)" }}>{(tf.samples as any[]).slice(0, 5).map((s: any, i: number) => (<div key={i} style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>• <a href={"/flywheel/tasks?focus=" + s.id} style={{ color: "var(--primary)" }}>{s.theme || ""}</a> {String(s.title || "").slice(0, 50)}</div>))}</div>}
      </Sec>
      <Sec title="改进任务落库 (昨日完成的任务写入的数据行)">
        <KV k="Memory / Knowledge / Practice" v={String(produced.memory ?? 0) + " / " + String(produced.knowledge ?? 0) + " / " + String(produced.practice ?? 0)} />
      </Sec>
      <Sec title="遗留问题 / 待办 (规则生成)">
        {leftover.length === 0 ? <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>无</span> : leftover.slice(0, 8).map((l: any, i: number) => (<div key={i} style={{ fontSize: "var(--fs-sm)" }}>• [{l.type}] {l.detail}</div>))}
      </Sec>
      <Sec title="建议下一步 (昨日低覆盖主题)">
        {suggested.length === 0 ? <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>无</span> : suggested.slice(0, 5).map((s: any, i: number) => (<div key={i} style={{ fontSize: "var(--fs-sm)" }}>• {s.theme} （覆盖度 {fmtPct(s.coverage)})</div>))}
      </Sec>
    </div>
  );
}

export default function ReflectionsDetail({ refl, fmtTs, onRelease }: { refl: Refl; fmtTs: (v?: string | null) => string; onRelease?: () => void }) {
  const isDay = refl.reflectionGranularity === "day";
  const ss = refl.sourceStats;
  const ds = refl.dayStats;
  const tasks = refl.derivedTasks || [];
  return (
    <div>
      <div style={{ display: "flex", gap: "var(--sp-2-5)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--sp-2)" }}>
        <span className={badge(refl.status)}>{refl.status}</span>
        <span style={chipStyle(true)}>{isDay ? "日结" : "主题反思"}</span>
        {/* 2026-09-10: 主题反思也能打开独立详情页并发起讨论 (FlywheelReflection 的 id 体系) */}
        <a
          href={"/cognitive/reflection/detail?id=" + refl.id + "&kind=flywheel"}
          style={{ fontSize: "var(--fs-base)", color: "var(--primary)" }}
          title="打开独立详情页（含协作时间线与 @智能体 讨论）"
        >
          详情与讨论 →
        </a>
        {refl.coverageScore != null && <span style={{ fontSize: "var(--fs-base)" }}>覆盖度 {fmtPct(refl.coverageScore)}{refl.coverageDelta != null ? "（变化 " + (refl.coverageDelta >= 0 ? "+" : "") + fmtPct(refl.coverageDelta) + "）" : ""}</span>}
        <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>更新 {fmtTs(refl.updatedAt)}</span>
      </div>
      {refl.triggerReason && <Sec title="为什么触发"><KV k="kind" v={String(refl.triggerReason.kind || "-")} />{refl.triggerReason.sinceLastHours != null && <KV k="距上次反思" v={String(refl.triggerReason.sinceLastHours) + "h"} />}<KV k="有新数据" v={String(refl.triggerReason.newDataSinceLast)} /></Sec>}
      {refl.summary && <Sec title="反思正文总结"><div style={{ fontSize: "var(--fs-base)", whiteSpace: "pre-wrap" }}>{refl.summary}</div></Sec>}
      {!isDay && ss && <Sec title="输入审计 sourceStats"><KV k="候选会话 / 实际拉取" v={ss.candidateSessions + " / " + ss.fetchedSessions} /><KV k="前置剔除会话 / 剔除空消息" v={ss.filteredSessions + " / " + ss.droppedMessages} /><KV k="消息 / 块 / 截断块" v={ss.messages + " / " + ss.chunks + " / " + ss.truncatedChunks} /></Sec>}
      {!isDay && ss && (ss.unFetchedEstimate != null || ss.selection) && <Sec title="可信度与健康 (P3.5)"><KV k="未拉取会话估计(候选-拉取)" v={String(ss.unFetchedEstimate ?? 0)} /><KV k="证据会话范围" v={String(ss.sessionUidsUsed ?? 0)} />{ss.changesSinceLast && <KV k="间隔变化: 新消息/新产物" v={String(ss.changesSinceLast.newMessagesSinceLast) + " / " + (ss.changesSinceLast.newProductsSinceLast != null ? String(ss.changesSinceLast.newProductsSinceLast) : "-")} />}{ss.selection && <KV k="选取审计: 总/近重复去除/低置信" v={ss.selection.total + " / " + ss.selection.nearDupRemoved + " / " + ss.selection.lowConfidence} />}<KV k="7天新增 Memory (热度)" v={String(ss.heat7dMemory ?? 0)} />{ss.themeProductsHealth && <KV k="产物健康(抽样): 质量桶高/中/低/未评 + 已淘汰" v={String(ss.themeProductsHealth.qualityBuckets?.high ?? 0) + "/" + String(ss.themeProductsHealth.qualityBuckets?.mid ?? 0) + "/" + String(ss.themeProductsHealth.qualityBuckets?.low ?? 0) + "/" + String(ss.themeProductsHealth.qualityBuckets?.unscored ?? 0) + " + " + String(ss.themeProductsHealth.supersededInSample ?? 0)} />}</Sec>}
      {isDay && ds && <DayDetail ds={ds} />}
      {(refl.missedTopics || []).length > 0 && <Sec title="遗漏主题">{refl.missedTopics!.map((m, i) => <div key={i} style={{ fontSize: "var(--fs-base)" }}>• {m}</div>)}</Sec>}
      {(refl.improvements || []).length > 0 && <Sec title="改进建议">{refl.improvements!.map((m, i) => <div key={i} style={{ fontSize: "var(--fs-base)" }}>• {m}</div>)}</Sec>}
      {(refl.findings || []).length > 0 && <Sec title={"结构化发现 ×" + refl.findings!.length}>
        <TableCopyButton />
        <table className="tbl" style={{ fontSize: "var(--fs-sm)" }}><tbody>
          {refl.findings!.slice(0, 10).map((f: any, i: number) => (
            <tr key={i}><td className="nowrap" style={{ fontSize: "var(--fs-xs)" }}>{f.priority || "-"}<br />{f.actionType || ""}</td><td style={{ fontSize: "var(--fs-xs)" }}>conf {f.confidence ?? "-"} · {f.evidenceStrength || ""}</td><td>{String(f.what || "").slice(0, 130)}</td></tr>
          ))}
        </tbody></table>
        <details style={{ marginTop: "var(--sp-1)" }}><summary style={{ cursor: "pointer", fontSize: "var(--fs-base)" }}>查看原始数据</summary><pre style={{ fontSize: "var(--fs-xs)", whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>{JSON.stringify(refl.findings, null, 1).slice(0, 3600)}</pre></details>
      </Sec>}
      {!isDay && (refl.findings || []).filter((f: any) => f.status === "NEEDS_REVIEW" || ((f.confidence ?? 1) < 0.6 && f.status !== "RESOLVED")).length > 0 && (
        <Sec title={"复核队列 (低置信被拦, 放行后下轮才会执行) ×" + (refl.findings || []).filter((f: any) => f.status === "NEEDS_REVIEW" || ((f.confidence ?? 1) < 0.6 && f.status !== "RESOLVED")).length}>
          <div style={{ marginBottom: "var(--sp-1-5)" }}>
            <button
              className="btn"
              style={{ fontSize: "var(--fs-sm)" }}
              onClick={async () => {
                const r = await fetch("/api/flywheel-findings-release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: refl.theme }) });
                const j = await r.json();
                alert("放行 " + (j.released ?? 0) + " 条" + (j.error ? " (错误: " + j.error + ")" : ""));
                onRelease?.();
              }}
            >放行全部</button>
          </div>
          {(refl.findings || []).filter((f: any) => f.status === "NEEDS_REVIEW" || ((f.confidence ?? 1) < 0.6 && f.status !== "RESOLVED")).map((f: any, i: number) => (
            <div key={i} style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--sp-0-5)" }}>
              • <span style={{ color: "var(--text-dim)" }}>[{f.status}]</span> conf {f.confidence ?? "-"} · {String(f.what || "").slice(0, 100)}
              <button
                className="btn"
                style={{ fontSize: "var(--fs-xs)", marginLeft: "var(--sp-1-5)" }}
                onClick={async () => {
                  const r = await fetch("/api/flywheel-findings-release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: refl.theme, findingId: f.id }) });
                  const j = await r.json();
                  alert(j.released ? "已放行 " + f.id : ("未放行: " + (j.message || j.error || "?")));
                  onRelease?.();
                }}
              >放行</button>
            </div>
          ))}
        </Sec>
      )}
      {!isDay && (refl.findings || []).filter((f: any) => f.status === "RECURRING").length > 0 && <Sec title="复发未闭环 (上轮结论→本轮状态)">{(refl.findings!).filter((f: any) => f.status === "RECURRING").map((f: any, i: number) => (<div key={i} style={{ fontSize: "var(--fs-sm)" }}>• 复发×{f.recurrenceCount || 1} · {String(f.what || "").slice(0, 110)}</div>))}</Sec>}
      <Sec title={isDay ? "（日结行无派生任务, 见上方昨日概览）" : "派生任务回显 (来源本反思, 实时 JOIN 任务表)"}>
        {!isDay && tasks.length > 0 && <KV k="落地小计" v={"完成 " + tasks.filter((x: any) => x.status === "DONE").length + " / 失败 " + tasks.filter((x: any) => x.status === "FAILED").length + " / 进行或待做 " + tasks.filter((x: any) => x.status !== "DONE" && x.status !== "FAILED").length} />}
        {tasks.length === 0 ? <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>无派生改进任务</span> : (
          <table className="tbl" style={{ fontSize: "var(--fs-sm)" }}><tbody>
            {tasks.map((t: any) => (<tr key={t.id}><td><span className={badge(t.status)}>{t.status}</span></td><td>{t.improvementType || ""}</td><td><a href={"/flywheel/tasks?focus=" + t.id} style={{ color: "var(--primary)", textDecoration: "none" }}>{String(t.title || "").slice(0, 70)}</a></td><td className="nowrap">{t.priority}</td><td className="nowrap mono">{fmtTs(t.updatedAt)}</td></tr>))}
          </tbody></table>
        )}
      </Sec>
    </div>
  );
}
