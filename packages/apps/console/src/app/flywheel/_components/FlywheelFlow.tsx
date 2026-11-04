"use client";
// 2026-10-20 二版（人类："感觉这个好死板"）。
//   参考 drawio 数据流图 + 现代 dashboard 的 "animated beam" 做法（发光渐变光束 + 沿路径运动的粒子），
//   在**不引图表/动画库**的约束下用纯 SVG 实现：
//   · 曲线连接（S 形贝塞尔）代替直排方框；
//   · 光束 = 渐变描边 + dash 流动；粒子 = <animateMotion> 沿同一条路径；
//   · 末环回到首环画一条回环弧，让"飞轮"读起来是个循环；
//   · 节点里的数字仍是真的：近 5 分钟经过量，0 的环光束静止。
// 减少动态（prefers-reduced-motion）时：不渲染粒子、光束静止，数字照旧。
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { STAGES } from "./shared";
import type { DashboardData } from "./shared";

type Step = { id: string; label: string; qty: { m5: number; m15: number; h1: number; h24: number } };

// 质量条上的表名是英文代号，按"英文代号清零"换成业务说法。
const QUALITY_LABEL: Record<string, string> = {
  Memory: "记忆", Knowledge: "知识", Practice: "实践", Skill: "技能", Reflection: "反思", FlywheelReflection: "飞轮反思",
};
const ICONS: Record<string, string> = { scan: "🔍", extract: "🧠", write: "💾", improve: "🎯", reflect: "💡", structure: "🏗️", backfill: "♻️" };
// 画布里的标签要短（150px 盒子 + 右侧环形），长名字会溢出。业务含义不变，只在图上用简称。
const SHORT_LABEL: Record<string, string> = {
  scan: "同步扫描", extract: "提炼", write: "裁决入库", reflect: "聚合反思",
  structure: "结构化", improve: "改进任务", backfill: "回填",
};

// 画布几何（viewBox 1200×300）：7 个节点沿轻微起伏的曲线排布，避免"一排方框"的僵直感。
const BOX_W = 152, BOX_H = 96;
const POS = Array.from({ length: 7 }, (_, i) => ({
  x: 24 + i * 168,
  y: i % 2 === 0 ? 34 : 74,
}));
const center = (i: number) => ({ x: POS[i].x + BOX_W / 2, y: POS[i].y + BOX_H / 2 });

function linkPath(i: number) {
  const a = center(i), b = center(i + 1);
  const dx = b.x - a.x;
  return `M ${a.x + BOX_W / 2} ${a.y} C ${a.x + BOX_W / 2 + dx * 0.45} ${a.y}, ${b.x - BOX_W / 2 - dx * 0.45} ${b.y}, ${b.x - BOX_W / 2} ${b.y}`;
}
// 回环：从最后一个节点上方绕回第一个节点上方
const LOOP_PATH = "M 1070 60 C 1140 6, 120 6, 170 60";

