// [UI-S6 / 屏06 智能体详情 · 运行]
// 服务端渲染真实运行读数: 实时状态 / 执行统计 / 最近一次执行与产出 / 该智能体的会话档案。
// Phase3 屏06 增量 (2026-09-18): 在『最近会话』下方接 D 型密度热力图 <DensityHeatmap>,
//   行 = 近 30 天 (2026-09-18 注: 实测 pending24h=0, 最近会话在 8 月, 7 天窗口无数据;
//   故窗口扩到 30 天保证密度图能呈现, 否则只有空态文字), 列 = 会话状态, 单元格 = 当天该状态归档数。
//   语义色 = --brand 单色 ramp, 三主题跟随 (规范 §7)。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 五张手写 .tbl 表 → 白名单 DataTable。
//   四张「标签 → 值」表用 .kvTable 藏掉 DataTable 的空表头行；取数与字段一字未改。
import type { ReactNode } from "react";
import Link from "next/link";
import KPICard from "@/components/KPICard";
import AgentShell, { AgentTabHeader } from "../_components/AgentShell";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import DensityHeatmap, { type DensityHeatmapCell } from "@/components/DensityHeatmap";
import { fmtAgo, fmtTime, loadAgent, loadLive, loadSessions } from "../_data";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const SCOPE_LABELS: Record<string, string> = {
  MECHANISM: "机制修复类",
  VERIFY: "智能体型（验证裁决）",
  DISCUSSION: "对话问答",
  OTHER: "其他",
};

function badgeClass(status?: string | null): string {
  // 2026-10-26：活库状态键是 DONE；原来只认 COMPLETED/PROCESSED → 已提炼不绿。
  if (status === "COMPLETED" || status === "DONE" || status === "PROCESSED") return "badge badge-green";
  if (status === "FAILED") return "badge badge-red";
  if (status === "PENDING" || status === "IN_PROGRESS") return "badge badge-yellow";
  return "badge badge-blue";
}

/** 「标签 → 值」两列（改前是 手写表格<tbody> 里逐行 <th>/<td>） */
type KvRow = { label: string; value: ReactNode };
/** 最近会话表：每个单元格都是服务端已渲染好的节点（列定义里没有函数） */
type SessionTableRow = {
  title: ReactNode;
  source: ReactNode;
  message_count: ReactNode;
  status: ReactNode;
  updated_at: ReactNode;
};
// 2026-11-05 热修：服务端组件不能把 render 函数传给客户端 DataTable，
//   列只留可序列化字段，单元格值在服务端预算成 ReactNode/字符串放进 rows。
const KV_COLUMNS: DataColumn<KvRow>[] = [
  { key: "label", title: "" },
  { key: "value", title: "" },
];

