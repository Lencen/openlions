"use client";
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useApi } from "@/lib/api";
import Link from "next/link";
import { Alert } from "@/components/primitives";
import { toHourly } from "./_components/shared";
import type { DashboardData } from "./_components/shared";
import FlywheelHeader, { FlywheelLoading } from "./_components/FlywheelHeader";
import FlywheelHealthPanel from "./_components/FlywheelHealthPanel";
import FlywheelImprovementPanel from "./_components/FlywheelImprovementPanel";
import FlywheelFlow from "./_components/FlywheelFlow";
import FlywheelTrends from "./_components/FlywheelTrends";
import FlywheelKpis from "./_components/FlywheelKpis";
import FlywheelDistribution from "./_components/FlywheelDistribution";
import FlywheelQualityGrid from "./_components/FlywheelQualityGrid";
import FlywheelReference from "./_components/FlywheelReference";
import FlywheelLogs from "./_components/FlywheelLogs";
import ErrorAlert from "@/components/ErrorAlert";
import { fmtTime } from "@/lib/format";
import DataMoment from "@/components/DataMoment";

export default function FlywheelOverviewPage() {
  // 2026-10-13 (round 75-G): 原来 error 没接 -> /api/flywheel-dashboard 失败时 d 恒为 undefined,
  //   而下面的守卫 `loading || !d` 会把页面**永远停在 <FlywheelLoading/>**(失败伪装成加载中)。
  const { data: d, loading, error, mutate } = useApi<DashboardData>("/api/flywheel-dashboard");
  const { data: health } = useApi<any>("/api/flywheel-health");

  if (loading || !d) {
    if (error) return (<div className="layout-with-sidebar"><main className="main"><ErrorAlert title="飞轮看板加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /></main></div>);
    return <FlywheelLoading />;
  }

  const totalActive = d.tableStats.reduce((s, t) => s + t.active, 0);
  const totalH1 = d.tableStats.reduce((s, t) => s + t.h1, 0);
  // R3 口径统一：体检文案里的"近 24h 认知写入"用的是 health.five24h，
  //   两处曾出现 3,295 vs 3,297 的差（两个接口取数时刻不同）。这里让页首 hero 与文案同源。
  const healthSum = health && (health as any).five24h
    ? Object.values((health as any).five24h as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;
  const totalH24 = healthSum || d.tableStats.reduce((s, t) => s + t.h24, 0);
  // 2026-10-21：PG 的 COUNT 是 bigint 字符串，直接相加会变 "0"+"13"="013"；统一转数字。
  const totalErrors = d.errors.reduce((s: number, e: any) => s + (Number(e.cnt) || 0), 0);
  const llmTotal = d.llmStats?.total24h ?? 0;
  const llmOkRate = llmTotal > 0 ? Math.round((d.llmStats.ok24h / llmTotal) * 100) : 0;
  const lastTs = d.lastTick ? new Date(d.lastTick.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "-";
  const hasRecentActivity = d.recentEvents.length > 0;
  const nowMs = Date.now();
  const writes24 = toHourly(d.trend?.writes, nowMs);
  const events24 = toHourly(d.trend?.events, nowMs);
  const errors24 = toHourly(d.trend?.errors, nowMs);
  const writesSum = writes24.reduce((a: number, b: number) => a + b, 0);
  const maxActive = Math.max(...d.tableStats.map(t => t.active), 1);
  // 2026-10-13 round 76-AM: 看板数据为空(表统计全 0、无近期事件/错误)时, 之前只渲染出标题(实测 main 仅 4 字)。
  //   这里补一个明确空态, 避免用户以为"页面坏了"。
  const isEmptyDashboard = !d.tableStats.some((t) => t.active || t.h1 || t.h24) && d.recentEvents.length === 0 && d.errors.length === 0;

  return (
    <div className="layout-with-sidebar">
      
      <main className="main">
        <FlywheelHeader totalActive={totalActive} totalH1={totalH1} totalH24={totalH24} totalErrors={totalErrors} />
        {/* 2026-10-15（round 76-GD, 规范铁律 2）：**区分两个不同的时间** ——
            下面「最后活动」说的是"飞轮还在动"; 这里「数据时刻」说的是"我看到的是什么时候的数据"。
            两者相关但不同, 之前这一页只有前者, 用户无法判断"这份读数有多旧"。 */}
        {/* 2026-10-16（round 77-O, 决策③逐源 + 77-M 机检清单）: 本页有 **2 个数据源** ——
    /api/flywheel-dashboard（看板数字）与 /api/flywheel-health（健康面板的 24h 数字）。
    此前这里只显示**看板的** timestamp ✗ -> 健康面板的数字戴着看板的时刻（又一次"借时刻"）。
    实测两源**各自都有**时刻（看板 timestamp / 健康 ts），故**无需改 BFF**，纯页面改动 ✓。
    注意与相邻的「最后活动」区分: 那是"飞轮最近一次动"（lastTick），这里才是"数据是什么时候的" ✓。 */}
{d.timestamp || health?.ts ? <div className="tiny" style={{ textAlign: "right", color: "var(--text-dim)", padding: "0 var(--sp-1) var(--sp-2)" }}>
  <DataMoment items={[{ label: "看板", at: d.timestamp }, { label: "健康", at: health?.ts }]} style={{ marginLeft: 0 }} />
</div> : null}

        {/* 2026-10-21 一致性：空态也用"容器 20"（原 sp-6=24 是全站唯一一个 24 的内边距） */}
        {isEmptyDashboard && (
          <div className="panel" style={{ padding: "var(--sp-5)", marginBottom: "var(--sp-4)", color: "var(--text-muted)" }}>
            暂无飞轮数据 —— 当前时间范围内没有写入 / 事件 / 错误记录。可切换上方更大时间范围, 或稍后刷新。
          </div>
        )}

        <FlywheelKpis
          totalActive={totalActive}
          totalH24={totalH24}
          totalH1={totalH1}
          tableStats={d.tableStats}
          reflectionStats={d.reflectionStats}
          totalErrors={totalErrors}
          trendEvents={(d.trend?.events || []).map((x: any) => Number(x.c) || 0)}
        />
        <FlywheelHealthPanel health={health} />

        <FlywheelFlow recentEvents={d.recentEvents} lastTs={lastTs} hasRecentActivity={hasRecentActivity} />

        {/* 2026-10-23：第⑥段「改进行动」执行明细（后端定：走 /flywheel，不单独开页面） */}
        <FlywheelImprovementPanel />

        <FlywheelTrends
          writes24={writes24}
          events24={events24}
          errors24={errors24}
          writesSum={writesSum}
          totalH24={totalH24}
          totalErrors={totalErrors}
          actionStats={d.actionStats}
        />


        <FlywheelDistribution
          tableStats={d.tableStats}
          themes={d.themes}
          totalActive={totalActive}
          maxActive={maxActive}
        />

        <FlywheelQualityGrid d={d} llmTotal={llmTotal} llmOkRate={llmOkRate} totalErrors={totalErrors} />

        <FlywheelReference qualityDims={d.qualityDims} cronSchedule={d.cronSchedule} logInfo={d.logInfo} />

        <FlywheelLogs recentLogEntries={d.recentLogEntries} />

        <div style={{ textAlign: "right", fontSize: "var(--fs-sm)", color: "var(--text-muted)", marginTop: "var(--sp-2)" }}>
          数据更新: {new Date(d.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · 每 10 秒自动刷新
        </div>
        {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
        <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
          <span>相关视图：</span>
          <Link href="/flywheel/tasks">改进任务 →</Link>
          <Link href="/system/pipeline">流水线监控 →</Link>
        </div>
      </main>
    </div>
  );
}