export default function FlywheelFlow({
  recentEvents,
  lastTs,
  hasRecentActivity,
}: {
  recentEvents: DashboardData["recentEvents"];
  lastTs: string;
  hasRecentActivity: boolean;
}) {
  const { data: flow, loading } = useApi<any>("/api/flywheel-flow");
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const steps: Step[] = Array.isArray(flow?.steps) ? flow.steps : [];
  const running = flow?.heartbeat?.running?.length ?? 0;
  const lastAge = flow?.heartbeat?.lastEvent?.ageSec;
  const q = flow?.queues || {};
  const quality: Record<string, any> = flow?.quality || {};
  const strip = (s: string) => String(s || "").replace(/^[①②③④⑤⑥⑦]\s*/, "");

  const nodes = (steps.length
    ? steps.map((s) => ({ id: s.id, label: SHORT_LABEL[s.id] || strip(s.label), m5: s.qty?.m5 ?? 0, h1: s.qty?.h1 ?? 0 }))
    : STAGES.map((s) => ({ id: s.id, label: s.label, m5: 0, h1: 0 }))
  ).map((n) => ({ ...n, icon: ICONS[n.id] || "•" }));
  const totalM5 = nodes.reduce((a, n) => a + n.m5, 0);
  const maxM5 = Math.max(1, ...nodes.map((n) => n.m5));
  const isActive = (id: string, i: number) => (nodes[i]?.m5 ?? 0) > 0 || recentEvents.some((e) => e.stage === id);

  const chip = (label: string, value: string, tone?: string) => (
    <span className="fw-chip" style={tone ? { color: tone } : undefined}>
      <span className="fw-chip-k">{label}</span>
      <span className="fw-chip-v">{value}</span>
    </span>
  );

  return (
    <div className="panel fw-panel">
      <div className="panel-header">
        <span className="panel-title">飞轮数据流动</span>
        <span className="fw-hint">{loading ? "读取中…" : "光带在动 = 这一环最近 5 分钟有新数据经过；静止 = 没有"}</span>
      </div>

      <div className="fw-status">
        {chip("最近事件", lastAge == null ? "—" : lastAge + " 秒前", lastAge != null && lastAge < 120 ? "var(--ok)" : "var(--text-dim)")}
        {chip("近 5 分钟经过", totalM5 + " 条")}
        {chip("运行中任务", String(running))}
        {chip("待取会话", String(q?.sessionPending ?? 0))}
        {chip("近 24h 失败", String(q?.sessionFailed ?? 0), (q?.sessionFailed ?? 0) > 0 ? "var(--warn)" : undefined)}
        {chip("最后活动", lastTs)}
      </div>

      <div className="fw-canvas">
        <svg viewBox="0 0 1200 250" preserveAspectRatio="xMidYMid meet" role="img"
          aria-label={"飞轮 7 个环节的实时流量：近 5 分钟共 " + totalM5 + " 条"}>
          <defs>
            <linearGradient id="fwBeam" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" style={{ stopColor: "var(--flow-1)", stopOpacity: 0.25 }} />
              <stop offset="50%" style={{ stopColor: "var(--flow-2)", stopOpacity: 1 }} />
              <stop offset="100%" style={{ stopColor: "var(--flow-3)", stopOpacity: 0.45 }} />
            </linearGradient>
            <filter id="fwGlow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <radialGradient id="fwNodeActive" cx="50%" cy="0%" r="120%">
              <stop offset="0%" style={{ stopColor: "var(--primary)", stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: "var(--primary)", stopOpacity: 0.02 }} />
            </radialGradient>
          </defs>

          {/* 回环：飞轮的最后回到最前 */}
          <path d={LOOP_PATH} className={"fw-loop-path" + (hasRecentActivity && !reduce ? " flow" : "")} />
          {hasRecentActivity && !reduce ? (
            <circle r="4" className="fw-particle" filter="url(#fwGlow)">
              <animateMotion dur="3.4s" repeatCount="indefinite" path={LOOP_PATH} />
            </circle>
          ) : null}

          {/* 相邻环节的光带 + 粒子 */}
          {POS.slice(0, -1).map((_, i) => {
            const active = isActive(nodes[i]?.id, i);
            const d = linkPath(i);
            const dur = 2.4 - Math.min(1.2, (nodes[i]?.m5 ?? 0) * 0.12) + "s";
            return (
              <g key={"l" + i}>
                <path d={d} className={"fw-path" + (active ? " flow" : "")} />
                {active ? <path d={d} className="fw-halo" /> : null}
                {active && !reduce
                  ? [0, 1, 2].map((k) => (
                      <circle key={k} r="4.4" className="fw-particle" filter="url(#fwGlow)">
                        <animateMotion dur={dur} begin={k * 0.55 + "s"} repeatCount="indefinite" path={d} />
                      </circle>
                    ))
                  : null}
              </g>
            );
          })}

          {/* 节点 */}
          {nodes.map((n, i) => {
            const active = isActive(n.id, i);
            const g = POS[i];
            const ratio = n.m5 / maxM5;
            const ring = 2 * Math.PI * 13;
            return (
              <g key={n.id} className={"fw-node-g" + (active ? " active" : "")} transform={`translate(${g.x},${g.y})`}>
                <rect width={BOX_W} height={BOX_H} rx="14" className={"fw-box" + (active ? " active" : "")} />
                {active ? <rect width={BOX_W} height={BOX_H} rx="14" fill="url(#fwNodeActive)" /> : null}
                <text className="fw-svg-icon" x="16" y="30">{n.icon}</text>
                <text className="fw-svg-label" x="42" y="29">{n.label}</text>
                <text className="fw-svg-num" x="16" y="70">{n.m5}</text>
                <text className="fw-svg-sub" x="16" y="88">近 1 小时 {n.h1}</text>
                {/* 右上角小环：本环节相对最大流量的占比（视觉参照，不改变数字） */}
                <g transform={`translate(${BOX_W - 26},${28})`}>
                  <circle r="13" className="fw-ring-bg" />
                  <circle r="13" className="fw-ring-fg" strokeDasharray={ring}
                    strokeDashoffset={ring * (1 - Math.max(0.06, ratio))} transform="rotate(-90)" />
                </g>
              </g>
            );
          })}
        </svg>
      </div>

      {Object.keys(quality).length ? (
        <div className="fw-quality">
          <span className="fw-quality-title">落库质量（平均分，0–1）</span>
          {Object.entries(quality).map(([k, v]: any) => (
            <span key={k} className="fw-q-item">
              <span className="fw-q-k">{QUALITY_LABEL[k] || k}</span>
              <span className="fw-q-bar"><span className="fw-q-fill" style={{ width: Math.round((Number(v?.avgQ) || 0) * 100) + "%" }} /></span>
              <span className="fw-q-v">{Number(v?.avgQ ?? 0).toFixed(2)}</span>
              <span className="fw-q-n">{v?.n ?? 0} 条</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="fw-foot">
        口径：「近 5 分钟经过」= 该环节最近 5 分钟处理的事件条数；光带与粒子只表示"有/无流动"，不代表速度。质量分为该表平均分（0–1）。
      </div>
    </div>
  );
}