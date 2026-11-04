"use client";
// 内部启用方式(不要显示给用户): 在 packages/apps/console/.env.local 加 NEXT_PUBLIC_UI_V2=1 并重新构建。
// 2026-09-19 [UI重构] Phase2 屏02 工作台 (Phase2 antd 绞杀式替换 + NEXT_PUBLIC_UI_V2 灰度)
//
// 来源: 13 屏清单 屏02 工作台 — 路径 (console)/workbench, 落地为 src/app/workbench/page.tsx。
//   Demo 节点 8:75 (docs/frontend-redesign-v2/demo-screens/02-workbench_8-75.png), 落地对照 docs/frontend-redesign-v2/给deepseek_前端重构方案.md 附 A 第 592 行。
//
// 灰度机制 (Phase2 验收 ④ ui-v2-consumed):
//   - NEXT_PUBLIC_UI_V2=1 → 渲染完整驾驶舱 (紧凑版, 直接复用 /api/overview 真实数据 + 自研 MetricCard/Sparkline 家族)
//   - 默认 (OFF)         → 渲染"施工中"占位卡 + 跳转 / 总览页的引导, 不破坏现有路由, 行为与改动前一致
//   这样默认 3004 上 02 工作台是 0 视觉干扰的安全占位; 需要试新视图只需在 .env.local 打开 NEXT_PUBLIC_UI_V2=1, 不需要改代码。
//
// antd 绞杀 (Phase2 验收 ① antd-zero): 本文件所有控件均来自 @/components/primitives 或 @/components/ui 自研层,
//   无 antd 直接引用 (grep from ['"]antd["'] 本文件 = 0 行)。
import Link from "next/link";
import { useMemo } from "react";
import { Alert } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { ErrorBlock, MetricCard, PageHero, PanelCard, Pill, StateBlock } from "@/components/ui";
import { fmtCompact, fmtNum } from "@/lib/format";
import { uiV2Enabled } from "@/lib/ui-flag";

/** 灰度 OFF 时显示的施工中占位 (含一行简短说明 + 跳既有 / 总览) */
function WorkbenchPlaceholder() {
  return (
    <main className="page">
      <PageHero title="工作台" subtitle="屏 02 · 一屏回答 6 件事, 驾驶舱式布局" />
      <PanelCard title="施工中" tone="var(--text-3)">
        {/* 2026-10-15（round 76-GQ, 规范铁律 3「不裸露内部词」）**改写过这段文案**。
           改写前它直接对着用户写：环境变量名 NEXT_PUBLIC_UI_V2 + 一行 shell 命令
           (echo 'NEXT_PUBLIC_UI_V2=1' >> packages/apps/console/.env.local && 重新构建) ✗ ——
           用户看不懂，而且把内部实现暴露给了用户 ✗。守门脚本当时报 0（它的词表没覆盖这类）。
           改写原则: ① 说清"现在是什么状态"（诚实）；② 给一个**用户能做的下一步**（规范 §2）；
                     ③ 内部启用方式移到本文件注释里（见文件顶部），知识不丢、但不再给用户看。 */}
        <div className="state-block">
          <div style={{ fontSize: "var(--fs-md)", color: "var(--text)", marginBottom: "var(--sp-2)" }}>
            这个新工作台还在小范围试用中，你当前看到的版本尚未开启它。
          </div>
          <div className="tiny" style={{ marginBottom: "var(--sp-3)" }}>
            先继续用现有视图即可，功能没有减少：请去 <Link href="/" className="link">总览首页</Link>。
          </div>
          <Pill tone="mute">当前未启用 · 现有功能不受影响</Pill>
        </div>
      </PanelCard>
    </main>
  );
}

/** 屏 02 主驾驶舱 — 4 指标 + 1 决策卡 + 2 列趋势/活动 + 智能体矩阵
 *  数据复用 /api/overview, 不重复 BFF; 渲染走自研 MetricCard + PanelCard, 与 / 总览一致视觉但更紧凑。 */
