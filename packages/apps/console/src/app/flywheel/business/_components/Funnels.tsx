"use client";
import { Panel, Note } from "./ui";

// 2026-10-27: 生产/消费链不是同一批对象的逐级转化（新任务可能多于结构化），
// 不能复用“相对上一段”的漏斗百分比（会出现 796%/1089%）。这里用“占首段”+ 量级条。
type Step = { label: string; count: number; color: string };
function StageBars({ steps }: { steps: Step[] }) {
  const max = Math.max(...steps.map((x) => x.count), 1);
  const base = steps[0] ? steps[0].count : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {steps.map((x, i) => {
        const share = base > 0 ? (x.count / base) * 100 : null;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "86px minmax(80px, 1fr) 150px", gap: 8, alignItems: "center" }}>
            <span className="tiny" style={{ color: "var(--text-muted)" }}>{x.label}</span>
            <div style={{ height: 16, background: "var(--bg-surface2)", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: Math.max(2, (x.count / max) * 100) + "%", height: "100%", background: x.color, opacity: 0.72 }} />
            </div>
            <span className="tiny" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {x.count.toLocaleString("zh-CN")}
              {share == null ? "" : <span style={{ color: "var(--text-muted)" }}> · 占首段 {share.toFixed(2)}%</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ProductionFunnel({ s }: { s: any }) {
  const out = (s && s.output && s.output.totals) || {};
  const assets = ["Memory", "Knowledge", "Practice", "Skill"].reduce((a, k) => a + (Number(out[k]) || 0), 0);
  const fmt = (s && s.output && s.output.format) || {};
  const structured = ["Memory", "Knowledge", "Practice"].reduce((a, k) => a + (Number(fmt[k] && fmt[k].n) || 0), 0);
  const flow = (s && s.flow) || {};
  const steps = [
    { label: "资产入库", count: assets, color: "var(--table-memory)" },
    { label: "结构化", count: structured, color: "var(--table-knowledge)" },
    { label: "新任务", count: Number(flow.newTasks) || 0, color: "var(--table-practice)" },
    { label: "认领", count: Number(flow.claims) || 0, color: "var(--info)" },
    { label: "完成", count: Number(flow.completed) || 0, color: "var(--status-crit)" },
  ];
  return (
    <Panel title="生产链（24 小时，量级对照）" extra="不是同一批对象的逐级转化；占比=占首段">
      <StageBars steps={steps} />
      <Note>尾链是约束：资产还在入（{assets.toLocaleString("zh-CN")}），结构化只有 {structured}，完成 {Number(flow.completed) || 0}。不要用“队列没涨”判断健康：进水口枯竭会让净增假性稳定。</Note>
    </Panel>
  );
}

export function ConsumptionFunnel({ s }: { s: any }) {
  const c = (s && s.consumption) || {};
  const cite = c.citations || {};
  const steps = [
    { label: "注入", count: Number(c.injected) || 0, color: "var(--status-ok)" },
    { label: "主动检索", count: Number(c.queried) || 0, color: "var(--status-warn)" },
    { label: "提交（记使用）", count: Number(c.used) || 0, color: "var(--status-crit)" },
    { label: "实时引用", count: Number(cite.live) || 0, color: "var(--info)" },
  ];
  return (
    <Panel title="消费链（24 小时，量级对照）" extra="记使用不是阅读率；占比=占首段">
      <StageBars steps={steps} />
      <Note tone="warn">注入 {Number(c.injected || 0).toLocaleString("zh-CN")}，走完提交 {Number(c.used) || 0}（{c.usedOverInjectedPct == null ? "不可测" : c.usedOverInjectedPct + "%"}）。这只能说明“注入后没走完提交”，不能说明“没读”。实时引用 {Number(cite.live) || 0}；历史回填 {Number(cite.backfill) || 0} 另列，不代表本周采用。</Note>
    </Panel>
  );
}
