"use client";
import { Panel, Note } from "./ui";
import styles from "./Funnels.module.css";

// 2026-10-27: 生产/消费链不是同一批对象的逐级转化（新任务可能多于结构化），
// 不能复用“相对上一段”的漏斗百分比（会出现 796%/1089%）。这里用“占首段”+ 量级条。
// 2026-11-05 P2 呈现层（批8）：量级条的宽度改 data-w 档位、步骤色改 data-tone 属性选择器，
//   行栅格/轨道/右对齐数字下沉到 Funnels.module.css；取数口径、文案、Note 内容一条未动。
type Step = { label: string; count: number; color: string };

/** 步骤色 -> 语义色调（只登记本组件实际用到的几档）；未登记的色按主色处理。 */
const TONE: Record<string, string> = {
  "var(--table-memory)": "memory",
  "var(--table-knowledge)": "knowledge",
  "var(--table-practice)": "practice",
  "var(--info)": "info",
  "var(--status-ok)": "ok",
  "var(--status-warn)": "warn",
  "var(--status-crit)": "crit",
};

function StageBars({ steps }: { steps: Step[] }) {
  const max = Math.max(...steps.map((x) => x.count), 1);
  const base = steps[0] ? steps[0].count : 0;
  return (
    <div className={styles.bars}>
      {steps.map((x, i) => {
        const share = base > 0 ? (x.count / base) * 100 : null;
        // 条宽：原来直接写「百分比字符串」；现在四舍五入到 1% 档位交给 data-w（最窄保留 2px 的观感）
        const pct = Math.max(2, Math.min(100, Math.round((x.count / max) * 100)));
        return (
          <div key={i} className={styles.barRow}>
            <span className={"tiny " + styles.barLabel}>{x.label}</span>
            <div className={styles.barTrack}>
              <div className={styles.barFill} data-w={pct} data-tone={TONE[x.color] ?? "primary"} />
            </div>
            <span className={"tiny " + styles.barCount}>
              {x.count.toLocaleString("zh-CN")}
              {share == null ? "" : <span className={styles.barShare}> · 占首段 {share.toFixed(2)}%</span>}
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