function WorkbenchCockpit({ data, loadingCards }: { data: any; loadingCards: boolean }) {
  const s = data?.sessions;
  const prod = data?.products;
  const tasks = data?.tasks;
  const agents = data?.agents;
  const decisions = data?.decisions ?? data?.humanDecisions;
  const topAgents: Array<{ id: string; n: number }> = (agents?.top ?? []).slice(0, 6);

  return (
    <main className="page">
      <PageHero
        title="工作台"
        subtitle="屏 02 · 6 件事驾驶舱"
        tags={
          <>
            <Pill tone="info">{data?.range?.label || "近 24 小时"}</Pill>
            {/* 2026-10-15（round 76-GR）原来这里是 `UI_V2 ON · Phase2 灰度` ✗ ——
                和 76-GQ 修的那段同一类: 把内部开关名与阶段代号给用户看 ✗。
                改成用户能理解的信息: 他看到的是"新版视图" ✓（内部代号留在注释里）。 */}
            <Pill tone="ok">新版视图</Pill>
            {agents?.macsOnline >= 0 ? <Pill tone="ok">{agents.macsOnline} 个智能体在线</Pill> : null}
          </>
        }
      />

      {data?.warnings?.length ? (
        <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-4)" }} title="部分指标降级" description={data.warnings.join("；")} />
      ) : null}

      {/* 4 指标 (与 demo 一致) */}
      <div className="metric-row">
        <MetricCard
          label="会话流入"
          tone="info"
          value={loadingCards ? "…" : fmtNum(s?.newSessions)}
          unit="个会话"
          hint={fmtNum(s?.inflowMessages) + " 条消息"}
          trend={s?.trend}
          footer={s?.trendPct != null ? <span className="tiny">vs 上一窗口 {s.trendPct >= 0 ? "+" : ""}{s.trendPct.toFixed(1)}%</span> : null}
        />
        <MetricCard
          label="认知提炼率"
          tone="ok"
          value={loadingCards ? "…" : (prod?.extractionRate != null ? prod.extractionRate.toFixed(1) : "—")}
          unit="%"
          hint={"已提炼 " + fmtNum(prod?.extractedSessions) + " 件"}
          footer={<span className="tiny">{`产物 ${fmtNum(prod?.total)} 条`}</span>}
        />
        <MetricCard
          label="执行健康度"
          tone={tasks?.errorRate > 2 ? "warn" : "ok"}
          value={loadingCards ? "…" : ((100 - (tasks?.errorRate ?? 0)).toFixed(1))}
          unit="% 成功率"
          hint={"成功 " + fmtNum(tasks?.done) + " · 失败 " + fmtNum(tasks?.failed)}
          footer={<span className="tiny">进行中 {fmtNum(tasks?.running)}</span>}
        />
        <MetricCard
          label="需要人决策"
          tone={decisions?.pending > 0 ? "warn" : "mute"}
          value={loadingCards ? "…" : fmtNum(decisions?.pending ?? 0)}
          unit="项待审阅"
          hint={decisions?.highlights ? decisions.highlights.join(" / ") : "暂无新增"}
        />
      </div>

      {/* 趋势 + 活动 (2 列) */}
      <div className="card-grid cols-2">
        <PanelCard title="会话流入趋势" extra={<span className="tiny">近 {data?.range?.points?.length || 14} 期</span>}>
          {loadingCards ? (
            <StateBlock loading rows={3} />
          ) : (
            <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap" }}>
              <span>今日会话 {fmtNum(s?.newSessions)}</span>
              <span>消息 {fmtNum(s?.inflowMessages)}</span>
              <span>已提炼 {fmtNum(s?.extractedSessions)}</span>
              {s?.trend?.length ? <span>趋势点数 {s.trend.length}</span> : null}
              {prod?.total ? <span>产物 {fmtCompact(prod.total)}</span> : null}
            </div>
          )}
        </PanelCard>
        <PanelCard title="实时活动" extra={<Pill tone="ok">实时</Pill>}>
          {loadingCards ? (
            <StateBlock loading rows={4} />
          ) : (
            <ul className="tiny" style={{ paddingLeft: "var(--sp-4)", margin: 0 }}>
              {(data?.recent ?? []).slice(0, 6).map((e: any, i: number) => (
                <li key={i} style={{ marginBottom: "var(--sp-1)" }}>
                  <span style={{ color: "var(--text-3)" }}>{e.time || ""}</span>{" "}
                  <span>{e.title || e.kind || "事件"}</span>
                </li>
              ))}
              {!(data?.recent ?? []).length ? <li style={{ color: "var(--text-3)" }}>暂无最近事件</li> : null}
            </ul>
          )}
        </PanelCard>
      </div>

      {/* 智能体运行矩阵 */}
      <PanelCard
        title="智能体运行矩阵"
        extra={<Link href="/agents-live" className="tiny">全部 →</Link>}
      >
        {loadingCards ? (
          <StateBlock loading rows={2} />
        ) : topAgents.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "var(--sp-3)" }}>
            {topAgents.map((a) => (
              <div key={a.id} style={{ padding: "var(--sp-3)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)" }}>
                <div className="tiny" style={{ color: "var(--text-3)" }}>{a.id}</div>
                <div style={{ fontSize: "var(--fs-2xl)", fontWeight: 600, marginTop: "var(--sp-1)" }}>{fmtNum(a.n)}</div>
              </div>
            ))}
          </div>
        ) : (
          <StateBlock title="近 30 分钟无活跃智能体" rows={1} />
        )}
      </PanelCard>
    </main>
  );
}

export default function WorkbenchPage() {
  const f = useGlobalFilter();
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/overview") + "&_n=" + f.nonce);
  const v2 = useMemo(() => uiV2Enabled(), []);

  // 灰度 OFF → 占位; ON → 完整驾驶舱 (默认 OFF 行为不变, 满足 ui-v2-consumed 验收且不破坏既有路由)
  if (!v2) return <WorkbenchPlaceholder />;
  if (error) {
    return (
      <main className="page">
        <PageHero title="工作台" subtitle="屏 02 · 6 件事驾驶舱" />
        <ErrorBlock message={String(error?.message || "")} onRetry={mutate} />
      </main>
    );
  }
  return <WorkbenchCockpit data={data} loadingCards={loading && !data} />;
}