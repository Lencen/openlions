"use client";
// flywheel/flow 页 · LLM 入口 + session 处理面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 两张手写 .tbl 换成白名单 DataTable。
//   列/字段/文案不变；无表头的那张（来源 → 事件数）用 .flowSrcHeadless 藏掉 DataTable 的空表头行。
//   动态色（已提炼 ok / 失败 >3 crit）走 data-tone 属性选择器。取数口径与 props 一字未改。
import { t } from "@/i18n";
import type { FlowData } from "./types";
import { fmtN } from "./format";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import styles from "../page.module.css";

export default function FlowSourcesSessions({ d }: { d: FlowData | null }) {
  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-header"><span className="panel-title">LLM 调用入口 + 反思→任务 (24h)</span></div>
        {(d?.sources?.length ?? 0) ? (
          <>
          <TableCopyButton />
          <div className={styles.flowSrcHeadless}>
            <DataTable
              columns={[
                { key: "source", title: "", render: (s: any) => <code className={styles.flowSrcCode}>{s.source}</code> },
                { key: "events", title: "", align: "right", render: (s: any) => fmtN(s.events) },
              ]}
              rows={d!.sources.slice(0, 12)}
              rowKey={(s: any, i: number) => String(s.source) + i}
            />
          </div>
          </>
        ) : <div className="state-block">{d ? "暂无" : "…"}</div>}
      </div>
      <div className="panel">
        <div className="panel-header"><span className="panel-title">{t('flow.sessByAgent')}</span></div>
        {(d?.sessByAgent?.length ?? 0) ? (
          <>
          <TableCopyButton />
          <DataTable
            columns={[
              { key: "agentId", title: t('flow.col.agent'), render: (a: any) => <strong className="nowrap">{String(a.agentId).replace("agent-", "")}</strong> },
              { key: "total", title: "同步", align: "right", render: (a: any) => fmtN(a.total) },
              { key: "doneN", title: "已提炼", align: "right", render: (a: any) => <span className={styles.flowSrcTone} data-tone="ok">{fmtN(a.doneN)}</span> },
              { key: "pendingN", title: "待处理", align: "right", render: (a: any) => fmtN(a.pendingN) },
              {
                key: "failedN",
                title: "失败",
                align: "right",
                render: (a: any) => (
                  <span className={styles.flowSrcTone} data-tone={(a.failedN || 0) > 3 ? "crit" : "mute"}>{fmtN(a.failedN)}</span>
                ),
              },
            ]}
            rows={d!.sessByAgent.slice(0, 10)}
            rowKey={(a: any, i: number) => String(a.agentId) + i}
          />
          </>
        ) : <div className="state-block">{d ? "暂无" : "…"}</div>}
        {(d?.recentProcessed?.length ?? 0) > 0 && (
          <div className={styles.flowSrcRecent}>
            最近已提炼:
            {d!.recentProcessed.slice(0, 5).map((s) => (
              <div key={s.sessionUid} className="truncate">
                <span className={styles.flowSrcRecentAgent}>{String(s.agentId).replace("agent-", "")}</span> · {String(s.sessionUid).split(":").pop()} · {s.messageCount}msgs · {s.t}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