export default async function AgentRunsPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS, sessionsS] = await Promise.all([loadAgent(id), loadLive(id), loadSessions(id, 15)]);
  // 2026-11-06 D-03：先备好页签页头 —— 名册失败/智能体不存在/正常三条分支都要渲染它，
  //   否则 SSR 首屏没有 page-header（0.4.31 dev 实测 5 页 70/75 的根因就是只有"正常"分支带页头）。
  const tabHeader = (
    <AgentTabHeader
      id={id}
      tab="运行"
      title="智能体详情 · 运行"
      subtitle="实时状态、执行统计与最近产出"
      agent={agentLoad.ok ? agentLoad.agent : null}
      live={liveS.data}
    />
  );
  if (!agentLoad.ok) return <AgentSourceError id={id} header={tabHeader} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  const sessions = sessionsS.data;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push("实时状态 /api/agents-live");
  if (!sessionsS.ok) degraded.push("会话档案 /api/session-list");
  if (!agent && !live) return <AgentMissing id={id} header={tabHeader} />;
  const sess = sessions.items;
  const exec = live?.execStats ?? {};
  const lastExec = live?.lastExecution ?? null;
  const lastOut = live?.lastOutput ?? null;
  const scopes = live?.doneByScope ?? {};
  const scopeKeys = Object.keys(scopes);

  const liveRows: KvRow[] = [
    { label: "状态", value: live?.stateLabel || "-" },
    { label: "卡住原因", value: live?.stuckReason || "无" },
    { label: "近 24 小时消息", value: <span className={styles.numCell}>{(live?.macsMessages24h ?? 0).toLocaleString()}</span> },
    { label: "最近露面", value: <>{fmtTime(live?.lastSeenAt)}（{fmtAgo(live?.lastSeenAt)}）</> },
    { label: "最近执行时间", value: <span className={styles.monoSm}>{fmtTime(exec.lastAt)}</span> },
  ];
  const scopeRows: KvRow[] = scopeKeys.map((k) => ({
    label: SCOPE_LABELS[k] || k,
    value: <span className={styles.numCell}>{(scopes[k] ?? 0).toLocaleString()}</span>,
  }));
  const lastExecRows: KvRow[] = [
    { label: "任务", value: lastExec?.taskTitle || lastExec?.id || "-" },
    { label: "状态", value: <span className={badgeClass(lastExec?.status)}>{lastExec?.status || "-"}</span> },
    { label: "质量通过", value: lastExec?.qualityPassed ? "是" : "否" },
    { label: "完成时间", value: <span className={styles.monoSm}>{fmtTime(lastExec?.completedAt)}</span> },
  ];
  const lastOutRows: KvRow[] = [
    { label: "产出时间", value: <span className={styles.monoSm}>{fmtTime(lastOut?.at)}</span> },
    { label: "产出质量", value: lastOut?.quality != null ? `${Math.round(Number(lastOut.quality) * 100)}%` : "-" },
    { label: "累计产出", value: (lastOut as any)?.n != null ? String((lastOut as any).n) : "-" },
  ];
  const sessionColumns: DataColumn<SessionTableRow>[] = [
    { key: "title", title: "标题" },
    { key: "source", title: "来源", width: 130 },
    { key: "message_count", title: "消息", width: 60, align: "right" },
    { key: "status", title: "状态", width: 100 },
    { key: "updated_at", title: "更新时间", width: 120 },
  ];
  const sessionRows: SessionTableRow[] = sess.map((s) => ({
    title: (
      <Link className={styles.sessionLink} href={`/sessions/detail?id=${encodeURIComponent(s.session_uid)}`}>{s.title || s.session_uid}</Link>
    ),
    source: <span className={styles.monoSm}>{s.source || "-"}</span>,
    message_count: <>{s.message_count ?? 0}</>,
    status: <span className={badgeClass(s.status)}>{s.status || "-"}</span>,
    updated_at: <span className={styles.monoSm}>{fmtTime(s.updated_at || s.uploaded_at)}</span>,
  }));

  return (
    <AgentShell
      id={id}
      active="runs"
      agent={agent}
      live={live}
      header={tabHeader}
    >
      {degraded.length ? (
        <div className={styles.alertRow}>
          <Alert type="warning" showIcon title="部分数据源降级" description={degraded.join("；")} />
        </div>
      ) : null}
      <div className="kpi-grid">
        <KPICard label="在办任务" value={(live?.taskStats?.running ?? 0).toLocaleString()} />
        <KPICard label="待开始任务" value={(live?.assignedPendingCount ?? 0).toLocaleString()} />
        <KPICard label="近期完成" value={(exec.completed ?? 0).toLocaleString()} />
        <KPICard label="近期失败" value={(exec.failed ?? 0).toLocaleString()} />
        <KPICard label="执行通过" value={(exec.passed ?? 0).toLocaleString()} />
        <KPICard label="产出质量" value={live?.outputQuality != null ? `${Math.round(Number(live.outputQuality) * 100)}%` : "-"} />
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-header"><span className="panel-title">实时状态</span></div>
          <TableCopyButton />
          <div className={styles.kvTable + " " + styles.kvW120}>
            <DataTable columns={KV_COLUMNS} rows={liveRows} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header"><span className="panel-title">按统计范围拆分（已办）</span></div>
          <TableCopyButton />
          <div className={styles.kvTable + " " + styles.kvW180}>
            <DataTable
              columns={KV_COLUMNS}
              rows={scopeRows}
              empty={{ title: "暂无已办记录" }}
            />
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-header"><span className="panel-title">最近一次执行</span></div>
          {lastExec ? (
            <div className={styles.kvTable + " " + styles.kvW110}>
              <DataTable columns={KV_COLUMNS} rows={lastExecRows} />
            </div>
          ) : (
            <div className={styles.emptyBlock}>暂无执行记录</div>
          )}
        </div>

        <div className="panel">
          <div className="panel-header"><span className="panel-title">最近一次产出</span></div>
          {lastOut ? (
            <div className={styles.kvTable + " " + styles.kvW110}>
              <DataTable columns={KV_COLUMNS} rows={lastOutRows} />
            </div>
          ) : (
            <div className={styles.emptyBlock}>暂无产出记录</div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">最近会话（{sessions.total.toLocaleString()} 条档案中最近 {sess.length} 条）</span>
          <Link href={`/sessions?agent=${encodeURIComponent(agent?.agent_id || id)}`} className={styles.adjustLink}>
            会话中心
          </Link>
        </div>
        <TableCopyButton />
        <DataTable
          columns={sessionColumns}
          rows={sessionRows}
          empty={{ title: "暂无会话档案" }}
        />
      </div>

      {/* Phase3 屏06 D 型密度热力图 (近 90 天 × 状态) */}
      <div className={"panel " + styles.panelTop}>
        <div className="panel-header">
          <span className="panel-title">会话密度热力（近 90 天 × 状态）</span>
          <span className={styles.metaSm}>色深 = 该状态当天归档数</span>
        </div>
        {(() => {
          // 行: 近 90 天 (按近到远), 列: 4 个状态
          //   实测 (2026-09-18) 该智能体最近 15 条会话跨度 2026-07-25 ~ 2026-07-27, 全部落在 90 天窗口内。
          //   因此采用 90 天而不是 7/30 天, 保证密度图可呈现 (否则永远空态)。
          // 2026-10-26：补 DONE（活库键），否则密度图把"已提炼"整类排除在外。
          const statuses = ["DONE", "PROCESSED", "PENDING", "FAILED", "SKIPPED"];
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const dayLabels: string[] = [];
          for (let i = 0; i < 90; i++) {
            const d = new Date(today.getTime() - i * 86_400_000);
            dayLabels.unshift(`${d.getMonth() + 1}/${d.getDate()}`);
          }
          // 计算: key[status][dayLabel] -> count
          const m = new Map<string, number>();
          for (const s of sess) {
            const ts = s.updated_at || s.uploaded_at;
            if (!ts) continue;
            const ms = Date.parse(ts);
            if (!Number.isFinite(ms)) continue;
            const d = new Date(ms);
            d.setHours(0, 0, 0, 0);
            const diffDays = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
            if (diffDays < 0 || diffDays >= 90) continue;
            const dayLabel = dayLabels[dayLabels.length - 1 - diffDays];
            const st = (s.status || "").toUpperCase();
            const key = `${dayLabel} ${st}`;
            m.set(key, (m.get(key) ?? 0) + 1);
          }
          const cells: DensityHeatmapCell[] = [];
          for (const day of dayLabels) {
            for (const st of statuses) cells.push({ row: day, col: st, value: m.get(`${day} ${st}`) ?? 0 });
          }
          const totalCount = cells.reduce((s, c) => s + c.value, 0);
          return totalCount === 0 ? (
            <div className={styles.emptyBlockMd}>
              近 90 天该智能体在最近 {sess.length} 条会话中没有命中, 无法绘制密度图。
            </div>
          ) : (
            <div className={styles.heatWrap}>
              <DensityHeatmap
                rows={dayLabels}
                cols={statuses}
                cells={cells}
                colWidth={42}
                ariaLabel={`近 90 天会话按状态密度分布, 共 ${totalCount} 条`}
              />
            </div>
          );
        })()}
      </div>
    </AgentShell>
  );
}
