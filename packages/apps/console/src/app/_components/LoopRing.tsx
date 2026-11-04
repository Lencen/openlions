"use client";
// 2026-10-25 R5：业务环重写（老板拍板「环形保留，但要好看、且看得出每个节点的状态」）
// 设计来源：docs/frontend-demos/admin-redesign-2026-10-25/index.html（demo 与方案已核对一致）
// 与旧 LoopFlow 的差别：
//   ① 每节点有**状态**（正常/积压/异常/空闲），状态由阈值表推导，不是装饰（决策 D2）
//   ② 环段 = 流转（有量/没量/这段堵住），节点 = 环节，两者状态分开表达（决策 D4）
//   ③ 环心只留「一句结论 + 主数 + ⑥改进行动快照」，不再堆 5 行数字
//   ④ 去 emoji（线性 Icon）、去发光/粒子动画（calm-tech）
//   ⑤ ≤900px 降级为纵向列表（沿用既有移动端策略，决策 D5）
import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api";
import { fmtNum } from "@/lib/format";
import Icon from "@/components/Icon";

type NodeState = "ok" | "warn" | "crit" | "idle";
const STATE_TEXT: Record<NodeState, string> = { ok: "正常", warn: "积压", crit: "异常", idle: "空闲" };

// 环几何（viewBox 1120×680）：环在中心，节点卡在外圈，过渡胶囊骑在环上
const CX = 560, CY = 340, RX = 246, RY = 190, NRX = 388, NRY = 276;
const rad = (d: number) => (d * Math.PI) / 180;
const ptOn = (d: number, rx: number, ry: number) => ({ x: CX + rx * Math.cos(rad(d)), y: CY + ry * Math.sin(rad(d)) });

// 5 个环节的固定角度（-90=正上，顺时针）
const NODE_DEF = [
  { id: "work", name: "智能体工作", angle: -90, icon: "spark" },
  { id: "session", name: "会话接入", angle: -18, icon: "chat" },
  { id: "process", name: "提炼加工", angle: 54, icon: "gear" },
  { id: "asset", name: "认知资产", angle: 126, icon: "db" },
  { id: "consume", name: "取用消费", angle: 198, icon: "magnet" },
] as const;

// 环段：从节点 i 流向 i+1（顺时针）
const EDGE_DEF = [
  { a: -90, b: -18, label: "工作记录" },
  { a: -18, b: 54, label: "扫描提炼" },
  { a: 54, b: 126, label: "写入资产" },
  { a: 126, b: 198, label: "取用" },
  { a: 198, b: 270, label: "产生改进" },
];

/** 阈值表（决策 D2）：状态必须能解释来源；无信号一律 idle，不编造。 */
const T = {
  sessionBacklogWarn: 500, // 待提炼会话数
  sessionBacklogCrit: 2000,
  processRunningWarn: 20, // 处理中段数
  assetQualityWarn: 0.4, // 平均质量
};

const ICON_BY_ID: Record<string, string> = { work: "activity", session: "message-square", process: "settings", asset: "package", consume: "target" };

