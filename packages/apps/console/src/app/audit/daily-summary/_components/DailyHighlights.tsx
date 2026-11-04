"use client";
import type { DailyReport } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";

/** 高分记忆 / 高优先级反思 / 智能体活动 / 飞轮事件+超容 */
export default function DailyHighlights({ d }: { d: DailyReport }) {
  return (
    <>
      <div className="grid-2">
        {/* 亮点：高分记忆 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">✨ 高分记忆</span></div>
          <div style={{ padding: "var(--sp-2) 0", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            {d.highlights.memories.map((m, i) => (
              <div key={i} style={{ fontSize: "var(--fs-base)" }}>
                <span style={{ color: "var(--text-muted)" }}>[{m.theme}]</span>{" "}
                <span>{m.title}</span>{" "}
                <span style={{ color: "var(--status-ok)", fontSize: "var(--fs-sm)" }}>q={m.score.toFixed(2)}</span>
              </div>
            ))}
            {d.highlights.memories.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-base)" }}>无高分记忆</span>}
          </div>
        </div>

        {/* 亮点：反思 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">💡 高优先级反思</span></div>
          <div style={{ padding: "var(--sp-2) 0", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            {d.highlights.reflections.map((r, i) => (
              <div key={i} style={{ fontSize: "var(--fs-base)" }}>
                <span className="badge badge-red">{r.priority}</span>{" "}
                <span style={{ color: "var(--text-muted)" }}>[{r.theme}]</span>{" "}
                <span>{r.title}</span>
              </div>
            ))}
            {d.highlights.reflections.length === 0 && <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-base)" }}>无</span>}
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* 智能体活动 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">智能体活动</span></div>
          <TableCopyButton />
          <table className="tbl">
            <thead><tr><th>来源</th><th>产出</th></tr></thead>
            <tbody>
              {d.agentActivity.map((a) => (
                <tr key={a.agent}><td style={{ fontSize: "var(--fs-base)" }}>{a.agent}</td><td className="num">{a.count}</td></tr>
              ))}
              {d.agentActivity.length === 0 && <tr><td colSpan={2} style={{ color: "var(--text-muted)", fontSize: "var(--fs-base)" }}>无</td></tr>}
            </tbody>
          </table>
        </div>

        {/* 飞轮事件 + 超容 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">飞轮事件 / 超容告警</span></div>
          <div style={{ padding: "var(--sp-2) 0" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1-5)", marginBottom: "var(--sp-2-5)" }}>
              {d.flywheelEvents.slice(0, 8).map((e) => (
                <span key={e.stage} className="badge badge-blue">{e.stage} <b>{e.count}</b></span>
              ))}
            </div>
            <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginBottom: "var(--sp-1)" }}>超容主题（限 50）</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1-5)" }}>
              {d.overCapacity.map((o) => (
                <span key={o.theme} className="badge badge-red">{o.theme} <b>{o.count}</b></span>
              ))}
              {d.overCapacity.length === 0 && <span style={{ color: "var(--status-ok)", fontSize: "var(--fs-base)" }}>✅ 无超容</span>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
