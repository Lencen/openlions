"use client";
// 飞轮结构看板（/flywheel）—— 看板模板 C。
//
// 2026-11-04（ord-20261104-032 · P1 试点）：只改呈现层，取数一行没动
//   （仍是 /api/flywheel-dashboard + /api/flywheel-health 两个既有调用；子组件各自的调用也没改）。
//   区块顺序按 TEMPLATES.md §3：页头 → 指标带（≤4）→ Bento 域格（= 飞轮六段）→ 明细表（断点列表）→ 页脚口径。
//   改前的深度区块（数据流动 / 趋势 / 分布 / 质量 / 参考 / 日志 / 改进行动）全部保留在「深入」段。
import Link from "next/link";
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import { fmtTime } from "@/lib/format";
import { DataTable, ErrorBlock, PageHeader, PageTitle, Pill, StateBlock, StateChip } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import { toHourly } from "./_components/shared";
import type { DashboardData } from "./_components/shared";
import FlywheelKpis from "./_components/FlywheelKpis";
import FlywheelStages from "./_components/FlywheelStages";
import FlywheelHealthPanel from "./_components/FlywheelHealthPanel";
import FlywheelImprovementPanel from "./_components/FlywheelImprovementPanel";
import FlywheelFlow from "./_components/FlywheelFlow";
import FlywheelTrends from "./_components/FlywheelTrends";
import FlywheelDistribution from "./_components/FlywheelDistribution";
import FlywheelQualityGrid from "./_components/FlywheelQualityGrid";
import FlywheelReference from "./_components/FlywheelReference";
import FlywheelLogs from "./_components/FlywheelLogs";
import styles from "./page.module.css";

// 401/403 或错误文案含「无权限 / 未授权」= 四态里的「无权限」。
const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const isForbidden = (msg?: string | null) => FORBIDDEN_RE.test(String(msg || ""));

type Finding = { level: string; text: string };

const LEVEL: Record<string, { state: "ok" | "warn" | "crit"; label: string }> = {
  crit: { state: "crit", label: "P1" },
  warn: { state: "warn", label: "P2" },
  ok: { state: "ok", label: "正常" },
};