export default function LoopRing() {
  const { data: overview } = useApi<any>("/api/overview");
  const { data: loop } = useApi<any>("/api/business-loop");
  const { data: stats } = useApi<any>("/api/stats");
  const { data: flow } = useApi<any>("/api/flywheel-flow");
  const { data: todo } = useApi<any>("/api/todos?ownerType=human&limit=1");
  const [hover, setHover] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const s = overview?.sessions || {}, p = overview?.products || {}, t = overview?.tasks || {}, a = overview?.agents || {};
  const q = overview?.quality?.byTable || {}, b = overview?.backlog || {};
  const running = flow?.heartbeat?.running || [];
  const m5 = (flow?.steps || []).reduce((acc: number, x: any) => acc + (x?.qty?.m5 || 0), 0);
  const tables = Object.values(p.byTable || {}) as any[];
  const added24 = tables.reduce((acc: number, x: any) => acc + (Number(x?.n) || 0), 0);
  const st = stats?.data?.tables;
  const totalAll: number | null = st ? (Object.values(st) as any[]).reduce((acc, v: any) => acc + (Number(v) || 0), 0) : null;
  const qv = Object.values(q) as any[];
  const avgQ = qv.length ? qv.reduce((acc, v: any) => acc + (Number(v?.avg) || 0), 0) / qv.length : 0;
  const humanOpen = Number(todo?.humanOpen ?? 0);
  const pendingSessions = Number(b.pendingSessions ?? 0);
  const consumeTotal = (loop?.pull?.agentCalls ?? 0) + (loop?.pull?.platformCalls ?? 0);
  const activeAgents = Number(a.active ?? 0);

  const stepQty = (id: string) => Number((flow?.steps || []).find((x: any) => x.id === id)?.qty?.h24) || 0;

  const nodes = useMemo(() => {
    const defs: Record<string, { val: number; unit: string; cap: string; state: NodeState; fill: number }> = {
      work: {
        val: activeAgents, unit: "个活跃",
        cap: `对话 ${fmtNum(s.newSessions ?? 0)} · 待人 ${humanOpen}`,
        state: activeAgents > 0 ? "ok" : "crit", fill: Math.min(1, activeAgents / 8),
      },
      session: {
        val: Number(s.newSessions ?? 0), unit: "段 / 24h",
        cap: `待提炼 ${fmtNum(pendingSessions)}`,
        state: pendingSessions >= T.sessionBacklogCrit ? "crit" : pendingSessions >= T.sessionBacklogWarn ? "warn" : Number(s.newSessions ?? 0) > 0 ? "ok" : "idle",
        fill: Math.min(1, pendingSessions / T.sessionBacklogCrit),
      },
      process: {
        val: m5, unit: "段 · 5min",
        cap: `${fmtNum(running.length)} 段在跑`,
        state: running.length >= T.processRunningWarn ? "warn" : m5 > 0 || running.length > 0 ? "ok" : "idle",
        fill: Math.min(1, running.length / T.processRunningWarn),
      },
      asset: {
        val: added24, unit: "条新增",
        cap: `存量 ${totalAll != null ? fmtNum(totalAll) : "—"}`,
        state: qv.length > 0 && avgQ < T.assetQualityWarn ? "warn" : added24 > 0 ? "ok" : "idle",
        fill: Math.max(0, Math.min(1, avgQ)),
      },
      consume: {
        val: consumeTotal, unit: "次 / 24h",
        cap: "资产 · 任务 · 会话",
        state: consumeTotal > 0 ? "ok" : "idle",
        fill: Math.min(1, consumeTotal / 800),
      },
    };
    return NODE_DEF.map((n) => ({ ...n, ...defs[n.id] }));
  }, [activeAgents, s.newSessions, t.running, humanOpen, pendingSessions, m5, running.length, added24, totalAll, avgQ, qv.length, consumeTotal]);

  // 环段状态 = 这一段流转有没有量；「扫描提炼」额外按待提炼积压升级（决策 D4）
  const edges = useMemo(() => {
    const vols: Record<string, number> = {
      "工作记录": Number(s.newSessions ?? 0),
      "扫描提炼": stepQty("extract"),
      "写入资产": stepQty("write"),
      "取用": consumeTotal,
      "产生改进": stepQty("improve"),
    };
    return EDGE_DEF.map((e) => {
      const v = vols[e.label] || 0;
      let state: NodeState = v > 0 ? "ok" : "idle";
      if (e.label === "扫描提炼" && pendingSessions >= T.sessionBacklogWarn) state = "warn";
      return { ...e, v, state };
    });
  }, [s.newSessions, consumeTotal, pendingSessions, stepQty]);

  const warnNodes = nodes.filter((n) => n.state === "warn" || n.state === "crit");
  const warnCount = warnNodes.length;
  const okCount = nodes.filter((n) => n.state === "ok").length;
  const headline = !mounted || (!overview && !stats) ? "正在读取今天的业务状态…"
    : warnCount === 0 ? "整体转得顺" : `有 ${warnCount} 环需要留意`;

  const arc = (from: number, to: number) => {
    const pad = 5.5;
    const p1 = ptOn(from + pad, RX, RY), p2 = ptOn(to - pad, RX, RY);
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${RX} ${RY} 0 0 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  };
  const stateColor = (st: NodeState) => st === "ok" ? "var(--status-ok)" : st === "warn" ? "var(--status-warn)" : st === "crit" ? "var(--status-crit)" : "var(--text-muted)";

  return (
    <div className="lr-wrap">
      <div className="lr-head">
        <div>
          <div className="lr-title">业务环</div>
          <div className="lr-sub">工作 → 会话 → 提炼 → 资产 → 取用 → 回到工作；环上数字是该段 24h 通过量</div>
        </div>
        <div className="lr-verdict">
          <span className="lr-dot" data-state={warnCount === 0 ? "ok" : "warn"} />
          <span>{headline}</span>
          {mounted && okCount + warnCount > 0 ? <span className="lr-verdict-sub">{okCount} 环正常 · {warnCount} 环需留意</span> : null}
        </div>
      </div>

      {/* ≤900px：纵向列表（同一份数据） */}
      <div className="lr-list">
        {nodes.map((n) => (
          <div key={n.id} className="lr-list-row">
            <Icon name={ICON_BY_ID[n.id]} size={16} />
            <span className="lr-list-name">{n.name}</span>
            <span className="lr-list-state" data-state={n.state}><i />{STATE_TEXT[n.state]}</span>
            <span className="lr-list-val"><b>{fmtNum(n.val)}</b> {n.unit}</span>
            <span className="lr-list-cap">{n.cap}</span>
          </div>
        ))}
      </div>

      <div className="lr-stage" role="img"
        aria-label={`业务环：${nodes.map((n) => `${n.name}${STATE_TEXT[n.state]}${n.val}`).join("，")}`}>
        <svg className="lr-svg" viewBox="0 0 1120 680" preserveAspectRatio="xMidYMid meet">
          <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="none" stroke="var(--bg-surface3)" strokeWidth={16} />
          {edges.map((e, i) => (
            <path key={e.label} d={arc(e.a, e.b)} fill="none"
              stroke={stateColor(e.state)}
              strokeWidth={hover === i ? 22 : 16}
              strokeLinecap="round"
              opacity={e.state === "idle" ? 0.32 : hover === null || hover === i ? 0.95 : 0.55}
              style={{ transition: "stroke-width .16s, opacity .16s" }} />
          ))}
        </svg>

        {edges.map((e, i) => {
          const c = ptOn((e.a + e.b) / 2, RX, RY);
          return (
            <div key={"p" + e.label} className="lr-pill"
              style={{ left: `${(c.x / 1120) * 100}%`, top: `${(c.y / 680) * 100}%` }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <span>{e.label}</span>
              <b>{fmtNum(e.v)}</b>
              <Icon name="arrow-right" size={14} />
            </div>
          );
        })}

        {nodes.map((n, i) => {
          const c = ptOn(n.angle, NRX, NRY);
          return (
            <div key={n.id} className="lr-node" data-state={n.state}
              style={{ left: `${(c.x / 1120) * 100}%`, top: `${(c.y / 680) * 100}%` }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <div className="lr-node-head">
                <Icon name={ICON_BY_ID[n.id]} size={16} />
                <span className="lr-node-name">{n.name}</span>
                <span className="lr-node-state"><i />{STATE_TEXT[n.state]}</span>
              </div>
              <div className="lr-node-val"><b>{fmtNum(n.val)}</b><span>{n.unit}</span></div>
              <div className="lr-node-cap">{n.cap}</div>
              <div className="lr-node-bar"><i style={{ width: `${Math.round(n.fill * 100)}%` }} /></div>
            </div>
          );
        })}

        <div className="lr-center">
          <span className="lr-center-tag">
            <Icon name="activity" size={14} />
            {!mounted ? "读取中" : warnNodes.length ? `瓶颈：${warnNodes[0].name}` : "各环节通畅"}
          </span>
          <div className="lr-center-num">{totalAll != null ? fmtNum(totalAll) : "—"}</div>
          <div className="lr-center-label">活跃认知资产</div>
          <div className="lr-center-meta">24h 新增 {fmtNum(added24)} · 平均质量 {avgQ ? avgQ.toFixed(2) : "—"}</div>
          <div className="lr-center-act">
            <span>改进行动 <b>{fmtNum(t.running ?? 0)}</b></span>
            <span>排队 <b>{fmtNum(t.pending ?? 0)}</b></span>
            <span>待人决策 <b className="lr-warn">{humanOpen}</b></span>
          </div>
        </div>
      </div>

      <div className="lr-legend">
        <span><i data-state="ok" />正常</span>
        <span><i data-state="warn" />积压 / 需留意</span>
        <span><i data-state="crit" />异常 / 中断</span>
        <span><i data-state="idle" />本时段空闲</span>
        <span className="lr-legend-note">条形 = 该环节当前负载（相对阈值）</span>
      </div>
    </div>
  );
}
