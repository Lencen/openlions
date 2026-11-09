"use client";
// 2026-11-05 商业线裁决：301 -> /market，目录保留 60 天
import Link from "next/link";
import ErrorAlert from "@/components/ErrorAlert";
import { useBusinessSnapshot } from "./_components/useBusiness";
import BusinessShell from "./_components/BusinessShell";
import { OverviewCards, RedLines } from "./_components/OverviewParts";
import { ProductionFunnel, ConsumptionFunnel } from "./_components/Funnels";
import { OutputTrend, FlowTrend } from "./_components/TrendChart";
import { Panel, Pill, SimpleTable, Note } from "./_components/ui";
import { DIMENSIONS, dimensionMetrics, overviewMetrics, redLines, ACTIONS, ci, cp, ct, ctime } from "./_components/caliber";

export default function FlywheelBusinessPage() {
  const { data, error, loading, refreshing, refresh } = useBusinessSnapshot();

  if (loading && !data) {
    return (
      <div className="layout-with-sidebar"><main className="main">
        <div className="panel" style={{ padding: "var(--sp-5)" }}>正在读取飞轮业务快照…</div>
      </main></div>
    );
  }
  if (error || !data || !data.ok || !data.data) {
    return (
      <div className="layout-with-sidebar"><main className="main">
        <ErrorAlert title="飞轮业务看板加载失败" message={String((error as Error)?.message || (data && data.error) || "未知错误")} onRetry={() => { refresh(); }} />
      </main></div>
    );
  }

  const s = data.data;
  const b = s.business || {};
  const metrics = overviewMetrics(s);
  const lines = redLines(s);
  const series = (b.history && b.history.series) || [];
  const red = ACTIONS.filter((a) => a.status(s) !== "ok");
  const noData = b.noData || [];

  return (
    <BusinessShell data={data} active="overview" title="总览" subtitle="一页回答：正常吗 / 哪里卡 / 谁去动。所有数字来自同一份业务快照；无数据项显式标注，不画成 0。"
      onRefresh={refresh} refreshing={refreshing}>
      <OverviewCards metrics={metrics} s={s} />
      <RedLines lines={lines} />

      <div className="card-grid cols-2">
        <ProductionFunnel s={s} />
        <ConsumptionFunnel s={s} />
      </div>

      <div className="card-grid cols-2">
        <Panel title="14 天产出与结构化" extra="UTC 自然日 · R3 阴影区">
          {series.length ? <div style={{ minHeight: 280 }}><OutputTrend series={series} /></div> : <Note>无 14 天序列；请先生成业务快照。</Note>}
          <Note>结构化产物是任务生成的进水口。最近一日结构化 {ci((s.output && s.output.format && (Number(s.output.format.Knowledge?.n) || 0) + (Number(s.output.format.Memory?.n) || 0) + (Number(s.output.format.Practice?.n) || 0)))} 条；14 天里跨了 R2/R3，不能把两段混成一条趋势结论。</Note>
        </Panel>
        <Panel title="14 天认领与交付" extra="R3 阴影区 · 智能体交付为虚线">
          {series.length ? <div style={{ minHeight: 280 }}><FlowTrend series={series} /></div> : <Note>无 14 天序列；请先生成业务快照。</Note>}
          <Note>认领在 10-23 达到峰值，之后完成掉到 0–10；这是“交付链路断了”，不是“需求没了”。</Note>
        </Panel>
      </div>

      <Panel title="8 个业务维度" extra="每个维度都可深链；每页至少一条 指标→责任人→阈值→动作→复算">
        <div className="card-grid cols-4" style={{ marginBottom: 0 }}>
          {DIMENSIONS.map((d) => {
            const ms = dimensionMetrics(d.id, s);
            const m = ms[0];
            const st = m ? m.status(s) : "nodata";
            return (
              <Link key={d.id} href={d.href} className="panel" data-dim={d.id}
                style={{ padding: "var(--sp-3)", textDecoration: "none", color: "inherit", borderLeft: "3px solid var(--border-hi)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <strong>{d.code} {d.title}</strong>
                  <Pill status={st} />
                </div>
                <div className="tiny" style={{ color: "var(--text-muted)", marginTop: 4, minHeight: 34 }}>{d.question}</div>
                <div style={{ fontSize: "var(--fs-lg)", fontWeight: 600, marginTop: 4 }}>{m ? m.value(s) : "—"}</div>
                <div className="tiny" style={{ color: "var(--text-muted)" }}>{m ? m.label : "无数据"}</div>
              </Link>
            );
          })}
        </div>
      </Panel>

      <div className="card-grid cols-2">
        <Panel title="告警与判读" extra="来自快照 notes + 数据健康红线">
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            {(s.notes || []).map((x: string, i: number) => <li key={"n" + i} className="tiny">{x}</li>)}
            {(b.health && b.health.redlines || []).map((x: string, i: number) => <li key={"r" + i} className="tiny" style={{ color: "var(--status-crit)" }}>健康红线：{x}</li>)}
            {red.slice(0, 4).map((a) => <li key={a.key} className="tiny" style={{ color: "var(--status-warn)" }}>{a.metric}：{a.current(s)}（阈值 {a.threshold}）→ {a.owner}</li>)}
          </ul>
          {!((s.notes || []).length || (b.health && b.health.redlines || []).length || red.length) ? <Note>当前没有告警。</Note> : null}
        </Panel>
        <Panel title="无数据 / 不完整项" extra="无数据 ≠ 达标；不完整 ≠ 0">
          {noData.length ? (
            <SimpleTable head={["项目", "原因", "复算"]} rows={noData.map((x: any) => [x.label, x.reason, <code key={x.key}>{x.verify}</code>])} />
          ) : <Note>本次没有无数据项。</Note>}
        </Panel>
      </div>

      <Panel title="口径警示（权威口径与业务扩展的差异）" extra="看板必须按“用哪一列”读">
        <SimpleTable
          head={["字段", "问题", "本页改用", "复算"]}
          rows={(b.canonicalWarnings || []).map((w: any) => [<code key="f">{w.field}</code>, w.issue, w.use, <code key="v">{w.verify}</code>])}
          empty="无"
        />
      </Panel>

      <div className="card-grid cols-3">
        <Panel title="资产快照" extra="不是调研稿的 16:10 数字">
          <div className="tiny" style={{ lineHeight: 1.8 }}>
            <div>记忆 {ci(b.assets && b.assets.totals && b.assets.totals.Memory)} · 知识 {ci(b.assets && b.assets.totals && b.assets.totals.Knowledge)} · 实践 {ci(b.assets && b.assets.totals && b.assets.totals.Practice)} · 技能 {ci(b.assets && b.assets.totals && b.assets.totals.Skill)}</div>
            <div>主题反思 {ci(b.assets && b.assets.reflection && b.assets.reflection.topic)} · 历史反思 {ci(b.assets && b.assets.reflection && b.assets.reflection.legacy)}（双表未收口）</div>
            <div>实践→记忆连接 {cp(b.assets && b.assets.connections && b.assets.connections.memory && b.assets.connections.memory.pct)} · →知识 {cp(b.assets && b.assets.connections && b.assets.connections.knowledge && b.assets.connections.knowledge.pct)}</div>
          </div>
        </Panel>
        <Panel title="词元两层" extra="不可相加">
          <div className="tiny" style={{ lineHeight: 1.8 }}>
            <div>网关通道级 {ct(b.cost && b.cost.gateway && b.cost.gateway.tokens)}（{ci(b.cost && b.cost.gateway && b.cost.gateway.calls)} 次调用）</div>
            <div>平台内部 {ct(b.cost && b.cost.platform && b.cost.platform.tokens)}（单列）</div>
            <div>逐智能体归因覆盖 {cp(b.cost && b.cost.agent && b.cost.agent.coveragePct)}（只做参考）</div>
            <div>单价 {b.cost && b.cost.unitPriceCny == null ? "未配置，不出金额" : b.cost.unitPriceCny + " 元/千词元"}</div>
          </div>
        </Panel>
        <Panel title="审计五类" extra="Asia/Shanghai 本地墙钟">
          <div className="tiny" style={{ lineHeight: 1.8 }}>
            <div>窗口内 {ci(b.audit && b.audit.events)} 条 · 高危 {ci(b.audit && b.audit.highRisk)} 条 · 最后 {ctime(b.audit && b.audit.lastAt)}</div>
            <div>资产 {ci(b.audit && b.audit.classes && b.audit.classes.asset)} · 访问 {ci(b.audit && b.audit.classes && b.audit.classes.access)} · 决策 {ci(b.audit && b.audit.classes && b.audit.classes.decision)} · 任务 {ci(b.audit && b.audit.classes && b.audit.classes.task)} · 系统 {ci(b.audit && b.audit.classes && b.audit.classes.system)}</div>
            <div>审计时间与业务 UTC 分开看，不混算。</div>
          </div>
        </Panel>
      </div>
    </BusinessShell>
  );
}
