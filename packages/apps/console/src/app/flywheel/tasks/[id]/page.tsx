"use client";
// 0.5.1 B5-15 /flywheel/tasks/[id] · Bento P2 详情（2026-11-15）
// 数据：GET /api/task-detail?id=<taskId>（task/stats/transitions/executions/products/todos/verdicts/injections/asOf）
//       + GET /api/flywheel/tasks-metrics（done7d/failed7d/p95s）。
// 口径：0.5.1 只读 —— 无写控件（原讨论模块写路径不渲染）；缺 id → 「缺少任务标识」；found=false → 「未找到任务」。
//       任务级耗时（startedAt→completedAt）接口无 startedAt → n/a + 原因，不写 0、不拿全流程耗时冒充。
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, States, Tone, usePhaseOverride, useResource } from "../../../system/_components/bento-kit";
import kit from "../../../system/_components/bento-kit.module.css";
import { fmtNum, fmtTime, relTime } from "@/lib/format";

interface Transition { id: string; fromStatus: string; toStatus: string; actor: string; reason?: string | null; createdAt: number }
interface Execution { id: string; agentId?: string; status?: string; startedAt?: number | string; completedAt?: number | string; output?: string }
interface Product { id: string; type?: string; title?: string; [k: string]: any }
interface Todo { id: string; title: string; status: string; priority?: string }
interface Task {
  id: string; title: string; description?: string | null; background?: string | null; requirements?: string | null;
  materials?: string | null; acceptanceCriteria?: string | null; qualityStandards?: string | null; structuredContext?: string | null;
  status?: string; priority?: string; improvementType?: string; theme?: string;
  assignedAgent?: string | null; completedBy?: string | null; expectedOwner?: string | null;
  estimatedEffort?: string | null; actualEffortMs?: number | null; retryCount?: number | null; maxRetries?: number | null;
  createdAt?: number | null; updatedAt?: number | null; completedAt?: number | null; startedAt?: number | null;
  projectPath?: string | null; leaseExpiresAt?: number | null;
}
interface Detail { asOf?: string; id: string; found: boolean; warnings?: string[]; task: Task | null; transitions?: Transition[]; executions?: Execution[]; products?: Product[]; todos?: Todo[]; verdicts?: any[]; injections?: any[]; ingested?: any[]; stats?: { todos?: number; transitions?: number; executions?: number; outputChars?: number; products?: number; verdicts?: number; injections?: number; durationMs?: number | null }; error?: string }
interface Metrics { done7d?: number | null; failed7d?: number | null; p95s?: number | null; p95Sample?: number | null; asOf?: string; reason?: string | null }

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "crit" | "info" | "mute" }> = {
  DONE: { label: "已完成", tone: "ok" }, FAILED: { label: "失败", tone: "crit" }, IN_PROGRESS: { label: "进行中", tone: "info" },
  PROCESSING: { label: "处理中", tone: "info" }, PENDING: { label: "待认领", tone: "warn" }, DEPRECATED: { label: "已废弃", tone: "mute" },
};
const fmtDur = (sec: number | null): string => {
  if (sec == null) return "n/a";
  if (sec < 60) return sec + " 秒";
  if (sec < 3600) return Math.round(sec / 60) + " 分钟";
  return (sec / 3600).toFixed(1) + " 小时";
};

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";
  const detail = useResource<Detail>("/api/task-detail?id=" + encodeURIComponent(id), { pollMs: 60000 });
  const metrics = useResource<Metrics>("/api/flywheel/tasks-metrics");
  const forced = usePhaseOverride();
  const d = detail.data;
  const t = d?.task;
  const base = forced && forced !== "ok" ? forced : !id ? "empty" : detail.phase;
  const notFound = base === "ok" && d && d.found === false;
  const phase = notFound ? "unavailable" : base;
  const asOf = d?.asOf || null;
  const st = STATUS[t?.status || ""] || { label: t?.status || "n/a", tone: "mute" as const };

  const flowSec = t?.createdAt && t?.completedAt ? Math.max(0, Math.round((Number(t.completedAt) - Number(t.createdAt)) / 1000)) : null;
  const taskSec = (t as any)?.startedAt && t?.completedAt ? Math.max(0, Math.round((Number(t.completedAt) - Number((t as any).startedAt)) / 1000)) : null;
  const kp = (v: string | number | null, hint: string, tone?: "info" | "ok" | "warn" | "crit" | "mute"): Metric =>
    v == null ? { kind: "na", reason: hint } : { kind: "value", value: String(v), hint, tone: tone || "info" };

  const trans: DataColumn<Transition>[] = [
    { key: "time", title: "时间", width: 170, render: (x) => <span className={kit.mono}>{x.createdAt ? fmtTime(x.createdAt) : "n/a"}</span> },
    { key: "flow", title: "状态流转", width: 200, render: (x) => <span className={kit.mono}>{x.fromStatus || "n/a"} → {x.toStatus || "n/a"}</span> },
    { key: "actor", title: "操作者", width: 190, render: (x) => <span className={kit.mono}>{x.actor || "n/a"}</span> },
    { key: "reason", title: "原因", render: (x) => <span className={kit.muted}>{x.reason || "n/a"}</span> },
  ];
  const exec: DataColumn<Execution>[] = [
    { key: "time", title: "时间", width: 170, render: (x) => <span className={kit.mono}>{x.startedAt ? fmtTime(x.startedAt) : "n/a"}</span> },
    { key: "agent", title: "执行体", width: 190, render: (x) => <span className={kit.mono}>{x.agentId || "n/a"}</span> },
    { key: "status", title: "状态", width: 100, render: (x) => <Tone tone={x.status === "COMPLETED" || x.status === "DONE" ? "ok" : x.status === "FAILED" ? "crit" : "info"}>{x.status || "n/a"}</Tone> },
    { key: "out", title: "输出（截断）", render: (x) => <span className={kit.muted}>{(x.output || "n/a").slice(0, 200)}</span> },
  ];
  const metricKpi = (v: number | null | undefined, hint: string, unit = ""): Metric =>
    v == null ? { kind: "na", reason: hint } : { kind: "value", value: fmtNum(v) + unit, hint };

  return (
    <main className="page">
      <h1 className={kit.srOnly}>改进任务详情</h1>
      <PageHeader>
        <PageTitle>改进任务 · 详情</PageTitle>
        <div className="page-subtitle">
          任务 <span className={kit.mono}>{id || "n/a（缺少任务标识）"}</span> · {t?.title || "标题 n/a"} · {st.label} · 数据时刻 {asOf ? fmtTime(asOf) : "n/a（接口未下发）"}
        </div>
        <Chips group="飞轮" page="任务详情" />
      </PageHeader>

      <States phase={phase} endpoint={"/api/task-detail?id=" + id} error={detail.error} status={detail.status} onRetry={detail.reload}
        emptyTitle={id ? "任务不存在或暂无内容" : "缺少任务标识"} emptyDetail={id ? "已提供 task id，但任务详情接口未返回内容（不是缺参）。" : "路由缺少任务 id；请从任务列表进入。"}
        unavailableTitle="未找到任务" unavailableDetail={d?.error || ("没有找到任务 " + id + "（found=false）。")} />

      {phase === "ok" && t && (
        <BentoGrid>
          <KpiTile span={3} label="状态" metric={{ kind: "value", value: st.label, hint: "status=" + (t.status || "n/a"), tone: st.tone }} />
          <KpiTile span={3} label="优先级" metric={kp(t.priority, "来源：task.priority", "info")} />
          <KpiTile span={3} label="全流程耗时（创建→完成）" metric={flowSec != null ? { kind: "value", value: fmtDur(flowSec), hint: "completedAt − createdAt" } : { kind: "na", reason: "尚未完成（completedAt 为空）——不适用，不是取不到" }} />
          <KpiTile span={3} label="最近更新" metric={t.updatedAt != null ? { kind: "value", value: relTime(t.updatedAt), hint: fmtTime(t.updatedAt) } : { kind: "na", reason: "updatedAt 未下发" }} />

          <BentoCard span={8} title="任务正文与验收" sub={"类型 " + (t.improvementType || "n/a") + (t.theme ? " · 主题 " + t.theme : "")}>
            {[["任务描述", t.description], ["背景", t.background], ["要求", t.requirements], ["材料", t.materials], ["验收标准", t.acceptanceCriteria], ["质量标准", t.qualityStandards]].map(([label, val]) =>
              val ? (
                <div className={kit.block} key={String(label)}>
                  <h3 className={kit.blockHead}>{label}</h3>
                  <p className={kit.blockBody}>{String(val)}</p>
                </div>
              ) : null
            )}
            {!t.description && !t.requirements && !t.acceptanceCriteria && (
              <Note>正文与验收字段均为空（空集，不是不可得）—— 任务可能仅由结构化上下文登记。</Note>
            )}
            {t.structuredContext ? (
              <details style={{ marginTop: 8 }}>
                <summary className={kit.muted}>结构化上下文（原始数据，默认收起）</summary>
                <p className={kit.blockBody}>{String(t.structuredContext).slice(0, 4000)}</p>
              </details>
            ) : null}
          </BentoCard>

          <BentoCard span={4} title="元信息">
            <ul className={kit.kv}>
              <li><span>负责人</span><b>{t.assignedAgent || "n/a（未认领）"}</b></li>
              <li><span>完成者</span><b>{t.completedBy || "n/a"}</b></li>
              <li><span>预期执行体</span><b>{t.expectedOwner || "n/a"}</b></li>
              <li><span>来源</span><b>{t.improvementType || "n/a"}</b></li>
              <li><span>创建</span><b>{t.createdAt != null ? fmtTime(t.createdAt) : "n/a"}</b></li>
              <li><span>完成</span><b>{t.completedAt != null ? fmtTime(t.completedAt) : "n/a（未完成）"}</b></li>
              <li><span>预计工时</span><b>{t.estimatedEffort || "n/a"}</b></li>
              <li><span>实际工时</span><b>{t.actualEffortMs != null ? fmtDur(Math.round(t.actualEffortMs / 1000)) : "n/a"}</b></li>
              <li><span>重试</span><b>{t.retryCount != null ? fmtNum(t.retryCount) + " / " + fmtNum(t.maxRetries ?? 0) : "n/a"}</b></li>
              <li><span>项目路径</span><b className={kit.mono}>{t.projectPath || "n/a"}</b></li>
            </ul>
            <Note>任务级耗时：n/a —— 接口无 startedAt（Task 表无该列），不用全流程耗时冒充。</Note>
          </BentoCard>

          <BentoCard span={4} title="飞轮指标（近 7 日）" sub={metrics.data?.asOf ? "数据时刻 " + fmtTime(metrics.data.asOf) : "指标取不到"}>
            {metrics.phase === "ok" ? (
              <ul className={kit.kv}>
                <li><span>完成（done7d）</span><b>{fmtNum(metrics.data?.done7d)}</b></li>
                <li><span>失败（failed7d）</span><b>{fmtNum(metrics.data?.failed7d)}</b></li>
                <li><span>P95 耗时</span><b>{metricKpi(metrics.data?.p95s, "p95s 未下发", " 秒").kind === "value" ? fmtNum(metrics.data?.p95s) + " 秒" : "n/a"}</b></li>
                <li><span>P95 样本</span><b>{metrics.data?.p95Sample != null ? fmtNum(metrics.data.p95Sample) : "n/a"}</b></li>
              </ul>
            ) : <Note>指标接口暂不可得（{metrics.phase}）；不影响任务详情展示。</Note>}
          </BentoCard>

          <BentoCard span={8} title="统计" sub="来自 /api/task-detail stats">
            <ul className={kit.kv}>
              <li><span>状态流转</span><b>{fmtNum(d?.stats?.transitions)} 次</b></li>
              <li><span>执行次数</span><b>{fmtNum(d?.stats?.executions)} 次</b></li>
              <li><span>输出字数</span><b>{fmtNum(d?.stats?.outputChars)} 字</b></li>
              <li><span>关联产物</span><b>{fmtNum(d?.stats?.products)} 条</b></li>
              <li><span>平台裁定</span><b>{fmtNum(d?.stats?.verdicts)} 次</b></li>
              <li><span>注入</span><b>{fmtNum(d?.stats?.injections)} 次</b></li>
              <li><span>相关待办</span><b>{fmtNum(d?.stats?.todos)} 条</b></li>
              <li><span>耗时（接口毫秒值）</span><b>{d?.stats?.durationMs != null ? fmtDur(Math.round(d.stats.durationMs / 1000)) : "n/a（接口 null）"}</b></li>
            </ul>
          </BentoCard>

          <BentoCard span={12} title="状态流转时间线" sub={"接口返回 " + fmtNum(d?.transitions?.length) + " 条（路由上限 200，非全量） · 按时间倒序展示最近 20 条"}>
            <DataTable<Transition> columns={trans} rows={(d?.transitions || []).slice().sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 20)} rowKey={(x) => x.id}
              empty={{ title: "无状态流转", desc: "transitions 为空（空集，不是不可得）。" }} />
          </BentoCard>

          <BentoCard span={12} title="执行记录与产物" sub={"执行 " + fmtNum(d?.executions?.length) + " 条 · 产物 " + fmtNum(d?.products?.length) + " 条 · 待办 " + fmtNum(d?.todos?.length) + " 条"}>
            <DataTable<Execution> columns={exec} rows={d?.executions || []} rowKey={(x) => x.id}
              empty={{ title: "无执行记录", desc: "executions 为空（stats.executions=0，空集不是不可得）。" }} />
            {(d?.products || []).length ? (
              <ul className={kit.kv} style={{ marginTop: 10 }}>
                {(d?.products || []).slice(0, 10).map((p) => <li key={p.id}><span>{p.type || "产物"}</span><b>{p.title || p.id}</b></li>)}
              </ul>
            ) : <Note>无关联产物（products 为空）。</Note>}
            {(d?.todos || []).length ? (
              <ul className={kit.kv} style={{ marginTop: 8 }}>
                {(d?.todos || []).slice(0, 10).map((x) => <li key={x.id}><span className={kit.mono}>{x.id}</span><b>{x.title} · {x.status}{x.priority ? " · " + x.priority : ""}</b></li>)}
              </ul>
            ) : <Note>无相关待办（todos 为空）。</Note>}
          </BentoCard>

          <BentoCard span={12} title="相关视图与只读说明">
            <ul className={kit.kv}>
              <li><span>返回</span><b><Link href="/flywheel/tasks" className={kit.link}>任务列表</Link> · <Link href="/flywheel/executions" className={kit.link}>执行记录</Link></b></li>
              <li><span>审计 / 写控件</span><b>0.5.1 只读：本页不渲染讨论/写操作控件；写路径审计在服务端。</b></li>
              <li><span>告警</span><b>{d?.warnings?.length ? d.warnings.join("；") : "无（warnings 空）"}</b></li>
            </ul>
            <Note>数据时刻 {asOf ? fmtTime(asOf) : "不可得（接口未返回 asOf）"} · 口径：全流程耗时=completedAt−createdAt；任务级耗时=completedAt−startedAt（startedAt 缺失 → n/a，不写 0）。</Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}