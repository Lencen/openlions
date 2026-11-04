import React from "react";
import Topbar from "../../components/Topbar";
import Link from "next/link";
import { getTaskById, getExecutionRecords, getCronSessionRecordsAsync } from "@/lib/tasks-source";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const TRIGGER_LABELS: Record<string, string> = {
  "crontab": "系统 crontab",
  "openclaw-jobs": "OpenClaw jobs.json",
  "service-cron": "服务内 node-cron",
  "script": "业务脚本",
};

const PLATFORM_COLOR: Record<string, string> = {
  hermes: "#7c3aed",
  openclaw: "#d97706",
  dsh: "#2563eb",
  node: "#0d9488",
  shell: "#64748b",
};

const STATUS_COLOR: Record<string, string> = {
  ok: "var(--status-ok)",
  error: "var(--status-crit)",
  running: "var(--primary)",
  unknown: "var(--ink-muted)",
};

const fmt = (d: Date | null) =>
  d ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d) : "—";

function summarize(records: Array<{ status: string }>) {
  const c = { ok: 0, error: 0, running: 0, unknown: 0 };
  for (const r of records) {
    const k = r.status as keyof typeof c;
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

export default async function TaskDetailPage({ params }: { params: { id: string } }) {
  const task = getTaskById(decodeURIComponent(params.id));
  if (!task) notFound();

  let records: Array<{ ts: number; status: string; summary: string; detail: string; source: string }> = [];
  if (task.sessionKey) records = await getCronSessionRecordsAsync(task.sessionKey, 30);
  if (records.length === 0) records = getExecutionRecords(task, 30) as any;

  const sum = summarize(records);
  const totalRuns = records.length;
  const successRate = totalRuns > 0 ? Math.round((sum.ok / totalRuns) * 100) : 0;
  const execSource = records.length > 0 && records[0].source === "session"
    ? "session 服务 cron messages"
    : task.logFile || "—";
  const runsLabel = totalRuns > 30 ? `显示最近 30 / 共 ${totalRuns}+ 次` : `共 ${totalRuns} 次`;

  return (
    <>
      <Topbar
        active="tasks"
        crumb={<><Link href="/tasks">定时任务</Link> · {task.name}</>}
        stats={`${totalRuns} 次执行记录 · 成功率 ${successRate}%`}
      />
      <main className="page page-wide">
        <h1 style={{ marginBottom: 12 }}>{task.name}</h1>
        <div style={{ marginBottom: 24, display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge" style={{ background: "var(--primary-dim)", color: "var(--primary)", fontWeight: 500 }}>{task.business}</span>
          <span className="badge" style={{ background: "var(--surface-2)" }}>{TRIGGER_LABELS[task.trigger] || task.trigger}</span>
          <span className="uid" style={{ color: "var(--ink-muted)" }}>{task.schedule}</span>
        </div>

        <section className="panel" style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingBottom: 12, borderBottom: "2px solid var(--border)" }}>
            <span style={{ fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 4, height: 16, background: "var(--primary)", borderRadius: 2 }} />
              基本信息
            </span>
            <span className="uid" style={{ color: "var(--ink-muted)", fontSize: 12 }}>基本信息</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>任务 ID</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}><code style={{ fontSize: 12 }}>{task.id}</code></td>
              </tr>
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>业务来源</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>{task.business}</td>
              </tr>
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>触发方式</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>{TRIGGER_LABELS[task.trigger] || task.trigger} · {task.type === "cron" ? "Cron 表达式" : task.type === "interval" ? "固定间隔" : "手动触发"}</td>
              </tr>
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>定时周期</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}><code style={{ fontSize: 14, fontWeight: 600, color: "var(--primary)" }}>{task.schedule}</code></td>
              </tr>
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>执行 agent</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>{task.agent}</td>
              </tr>
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>Agent 平台</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 6, background: PLATFORM_COLOR[task.agentPlatform] || "#999" }} />
                    <strong style={{ fontWeight: 600 }}>{task.agentPlatform}</strong>
                  </span>
                </td>
              </tr>
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>描述</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>{task.description || "—"}</td>
              </tr>
              {task.logFile && (
                <tr>
                  <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>执行日志</td>
                  <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}><code style={{ fontSize: 11 }}>{task.logFile}</code></td>
                </tr>
              )}
              {task.sessionKey && (
                <tr>
                  <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>关联 session</td>
                  <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "1px solid var(--border)" }}>
                    <code style={{ fontSize: 11 }}>{task.sessionKey}</code>
                    <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-muted)" }}>(已从 session 列表过滤, 详情页直达)</span>
                  </td>
                </tr>
              )}
              <tr>
                <td style={{ width: 150, padding: "12px 16px 12px 0", color: "var(--ink-muted)", fontWeight: 500, fontSize: 13, verticalAlign: "top", borderBottom: "none" }}>命令</td>
                <td style={{ padding: "12px 0", fontSize: 13, verticalAlign: "top", borderBottom: "none" }}>
                  <pre style={{ background: "var(--surface-2)", padding: 14, borderRadius: 8, fontSize: 12, lineHeight: 1.6, overflowX: "auto", margin: 0, border: "1px solid var(--border)" }}>{task.command}</pre>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel" style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingBottom: 12, borderBottom: "2px solid var(--border)" }}>
            <span style={{ fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 4, height: 16, background: "var(--primary)", borderRadius: 2 }} />
              执行记录
              <span style={{ fontSize: 12, color: "var(--ink-muted)", fontWeight: 400, marginLeft: 6 }}>最近 {totalRuns} 次</span>
            </span>
            {totalRuns > 0 && (
              <span style={{ display: "flex", gap: 16, fontSize: 12 }}>
                <span style={{ color: "var(--status-ok)" }}>● 成功 {sum.ok}</span>
                <span style={{ color: "var(--status-crit)" }}>● 失败 {sum.error}</span>
                {sum.running > 0 && <span style={{ color: "var(--primary)" }}>● 运行中 {sum.running}</span>}
                <span style={{ color: "var(--ink-muted)" }}>·  成功率 {successRate}%</span>
              </span>
            )}
          </div>
          {records.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-muted)" }}>暂无执行记录</div>
          ) : (
            <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--surface-2)" }}>
                    <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", width: 140, textAlign: "left", color: "var(--ink-muted)", fontWeight: 500, fontSize: 11 }}>时间</th>
                    <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", width: 90, textAlign: "left", color: "var(--ink-muted)", fontWeight: 500, fontSize: 11 }}>状态</th>
                    <th style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--ink-muted)", fontWeight: 500, fontSize: 11 }}>概要</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "var(--surface-2)" }}>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-muted)" }} title={new Date(r.ts).toLocaleString("zh-CN")}>{fmt(new Date(r.ts))}</td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                        <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 4, fontSize: 11, fontWeight: 500, background: (STATUS_COLOR[r.status] || "var(--ink-muted)") + "22", color: STATUS_COLOR[r.status] || "var(--ink-muted)" }}>{r.status}</span>
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.55 }}>{r.detail || r.summary}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: "var(--ink-muted)", display: "flex", justifyContent: "space-between" }}>
              <span>执行来源: {execSource}</span>
              <span>{runsLabel}</span>
            </div>
            </>
          )}
        </section>
      </main>
    </>
  );
}
