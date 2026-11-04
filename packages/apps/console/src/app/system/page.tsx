"use client";
import EntryCard from "@/components/EntryCard";
import DataTable, { StateChip } from "@/components/DataTable";
import FlywheelFlow from "@/components/FlywheelFlow";
import { getSubmodules } from "@/config/submodules";
import { serviceLabel } from "@/config/systemLabels";
import { t } from "@/i18n";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import ErrorAlert from "@/components/ErrorAlert";
import { fmtTime , UNKNOWN } from "@/lib/format";
import DataMoment from "@/components/DataMoment";
interface S { result?: { data?: { learning: any; memory: any; knowledge: any } }; /** 76-GM: BFF 顶层新增的"数据时刻" */ asOf?: string }
interface PingData {
  /** 77-K: BFF 顶层新增的"数据时刻" */
  asOf?: string; services: { name: string; code: number; ms: number; alive: boolean }[] }
export default function SystemDashboard() {
  const subs = getSubmodules("system");
  const { data, error, mutate } = useApi<S>("/api/stats-overview");
  const { data: pingData, error: pingErr, mutate: mutatePing } = useApi<PingData>("/api/service-ping");
  const st = data?.result?.data;
  // 2026-10-13 round 76-DF: ping 还没回来时**不要显示 0 / 5 与 0ms** —— 那是**假计数**
  //   (用户会以为"全部服务都挂了")。网格区本来就写了"检测中...", 但这两个数字没有守卫。
  const pingsLoading = !pingData && !pingErr;
  const pings: Record<string, { code: number; ms: number; alive: boolean }> = {};
  (pingData?.services ?? []).forEach(p => { pings[p.name] = p; });

  const aliveCount = Object.values(pings).filter(p => p.alive).length;
  const pingList = Object.values(pings);
  const avgMs = pingList.length
    ? Math.round(pingList.reduce((s, p) => s + p.ms, 0) / pingList.length)
    : 0;

  // 2026-10-25 R8：这三条进度条原来是**写死的 85% / 62% / 48%**（不是数据，只是装饰），
  //   而且各配一个模块色 —— 既违反"数据准确"也违反"颜色只表状态"。
  //   改成真实占比（记忆 / 知识 / 反思 三项合计），统一用主色；取不到就 0。
  const totals = [st?.memory?.total, st?.knowledge?.total, st?.learning?.total].map((v: any) => Number(v) || 0);
  const sum3 = totals.reduce((a: number, b: number) => a + b, 0);
  const pct = (k: "memory" | "knowledge" | "learning") => {
    const v = Number((st as any)?.[k]?.total) || 0;
    return sum3 > 0 ? Math.round((v / sum3) * 100) : 0;
  };

  return (<div className="layout"><main className="main">
    <div className="page-header"><div className="page-title">业务与系统</div><div className="page-subtitle">业务对接 · 统一认证 · 权限管理 · 服务运维 · 审计<DataMoment items={[{ label: "服务", at: pingData?.asOf, loading: pingsLoading }, { label: "概览", at: data?.asOf }]} /></div></div>
    {(error || pingErr) ? <ErrorAlert title="系统概览加载失败" message={String(((error || pingErr) as Error)?.message || (error || pingErr))} onRetry={() => { mutate(); mutatePing(); }} /> : null}

    <div className="dashboard-section"><div className="dashboard-section-title">服务状态</div>
    {/* 2026-10-26 R8：服务状态原来是 5 张「标题 + 状态点」小卡（与下面 4 张指标卡、10 个模块卡
        三种解剖混在一页）。改成一张表：一列服务、一列状态、一列响应时间 —— 扫读更快，
        也不再用「卡片堆」表达"一份清单"。 */}
    <DataTable
      loading={Object.entries(pings).length === 0}
      rows={Object.entries(pings).map(([name, p]: any) => ({ key: name, name, ...p }))}
      rowKey={(r: any) => r.key}
      empty={{ title: "正在检测服务", desc: "首次探测需要几秒。" }}
      columns={[
        {
          key: "name", title: "服务",
          render: (r: any) => (
            <span>
              <span style={{ fontWeight: 500 }}>{serviceLabel(r.name)}</span>
              <span className="dt-who-sub">{r.port ? "localhost:" + r.port : ""}</span>
            </span>
          ),
        },
        {
          key: "state", title: "状态", width: "130px",
          render: (r: any) => <StateChip state={r.alive ? "ok" : "crit"} text={r.alive ? "可达" : "不可达"} />,
        },
        {
          key: "ms", title: "响应", align: "right", width: "110px",
          render: (r: any) => <span className="dt-num">{r.ms != null ? r.ms + " ms" : "—"}</span>,
        },
      ]}
    />
    </div>

    <div className="trend-grid">
      <div className="trend-card">
        <div className="trend-label"><span>服务在线</span></div>
        <div className="trend-val" style={{ color: aliveCount === 5 ? "var(--status-ok)" : "var(--status-warn)" }}>
          {pingsLoading ? "… / 5" : `${aliveCount} / 5`}
        </div>
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginBottom: "var(--sp-2)" }}>
          平均响应 {pingsLoading ? "…" : `${avgMs}ms`}
        </div>
        <div className="mini-bar" style={{ width: "100%" }}>
          <div className="mini-bar-fill" style={{ width: `${(aliveCount / 5) * 100}%`, background: aliveCount === 5 ? "var(--status-ok)" : "var(--status-warn)" }} />
        </div>
      </div>
      <div className="trend-card">
        <div className="trend-label"><span>记忆</span></div>
        <div className="trend-val">{st ? (st.memory?.total?.toLocaleString() ?? 0) : "..."}</div>
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginBottom: "var(--sp-2)" }}>统一记忆 · 占 {pct("memory")}%</div>
        <div className="mini-bar" style={{ width: "100%" }}><div className="mini-bar-fill" style={{ width: `${pct("memory")}%` }} /></div>
      </div>
      <div className="trend-card">
        <div className="trend-label"><span>知识</span></div>
        <div className="trend-val">{st ? (st.knowledge?.total?.toLocaleString() ?? 0) : "..."}</div>
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginBottom: "var(--sp-2)" }}>统一知识 · 占 {pct("knowledge")}%</div>
        <div className="mini-bar" style={{ width: "100%" }}><div className="mini-bar-fill" style={{ width: `${pct("knowledge")}%` }} /></div>
      </div>
      <div className="trend-card">
        <div className="trend-label"><span>反思</span></div>
        <div className="trend-val">{st ? (st.learning?.total?.toLocaleString() ?? 0) : "..."}</div>
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginBottom: "var(--sp-2)" }}>反思学习 · 占 {pct("learning")}%</div>
        <div className="mini-bar" style={{ width: "100%" }}><div className="mini-bar-fill" style={{ width: `${pct("learning")}%` }} /></div>
      </div>
    </div>

    <div className="dashboard-section"><div className="dashboard-section-title">子模块入口</div>
    <div className="entry-grid">{subs.map(s=><EntryCard key={s.id} sub={s} />)}</div></div>

    <div className="panel"><div className="panel-header"><span className="panel-title">业务知识合并流程</span></div>
      <FlywheelFlow steps={[{label:"业务系统注册"},{label:"认证配置"},{label:"权限映射"},{label:"知识提取"},{label:"去重/关联"},{label:"合并到知识",active:true},{label:"AI 可查询"}]} /></div>
  </main></div>);
}
