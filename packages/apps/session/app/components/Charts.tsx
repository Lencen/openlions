interface Trend { date: string; sessions: number; messages: number; }
interface AgentRow { agentId: string; sessions: number; messages: number; }
interface SourceRow { source: string; count: number; }

const AGENT_COLOR: Record<string,string> = {
  "agent-h": "var(--agent-h)",
  "agent-g": "var(--agent-g)",
  "agent-b": "var(--agent-b)",
  "agent-c": "var(--agent-c)",
  "agent-e": "var(--agent-e)",
  "agent-operator": "var(--agent-operator)",
};
const AGENT_NAME: Record<string,string> = {
  "agent-h": "UT", "agent-g": "UTC", "agent-b": "agent-x", "agent-c": "agent-x",
  "agent-e": "agent-x", "agent-operator": "operator",
};

export function TrendChart({ trend }: { trend: Trend[] }) {
  const W = 700, H = 180, P = 28;
  if (!trend.length) return <div className="empty">No data</div>;
  const maxS = Math.max(1, ...trend.map(t => t.sessions));
  const maxM = Math.max(1, ...trend.map(t => t.messages));
  const stepX = (W - 2*P) / Math.max(trend.length - 1, 1);
  const xAt = (i: number) => P + i*stepX;
  const sY = (v: number) => H - P - (v / maxS) * (H - 2*P);
  const mY = (v: number) => H - P - (v / maxM) * (H - 2*P);
  const pathS = trend.map((t,i) => `${i?"L":"M"}${xAt(i)} ${sY(t.sessions)}`).join(" ");
  const pathM = trend.map((t,i) => `${i?"L":"M"}${xAt(i)} ${mY(t.messages)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{height:200,width:"100%"}}>
      {[0,1,2,3].map(g => {
        const y = P + g*((H-2*P)/3);
        return <line key={g} x1={P} x2={W-P} y1={y} y2={y} stroke="var(--border-soft)" strokeDasharray="2 4"/>;
      })}
      {maxM > 0 && <path d={pathM} fill="none" stroke="var(--accent-warm)" strokeWidth={1.5} strokeDasharray="3 3"/>}
      <path d={pathS} fill="none" stroke="var(--accent-primary)" strokeWidth={2}/>
      {trend.map((t,i) => (
        <circle key={i} cx={xAt(i)} cy={sY(t.sessions)} r={3} fill="var(--bg-elevated)" stroke="var(--accent-primary)" strokeWidth={1.5}/>
      ))}
      {trend.map((t,i) => (i%2===0 || i===trend.length-1) ? (
        <text key={`l${i}`} x={xAt(i)} y={H-8} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)" fill="var(--ink-muted)">{t.date}</text>
      ) : null)}
      <text x={P-4} y={P+4} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--ink-muted)">{maxS}</text>
      <text x={P-4} y={H-P+4} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--ink-muted)">0</text>
    </svg>
  );
}

export function HourChart({ hourDist }: { hourDist: number[] }) {
  const H = 180, W = 380, P = 28;
  if (!hourDist.length) return <div className="empty">No data</div>;
  const maxH = Math.max(1, ...hourDist);
  const peakIdx = hourDist.indexOf(maxH);
  const bw = (W - 2*P) / 24;
  return (
    <>
      <div style={{position:"absolute",top:14,right:20,fontSize:11,fontFamily:"var(--font-mono)",color:"var(--ink-muted)"}}>
        peak {maxH} @ {String(peakIdx).padStart(2,"0")}:00 UTC
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{height:200,width:"100%"}}>
        {hourDist.map((v,i) => {
          const h = (v/maxH)*(H-2*P);
          return <rect key={i} x={P+i*bw+1} y={H-P-h} width={bw-2} height={h}
            fill={i===peakIdx ? "var(--accent-warm)" : "var(--accent-primary)"}
            fillOpacity={i===peakIdx ? 0.9 : 0.55} rx={1}/>;
        })}
        {[0,6,12,18,23].map(i => (
          <text key={i} x={P+i*bw+bw/2} y={H-8} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)" fill="var(--ink-muted)">
            {String(i).padStart(2,"0")}
          </text>
        ))}
        <text x={P-4} y={P+4} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--ink-muted)">{maxH}</text>
        <text x={P-4} y={H-P+4} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)" fill="var(--ink-muted)">0</text>
      </svg>
    </>
  );
}

export function AgentBar({ agents }: { agents: AgentRow[] }) {
  if (!agents.length) return <div className="empty">No data in last 7 days.</div>;
  const max = Math.max(1, ...agents.map(a => a.sessions));
  return (
    <>
      {agents.map(a => {
        const pct = (a.sessions / max * 100).toFixed(1);
        const color = AGENT_COLOR[a.agentId] || "var(--ink-dim)";
        return (
          <div className="bar-row" key={a.agentId}>
            <span className="agent-name"><span className="swatch" style={{background: color}}></span>{AGENT_NAME[a.agentId] || a.agentId}</span>
            <div className="track"><div className="fill" style={{width: `${pct}%`, background: color}}></div></div>
            <span className="n">{a.sessions}</span>
          </div>
        );
      })}
    </>
  );
}

export function SourceSplit({ sources }: { sources: SourceRow[] }) {
  if (!sources.length) return <div className="empty">No source data.</div>;
  const total = sources.reduce((s,x) => s+x.count, 0);
  const COLORS: Record<string,string> = { HERMES_SESSION: "var(--accent-primary)", CLAUDE_CONVERSATION: "var(--agent-g)", OPENCLAW_SESSION: "var(--agent-operator)" };
  const LABEL: Record<string,string> = { HERMES_SESSION: "Hermes", CLAUDE_CONVERSATION: "Claude", OPENCLAW_SESSION: "OpenClaw" };
  return (
    <>
      <div className="split-bar">
        {sources.map(s => {
          const pct = s.count / total * 100;
          const c = COLORS[s.source] || "var(--ink-dim)";
          // 2026-10-22 a11y：段内是白字，但 c 可能是很亮的色（深色主题的 accent #60a5fa、浅灰 --ink-dim），
          //   白字压上去只有 2.5~2.7。统一把底色压暗到 70%（仍保留色相），白字对比度全部 ≥4.5。
          return (
            <div
              key={s.source}
              className="seg"
              style={{ width: `${pct}%`, background: `color-mix(in srgb, ${c} 70%, #000)` }}
            >
              {pct >= 8 ? pct.toFixed(1) + "%" : ""}
            </div>
          );
        })}
      </div>
      <div className="split-legend">
        {sources.map(s => {
          const c = COLORS[s.source] || "var(--ink-dim)";
          const pct = (s.count/total*100).toFixed(1);
          return <span key={s.source} className="item"><span className="sq" style={{background: c}}></span>{LABEL[s.source] || s.source} · {s.count} ({pct}%)</span>;
        })}
      </div>
    </>
  );
}
