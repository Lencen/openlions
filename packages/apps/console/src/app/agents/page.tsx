"use client";
import KPICard from "@/components/KPICard";
import { t } from "@/i18n";
import EntryCard from "@/components/EntryCard";
import DataTable, { StateChip } from "@/components/DataTable";
import { getSubmodules } from "@/config/submodules";
import { fmtTime } from "@/lib/format";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import ErrorAlert from "@/components/ErrorAlert";
import DataMoment from "@/components/DataMoment";
type Agent = {agent_id:string;display_name:string;channel:string;host:string;status:string;profile?:any};
interface A { result?: { data?: Agent[] } }
interface B extends Array<Agent> {}
type AR = A | B
export default function AgentsDashboard() {
  const subs = getSubmodules("agents");
  const { data, loading, error, mutate } = useApi<AR>("/api/agent-list");
  const asOf = (data as any)?.asOf as string | undefined;   // 76-FZ: BFF 新给的"数据时刻"
  const agents = (Array.isArray(data) ? data : ((data as any)?.items ?? (data as any)?.result?.data)) ?? [];
  const { data: ssRaw } = useApi<{ result?: { data?: { total: number } } }>("/api/session-stats");
  const { data: statsRaw } = useApi<{ data?: { tables?: { skill: number } } }>("/api/stats");
  const { data: svcRaw } = useApi<{ name: string }[]>("/api/services-list");
  const sessionTotal = ssRaw?.result?.data?.total;
  const skillTotal = statsRaw?.data?.tables?.skill;
  const mcpCount = (svcRaw ?? []).filter(s => s.name.toLowerCase().includes("mcp")).length;
  return (<div className="layout"><main className="main">
    {/* 2026-10-15（round 76-FZ, 规范铁律 2）：这一页此前**没有任何"数据是什么时候的"** ✗（连全局筛选条都没有）。
        本 BFF 的注释里本来就写着"冻结快照 = agent 列表与当前任务双双停在编译时刻" ✗ —— 正是铁律 2 要治的。 */}
    <div className="page-header"><div className="page-title">{t('agentsPage.title')}</div><div className="page-subtitle">{t('agentsPage.subtitle')}{/* 2026-10-16 round 77-AB（决策③逐源 + 77-M 机检清单）: 本页有 **4 个数据源**, 分别喂 4 张 KPI 卡 ——
     智能体数←/api/agent-list、会话总数←/api/session-stats、技能←/api/stats、MCP←/api/services-list；
     而页头此前**只显示 agent-list 的时刻** ✗ -> 另外三张卡戴着智能体列表的时刻（"借时刻"）。
     实测前三个源各自都有顶层 asOf ✓; **services-list 返回的是数组**(BFF: NextResponse.json(mapped)),
     无法加顶层键 ✗ -> 按约定**显式显示「未知」**, 绝不借用别人的时刻 ✓（这正是四态规则要的诚实）。 */}
<DataMoment items={[{ label: "智能体", at: asOf }, { label: "会话", at: (ssRaw as any)?.asOf }, { label: "技能", at: (statsRaw as any)?.asOf }, { label: "服务", at: (svcRaw as any)?.asOf }]} /></div></div>
    <div className="kpi-grid">
      <KPICard label={t('agentsPage.total')} value={agents.length>0?agents.length:"..."} />
      <KPICard label="会话总数" value={sessionTotal!==undefined?sessionTotal.toLocaleString():"..."} />
      <KPICard label="技能" value={skillTotal!==undefined?skillTotal.toLocaleString():"..."} />
      <KPICard label={t('agentsPage.mcp')} value={svcRaw?mcpCount:"..."} />
    </div>
    <div className="dashboard-section"><div className="dashboard-section-title">{t('agentsPage.list')} {loading&&"（加载中...）"}</div>
      {/* 2026-10-25 R4: 卡片堆叠 → 表格（列对齐、数值右对齐、状态独立成列）。 */}
      <DataTable
        loading={loading && agents.length === 0}
        error={error ? String((error as Error)?.message || error) : null}
        onRetry={() => { mutate(); }}
        rows={agents as any[]}
        rowKey={(a: any, i) => a.agent_id || i}
        empty={{ title: "暂无智能体", desc: "接入一个智能体后，这里会显示它的运行时、状态与权限。" }}
        columns={[
          {
            key: "who", title: "智能体",
            render: (a: any) => (
              <div className="dt-cell-who">
                <span className="dt-avatar">{(a.display_name || a.agent_id || "·").slice(0, 2)}</span>
                <span>
                  <span className="dt-who-name">{a.display_name || a.agent_id}</span>
                  <span className="dt-who-sub">
                    {a.agent_id} · {a.channel || "未知通道"}
                    {a.source === "macs" ? <span className="dt-src" title="只登记在协同服务里，没登记进智能体注册表">仅协同</span> : null}
                  </span>
                </span>
              </div>
            ),
          },
          { key: "host", title: "运行时", render: (a: any) => <span className="dt-who-sub">{a.host || "—"}</span> },
          {
            key: "status", title: "状态", width: "110px",
            render: (a: any) => {
              const s = String(a.macsStatus || a.status || "").toUpperCase();
              const st = s === "ACTIVE" || s === "ONLINE" ? "ok" : s === "INACTIVE" || s === "OFFLINE" ? "warn" : "idle";
              const text = st === "ok" ? "在线" : st === "warn" ? "离线" : "未知";
              return <StateChip state={st as any} text={text} />;
            },
          },
          { key: "permissions", title: "权限", align: "right", width: "88px", render: (a: any) => a.permissions?.length ?? 0 },
          {
            // 2026-10-26（老板点名「智能体列表信息不全」）：补「当前任务 / 最近产物」。
            //   数据源：Task.assignedAgent（执行体名）+ status；取不到就显示「—」，不拿占位文案冒充。
            key: "currentTask", title: "当前任务", width: "240px",
            render: (a: any) => a.currentTask?.title
              ? <span className="dt-task" title={a.currentTask.title}>{a.currentTask.title}</span>
              : <span className="dt-who-sub">—</span>,
          },
          {
            key: "lastDone", title: "最近产物", width: "240px",
            render: (a: any) => a.lastDone?.title
              ? <span className="dt-task" title={a.lastDone.title + " · " + (a.lastDone.updatedAt || "")}>{a.lastDone.title}</span>
              : <span className="dt-who-sub">—</span>,
          },
          {
            key: "lastSeen", title: "最近活跃", align: "right", width: "150px",
            render: (a: any) => (
              <span className="dt-who-sub">
                {a.last_seen_at ? new Date(a.last_seen_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—"}
              </span>
            ),
          },
        ]}
      />
    </div>
    <div className="dashboard-section"><div className="dashboard-section-title">子模块入口</div>
      <div className="entry-grid">{subs.map(s=><EntryCard key={s.id} sub={s} />)}</div></div>
  </main></div>);
}
