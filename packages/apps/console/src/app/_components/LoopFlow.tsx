"use client";
// 2026-10-20 首页业务闭环 v3（6 节点 + 4 条内环）
// 人类三问后修正：
//   ① 提炼加工 → 改进行动 是真实存在的（飞轮第 6 段就是"改进任务"，24h 自产 298 条）
//   ② 会话来自 agent 的工作（会话库同步扫描），所以环的起点是"智能体工作"而不是"会话"
//   ③ 取用消费不止认知资产：资产 / 任务 / 会话 / 平台种子 / 工具
// 结构：外环 5 节点 + 内环"改进行动"（中心上方），全局量（资产/增长/质量/人）在中心下方。
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import styles from "../page.module.css";

const CX = 500, CY = 218, RX = 372, RY = 152;
const BOX_W = 150, BOX_H = 74; // 2026-10-22：加高 8px，容纳「数字 + 说明」两行，避免说明压在大数字上
const ACT = { x: 500, y: 140, w: 158, h: 72 }; // ⑥ 改进行动（内环节点）
// human: 人参与的三种角色 —— 作=人产内容 / 审=人拍板 / 纠=人改数据（判据见 docs 架构回顾 §2.1）
const NODES = [
  { id: "work", icon: "🛠️", label: "智能体工作", angle: -90, human: "作" },
  { id: "session", icon: "💬", label: "会话接入", angle: -18, human: "作" },
  { id: "process", icon: "⚙️", label: "提炼加工", angle: 54, human: "审" },
  { id: "asset", icon: "🧠", label: "认知资产", angle: 126, human: "纠" },
  { id: "consume", icon: "🧲", label: "取用消费", angle: 198, human: null },
] as const;
const rad = (d: number) => (d * Math.PI) / 180;
const pt = (d: number) => ({ x: CX + RX * Math.cos(rad(d)), y: CY + RY * Math.sin(rad(d)) });
function arc(a: number, b: number, pad = 11) {
  const p1 = pt(a + pad), p2 = pt(b - pad);
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${RX} ${RY} 0 0 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}
export default function LoopFlow() {
  const { data: overview } = useApi<any>("/api/overview");
  const { data: loop } = useApi<any>("/api/business-loop");
  // 2026-10-21 前端对账：overview.products.total 实际是"区间内新增"（createdAt > since），
  //   不是全量总量。中心要显示"总量"必须另取 /api/stats 的五表全量，否则标签与数值不符。
  const { data: stats } = useApi<any>("/api/stats");
  const { data: flow } = useApi<any>("/api/flywheel-flow");
  const { data: todo } = useApi<any>("/api/todos?ownerType=human&limit=1");
  const [reduce, setReduce] = useState(false);
  // 2026-10-22 修 hydration：SVG <title> 里放了随数据变化的文本，服务端首屏与客户端首帧不一致
  //   （实测 React #418，服务端 HTML 被替换）。改为挂载后再渲染 title，服务端输出保持为空。
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const s = overview?.sessions || {}, p = overview?.products || {}, t = overview?.tasks || {}, a = overview?.agents || {};
  const q = overview?.quality?.byTable || {}, b = overview?.backlog || {};
  const pull = loop?.pull, push0 = loop?.push;
  const running = flow?.heartbeat?.running || [];
  const m5 = (flow?.steps || []).reduce((acc: number, x: any) => acc + (x?.qty?.m5 || 0), 0);
  const tables = Object.values(p.byTable || {}) as any[];
  // 2026-10-21 对账：用各表 n（WHERE createdAt > since 的精确计数）求和，而不是趋势桶求和——
  //   趋势桶会丢掉"最后一个不完整小时"里的行（实测 Memory n=857 而桶和 809，少 48）。
  const added24 = tables.reduce((acc: number, x: any) => acc + (Number(x?.n) || 0), 0);
  const st = stats?.data?.tables;
  const totalAll: number | null = st
    ? (Object.values(st) as any[]).reduce((acc: number, v: any) => acc + (Number(v) || 0), 0)
    : null;
  const qv = Object.values(q) as any[];
  const avgQ = qv.length ? qv.reduce((acc: number, v: any) => acc + (Number(v?.avg) || 0), 0) / qv.length : 0;
  const high = qv.reduce((acc: number, v: any) => acc + (Number(v?.high) || 0), 0);
  const low = qv.reduce((acc: number, v: any) => acc + (Number(v?.low) || 0), 0);
  const humanOpen = Number(todo?.humanOpen ?? 0);
  const consumeTotal = (pull?.agentCalls ?? 0) + (pull?.platformCalls ?? 0);

  const INFO: Record<string, { num: string; sub: string }> = {
    work: { num: fmtNum(a.active ?? 0), sub: "对话 · 执行任务 · 协作" },
    session: { num: fmtNum(s.newSessions ?? 0), sub: "24h 段 · 待提炼 " + (b.pendingSessions ?? 0) },
    process: { num: fmtNum(m5), sub: "7 段 · 处理中 " + running.length },
    asset: { num: fmtNum(added24), sub: "24h 新增 · 存量 " + (totalAll != null ? fmtNum(totalAll) : "—") + " · 均分 " + (avgQ ? avgQ.toFixed(2) : "—") },
    consume: { num: fmtNum(consumeTotal), sub: "资产·任务·会话·种子·工具" },
  };
  // 外环 5 条：数据从哪来、变成了什么
  // 2026-10-22 环边加"通过量"编码：线宽 = 24h 通过量（对数缩放，1.2~4.4px）。
  //   数据来源：工作记录=新增会话；扫描/提炼/改进=飞轮对应步骤 h24；取用=调用总量。
  const stepQty = (id: string) => Number((flow?.steps || []).find((x: any) => x.id === id)?.qty?.h24) || 0;
  const RING = [
    { a: -90, b: -18, label: "工作记录", v: Number(s?.newSessions) || 0 },
    { a: -18, b: 54, label: "扫描 · 对话变成候选", v: stepQty("extract") },
    { a: 54, b: 126, label: "提炼 · 候选变成认知", v: stepQty("write") },
    { a: 126, b: 198, label: "取用 · 资产被读走", v: consumeTotal },
    { a: 198, b: -90, label: "使用后产生新工作", v: stepQty("improve") },
  ];
  // 线宽：log10(v+1) 映射到 1.2~4.4，避免 2062 与 17 差几十倍时线粗失真
  const edgeW = (v: number) => Math.max(1.2, Math.min(4.4, 1.2 + Math.log10((Number(v) || 0) + 1) * 0.85));
  // 2026-10-22 自适应高亮阈值：取当日**非零边流量**的 P33（而不是拍死 300），
  //   业务淡旺季节奏不同，固定阈值会在淡日"全灰"、旺日"全亮"。
  const ringVals = RING.map((e) => Number(e.v) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const hotMin = ringVals.length ? ringVals[Math.max(0, Math.min(ringVals.length - 1, Math.floor(ringVals.length * 0.34)))] : Infinity;
  // 内环 4 条（改进行动）
  const INNER = [
    // 控制点在中心圆外侧（x≈640 / 360），保证不穿过中心统计块
    { from: pt(54), to: { x: ACT.x + 44, y: ACT.y + ACT.h }, c: { x: 646, y: 296 }, label: "管线产出改进任务", lx: 668, ly: 268 },
    { from: pt(126), to: { x: ACT.x - 44, y: ACT.y + ACT.h }, c: { x: 354, y: 296 }, label: "低分触发改进", lx: 332, ly: 268 },
  ];
  return (
    <div className="lf-wrap">
      {/* 2026-10-22 手机端（≤640）：环形图缩到 340px 后节点文字不可读，改为等价的纵向列表。
          同一份 NODES/INFO 数据，两种呈现，避免小屏出现"看不懂的图"。 */}
      <div className="lf-legend">
        <span className="lf-legend-title">线宽 = 24h 通过量</span>
        <span className="lf-legend-item"><span className="lf-legend-line w1" />少</span>
        <span className="lf-legend-item"><span className="lf-legend-line w3" />多</span>
      </div>
      <div className="lf-list" aria-hidden="false">
        {NODES.map((n) => (
          <div key={"m" + n.id} className="lf-list-row">
            <span className="lf-list-icon">{n.icon}</span>
            <span className="lf-list-label">{n.label}</span>
            <span className="lf-list-num">{INFO[n.id]?.num ?? "—"}</span>
            <span className="lf-list-sub">{INFO[n.id]?.sub ?? ""}</span>
          </div>
        ))}
        <div className="lf-list-row">
          <span className="lf-list-icon">🎯</span>
          <span className="lf-list-label">改进行动</span>
          <span className="lf-list-num">{fmtNum(t.running ?? 0)}</span>
          <span className="lf-list-sub">排队 {fmtNum(t.pending ?? 0)} · 待办 {humanOpen}</span>
        </div>
      </div>
      <svg viewBox="0 0 1000 436" preserveAspectRatio="xMidYMid meet" role="img"
        aria-label="业务闭环：智能体工作→会话接入→提炼加工→认知资产→取用消费→回到工作；改进行动是内环">
        <defs>
          {/* 2026-10-22 calm-tech：外环从「青→绿高饱和渐变」改为中性边线渐变——
              飞轮要表达"业务闭环"，不是霓虹灯带。保留 id，引用处无需改。 */}
          <linearGradient id="lfGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" className={styles.lfStopBorderHi} />
            <stop offset="100%" className={styles.lfStopBorderHiSoft} />
          </linearGradient>
          <linearGradient id="lfGradAct" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" className={styles.lfStopWarm} />
            <stop offset="100%" className={styles.lfStopFlow3} />
          </linearGradient>
          <filter id="lfGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* 外环 */}
        {RING.map((e, i) => {
          const d = arc(e.a, e.b);
          const mid2 = (e.a + e.b) / 2;
          const m = { x: CX + (RX + 48) * Math.cos(rad(mid2)), y: CY + (RY + 32) * Math.sin(rad(mid2)) };
          const ly = m.y + 4;
          return (
            <g key={"r" + i}>
              <path
                d={d}
                // 2026-10-22 可读性：高通过量（当日 P33）的边用主色描边，其余保持中性边线色；
                //   hover 时整条边高亮，方便在环上定位"哪一段在跑量"。
                className={"lf-path" + (e.v > 0 && e.v >= hotMin ? " hot" : "")}
                stroke={e.v > 0 && e.v >= hotMin ? "var(--primary)" : "url(#lfGrad)"}
                strokeWidth={edgeW(e.v)}
              >
                {mounted ? <title>{e.label} · 24h {fmtNum(e.v)}</title> : null}
              </path>
              <path d={d} className="lf-halo" />
              {!reduce
                ? [0, 1, 2].map((k) => (
                    <circle key={k} r="3.2" className="lf-particle">
                      <animateMotion dur="3.6s" begin={k * 1.2 + "s"} repeatCount="indefinite" path={d} />
                    </circle>
                  ))
                : null}
              <text className="lf-edge-label" x={m.x} y={ly} textAnchor="middle">{e.label}</text>
            </g>
          );
        })}

        {/* 内环：提炼加工 → 改进行动，认知资产 → 改进行动 */}
        {INNER.map((e, i) => {
          const d = `M ${e.from.x} ${e.from.y} Q ${e.c.x} ${e.c.y} ${e.to.x} ${e.to.y}`;
          return (
            <g key={"i" + i}>
              <path d={d} className="lf-inner" />
              {!reduce
                ? [0, 1].map((k) => (
                    <circle key={k} r="3.6" className="lf-inner-dot">
                      <animateMotion dur="3s" begin={k * 1.4 + "s" + (i ? "0.6s" : "0s")} repeatCount="indefinite" path={d} />
                    </circle>
                  ))
                : null}
            </g>
          );
        })}
        {INNER.map((e, i) => (
          <text key={"il" + i} className="lf-edge-label small" x={e.lx} y={e.ly} textAnchor="middle">{e.label}</text>
        ))}

        {/* 改进行动 → 取用（任务被领取）/ → 智能体工作（执行） */}
        <path d={`M ${ACT.x - ACT.w / 2} ${ACT.y + ACT.h / 2} Q ${ACT.x - 150} ${ACT.y + 44}, ${pt(198).x + 60} ${pt(198).y + 6}`} className="lf-inner" />
        <path d={`M ${ACT.x} ${ACT.y} L ${ACT.x} ${pt(-90).y + 34}`} className="lf-inner" />
        <text className="lf-edge-label small" x={ACT.x - 150} y={ACT.y + 30} textAnchor="middle">任务被领取</text>
        <text className="lf-edge-label small" x={ACT.x + 10} y={ACT.y - 8} textAnchor="start">执行产生新工作</text>

        {/* 中心：全局量（资产/增长/质量/人） */}
        {/* 2026-10-22 calm-tech：中心不再用发光径向渐变，改为普通表面色 */}
        <circle cx={CX} cy={292} r="80" fill="var(--bg-surface)" stroke="var(--border)" />
        <circle cx={CX} cy={292} r="74" className="lf-core-ring" />
        {/* 2026-10-21 口径标签：/api/stats 走 mind 的**活跃**口径（排除历史遗留技能），
            标"活跃"避免与"表内全量"混淆（全量比活跃多 2.4 万条历史遗留技能）。 */}
        <text className="lf-core-k" x={CX} y={266} textAnchor="middle">活跃认知资产</text>
        <text className="lf-core-v" x={CX} y={296} textAnchor="middle">{totalAll != null ? fmtNum(totalAll) : "—"}</text>
        <text className="lf-core-d" x={CX} y={314} textAnchor="middle">24h 新增 {fmtNum(added24)} ↑ · 质量 {avgQ ? avgQ.toFixed(2) : "—"} · 活跃口径</text>
        <text className="lf-core-d" x={CX} y={330} textAnchor="middle">高分 {fmtNum(high)} · 低分 {fmtNum(low)}</text>
        <g className="lf-human">
          <rect x={CX - 52} y={340} width="104" height="22" rx="11" />
          <text x={CX} y={355} textAnchor="middle">👤 人决策 {humanOpen}</text>
        </g>

        {/* 外环节点 */}
        {NODES.map((n) => {
          const c = pt(n.angle);
          const info = INFO[n.id];
          const on = n.id === "process" ? running.length > 0 : true;
          return (
            <g key={n.id} className={"lf-node" + (on ? " active" : "")} transform={`translate(${(c.x - BOX_W / 2).toFixed(1)},${(c.y - BOX_H / 2).toFixed(1)})`}>
              <rect width={BOX_W} height={BOX_H} rx="14" className="lf-box" />
              {/* 2026-10-22 层级重排：标签降为次要（小一号、muted），数字成为主视觉（左侧大号），
                  说明右对齐贴着数字基线（单行超长截断），避免三行字号相近、看不出主次。 */}
              <text className="lf-icon" x="14" y="26">{n.icon}</text>
              <text className="lf-label" x="38" y="25">{n.label}</text>
              <text className="lf-num" x="14" y="52">{info.num}</text>
              {/* 说明限 16 字符：右下角「作/审」按钮会压住更长文本的尾部 */}
              <text className="lf-sub" x="14" y="66">{(info.sub || "").slice(0, 16)}</text>
              {on && !reduce ? <circle cx={BOX_W - 14} cy="16" r="3.2" className="lf-run" /> : null}
              {n.human ? (
                <g className="lf-human-badge">
                  <rect x={BOX_W - 46} y={BOX_H - 22} width="40" height="17" rx="8.5" />
                  <text x={BOX_W - 26} y={BOX_H - 10} textAnchor="middle">👤{n.human}</text>
                </g>
              ) : null}
            </g>
          );
        })}

        {/* ⑥ 改进行动（内环节点） */}
        <g className="lf-node active lf-act-node" transform={`translate(${ACT.x - ACT.w / 2},${ACT.y})`}>
          <rect width={ACT.w} height={ACT.h} rx="14" className="lf-box lf-box-act" />
          <text className="lf-icon" x="14" y="26">🎯</text>
          <text className="lf-label" x="38" y="25">改进行动</text>
          <text className="lf-num" x="14" y="51">{fmtNum(t.running ?? 0)}</text>
          <text className="lf-sub" x="14" y="63">排队 {fmtNum(t.pending ?? 0)} · 待办 {humanOpen}</text>
          {!reduce ? <circle cx={ACT.w - 14} cy="16" r="3.2" className="lf-run" /> : null}
          <g className="lf-human-badge">
            <rect x={ACT.w - 46} y={ACT.h - 21} width="40" height="17" rx="8.5" />
            <text x={ACT.w - 26} y={ACT.h - 9} textAnchor="middle">👤审</text>
          </g>
        </g>
      </svg>
    </div>
  );
}