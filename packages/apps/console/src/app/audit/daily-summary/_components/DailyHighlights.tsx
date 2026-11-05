"use client";
import type { DailyReport } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import styles from "../page.module.css";

/** 高分记忆 / 高优先级反思 / 智能体活动 / 飞轮事件+超容
 *  2026-11-05 P2 呈现层：内联 style 清零（类在 ../page.module.css），
 *  「智能体活动」由裸 table.tbl 换成白名单 DataTable（列不变：来源 / 产出）。 */
export default function DailyHighlights({ d }: { d: DailyReport }) {
  const activityCols = [
    { key: "agent", title: "来源", render: (r: { agent: string; count: number }) => r.agent },
    { key: "count", title: "产出", align: "right" as const, render: (r: { agent: string; count: number }) => r.count },
  ];
  return (
    <>
      <div className="grid-2">
        {/* 亮点：高分记忆 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">✨ 高分记忆</span></div>
          <div className={styles.dhHlList}>
            {d.highlights.memories.map((m, i) => (
              <div key={i} className={styles.dhHlItem}>
                <span className={styles.dhDim}>[{m.theme}]</span>{" "}
                <span>{m.title}</span>{" "}
                <span className={styles.dhScore}>q={m.score.toFixed(2)}</span>
              </div>
            ))}
            {d.highlights.memories.length === 0 && <span className={styles.dhEmpty}>无高分记忆</span>}
          </div>
        </div>

        {/* 亮点：反思 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">💡 高优先级反思</span></div>
          <div className={styles.dhHlList}>
            {d.highlights.reflections.map((r, i) => (
              <div key={i} className={styles.dhHlItem}>
                <span className="badge badge-red">{r.priority}</span>{" "}
                <span className={styles.dhDim}>[{r.theme}]</span>{" "}
                <span>{r.title}</span>
              </div>
            ))}
            {d.highlights.reflections.length === 0 && <span className={styles.dhEmpty}>无</span>}
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* 智能体活动 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">智能体活动</span></div>
          <TableCopyButton />
          <DataTable columns={activityCols} rows={d.agentActivity} rowKey={(r) => r.agent} empty={{ title: "无" }} />
        </div>

        {/* 飞轮事件 + 超容 */}
        <div className="panel">
          <div className="panel-header"><span className="panel-title">飞轮事件 / 超容告警</span></div>
          <div className={styles.dhPadY}>
            <div className={styles.dhChipsGap}>
              {d.flywheelEvents.slice(0, 8).map((e) => (
                <span key={e.stage} className="badge badge-blue">{e.stage} <b>{e.count}</b></span>
              ))}
            </div>
            <div className={styles.dhCap}>超容主题（限 50）</div>
            <div className={styles.dhChips}>
              {d.overCapacity.map((o) => (
                <span key={o.theme} className="badge badge-red">{o.theme} <b>{o.count}</b></span>
              ))}
              {d.overCapacity.length === 0 && <span className={styles.dhOk}>✅ 无超容</span>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