export default function FlywheelOverviewPage() {
  // 2026-10-13 (round 75-G): 原来 error 没接 -> /api/flywheel-dashboard 失败时 d 恒为 undefined,
  //   而下面的守卫 `loading || !d` 会把页面**永远停在加载态**(失败伪装成加载中)。
  // 取数未改动。
  const { data: d, loading, error, mutate } = useApi<DashboardData>("/api/flywheel-dashboard");
  const { data: health, loading: healthLoading, error: healthError } = useApi<any>("/api/flywheel-health");

  const forbidden = isForbidden((error as Error)?.message ? String((error as Error).message) : "");

  const header = (
    <PageHeader>
      <div className={styles.headRow}>
        <div>
          <PageTitle>飞轮总览</PageTitle>
          <div className="page-subtitle">
            六段闭环：扫描 → 提取 → 写入 → 生成任务 → 反思 → 结构化。看它转不转、哪一段卡住、断点谁去修。
          </div>
        </div>
        <div className={styles.headChips}>
          <Pill tone="info">看板</Pill>
          <Pill tone="ok">只读</Pill>
          <Pill tone="mute">每 10 秒自动刷新</Pill>
        </div>
      </div>
    </PageHeader>
  );

  // —— 四态 · 无权限（整页替换）——
  if (forbidden) {
    return (
      <main className="page">
        {header}
        <StateBlock
          title="无权限访问"
          desc={
            <>
              飞轮看板虽然只读，但仍需要读权限点 <code>flywheel.read</code>（含看板快照与健康体检）。
              当前账号返回：{String((error as Error)?.message || "")}
              <br />
              开通方式：找平台管理员（运维值守 devops-line / 数据线 platform-data-line）在「平台授权」页开通
              <code> flywheel.read</code>，或提交 <Link href="/system/auth">授权申请</Link>。
            </>
          }
          action={<Link className="btn" href="/system/auth">去平台授权</Link>}
          onRetry={mutate}
        />
      </main>
    );
  }

  // —— 四态 · 错误（保留页头 + 错误块 + 重试；不整页白屏）——
  if (error && !d) {
    return (
      <main className="page">
        {header}
        <ErrorBlock message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} />
        <div className="tiny">
          接口：<code>/api/flywheel-dashboard</code>。失败不等于「飞轮没数据」—— 看错误里的状态码，
          或到 <Link href="/system/health">运维看板</Link> 确认库与判据状态。
        </div>
      </main>
    );
  }

  // —— 四态 · 加载（保留栅格：指标带骨架 + 六段骨架）——
  if (loading || !d) {
    return (
      <main className="page">
        {header}
        <StateBlock loading rows={4} />
        <FlywheelStages />
      </main>
    );
  }

  const totalActive = d.tableStats.reduce((s, t) => s + t.active, 0);
  const totalH1 = d.tableStats.reduce((s, t) => s + t.h1, 0);
  // R3 口径统一：体检文案里的"近 24h 认知写入"用的是 health.five24h，
  //   两处曾出现 3,295 vs 3,297 的差（两个接口取数时刻不同）。这里让页首 KPI 与文案同源。
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
  // 2026-10-13 round 76-AM：看板数据为空（表统计全 0、无近期事件/错误）时补明确空态，
  //   避免用户以为页面坏了。2026-11-04 起空态用 StateBlock，并写清触发条件与首次执行时间。
  const isEmptyDashboard = !d.tableStats.some((t) => t.active || t.h1 || t.h24) && d.recentEvents.length === 0 && d.errors.length === 0;

  const findings: Finding[] = Array.isArray(health?.verdict) ? (health.verdict as Finding[]) : [];
  const breaks = findings.filter((f) => f.level === "crit" || f.level === "warn").slice(0, 10);

  const breakColumns: DataColumn<Finding>[] = [
    {
      key: "level",
      title: "级别",
      width: "96px",
      render: (f) => {
        const lv = LEVEL[String(f.level)] || LEVEL.ok;
        return <StateChip state={lv.state} text={lv.label} />;
      },
    },
    { key: "text", title: "断点", render: (f) => String(f.text || "—") },
    {
      key: "owner",
      title: "责任线",
      width: "180px",
      // TODO(数据卡 · 飞轮)：健康体检没有「责任线」字段（PILOT-10 要求 P1/P2 + 责任线），
      //   接口补齐前显式写「未标注」，不用人名/线名去猜。
      render: () => <span className="tiny">未标注（待数据卡）</span>,
    },
    {
      key: "go",
      title: "",
      width: "44px",
      align: "right",
      render: () => <Link className={styles.rowGo} href="/flywheel/flow" aria-label="进入流水线">›</Link>,
    },
  ];

  return (
    <main className="page">
      {header}

      {/* ---------- ② 指标带：4 张（24h 新增 / 存量 / 反思聚合 / 24h 错误） ---------- */}
      <FlywheelKpis
        totalActive={totalActive}
        totalH24={totalH24}
        totalH1={totalH1}
        tableStats={d.tableStats}
        reflectionStats={d.reflectionStats}
        totalErrors={totalErrors}
        trendEvents={(d.trend?.events || []).map((x: any) => Number(x.c) || 0)}
      />

      {/* 空态：指标归零也照常展示，这里只补一句「为什么是 0」（看板模板 C 的空态规则）。 */}
      {isEmptyDashboard ? (
        <StateBlock
          title="暂无飞轮数据 —— 本时段没有写入 / 事件 / 错误"
          desc={
            <>
              触发条件：五表（记忆 / 知识 / 实践 / 技能 / 反思）存量与近 24h 新增均为 0，且近 5 分钟没有飞轮事件、没有错误。
              <br />
              首次执行由定时任务触发（每 30 分钟扫描、提炼、写入）、
              <code>:05 reflectWorker</code>、<code>:15 improving-tasks</code>、<code>:25 structuredCron</code>。
              若超过 30 分钟仍全 0，先看 <Link href="/flywheel/logs">飞轮日志</Link> 是否在跑。
            </>
          }
          action={<Link className="btn" href="/flywheel/flow">看数据流动</Link>}
          onRetry={mutate}
        />
      ) : null}

      {/* ---------- ③ Bento 域格：六段步骤条（段名 / 数值 / 说明），整格可点 ---------- */}
      <FlywheelStages />

      {/* ---------- ④ 明细表：断点列表（P1/P2 + 责任线），≤10 行 ---------- */}
      <section className="panel" aria-label="断点列表">
        <div className="panel-header">
          <span className="panel-title">断点列表</span>
          <span className="tiny">来自 /api/flywheel-health 的体检结论 · crit 记 P1 / warn 记 P2 · 最多 10 条</span>
        </div>
        <DataTable
          columns={breakColumns}
          rows={breaks}
          rowKey={(f, i) => f.level + "-" + i}
          loading={healthLoading && !health}
          error={healthError ? String((healthError as Error)?.message || healthError) : null}
          empty={{
            title: "未发现断点",
            desc: "触发条件：/api/flywheel-health 的 verdict 里没有 crit/warn 项（当前体检结论为全绿）。体检每小时更新，可稍后再看。",
          }}
        />
        <div className="tiny">
          口径：P1 = 体检判 crit（如执行器长时间停摆、近 24h 产物近乎为 0）；P2 = 判 warn（如任务堆积、执行近 1 天无活动）。
          级别由体检结论映射，不额外打分。
        </div>
      </section>

      {/* ---------- 深入：改前的全部区块（一条没删，顺序微调为先总后细） ---------- */}
      {/* 体检结论自带 panel 外壳，这里不再套一层，避免双边框 */}
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

      {/* ---------- ⑤ 页脚：数据源 + 数据时刻 + 刷新频率 + 口径（不做行动号召） ---------- */}
      <footer className={styles.foot}>
        <span className="tiny">
          数据更新 {d.timestamp ? fmtTime(d.timestamp) : "—"} · 每 10 秒自动刷新 · 最后活动 {lastTs}
        </span>
        <DataMoment items={[{ label: "看板", at: d.timestamp }, { label: "健康", at: health?.ts }]} showPrefix={false} />
        <span className="tiny">
          口径：近 24h 新增认知 = health.five24h 五表合计（与体检面板同源）；六段数值 = 该段最近 5 分钟经过的事件条数；
          近 1h / 24h 为同口径累计；「存量」= 五表全量。段级覆盖率口径待数据卡（当前显示 —）。
        </span>
      </footer>

      {/* 2026-10-19 B5(收尾)：修前正文 0 出链；补「相关视图」（每条指向真实相关页）*/}
      <div className={styles.linkRow}>
        <span>相关视图：</span>
        <Link href="/flywheel/tasks">改进任务 →</Link>
        <Link href="/system/pipeline">流水线监控 →</Link>
        <Link href="/flywheel/coverage">覆盖率 →</Link>
      </div>
    </main>
  );
}