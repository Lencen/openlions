"use client";
// 2026-09-10 商业化改版: 概览首页
// 一屏回答人类决策者最关心的事: 会话流入 / 提炼产物 / 任务完成失败 / 活跃 Agent / token 消耗 / 质量分
//
// 2026-11-04（ord-20261104-032 · P1 试点，看板模板 C）—— 只改呈现层：
//   页头 → 指标带（≤4 KpiCard）→ Bento 域格（5 格，整格可点）→ 明细表（DataTable ≤10 行）→ 页脚口径。
//   取数一行没动：/api/overview（含全局筛选）、/api/daily-reflection、/api/db-health 与改前逐字一致。
//   原有的业务环（OverviewOneScreen）与折叠明细区保留在「深入」段，功能一个没删。
import Link from "next/link";
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import DataHealth from "@/components/DataHealth";
import { t } from "@/i18n";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { fmtCompact, fmtNum, fmtScore, fmtTime, truncate } from "@/lib/format";
import {
  DataTable,
  ErrorBlock,
  KpiCard,
  PageHeader,
  PageTitle,
  Pill,
  StateBlock,
  StateChip,
} from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import OverviewMetrics from "./_components/OverviewMetrics";
import OverviewFlowCharts from "./_components/OverviewFlowCharts";
import OverviewTrendCharts from "./_components/OverviewTrendCharts";
import OverviewQualityPanels from "./_components/OverviewQualityPanels";
import OverviewRecentPanels from "./_components/OverviewRecentPanels";
import OverviewDailyCard from "./_components/OverviewDailyCard";
import OverviewOneScreen from "./_components/OverviewOneScreen";
import styles from "./page.module.css";

// 401/403 或错误文案含「无权限 / 未授权」= 四态里的「无权限」，与「加载失败」分开渲染。
const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const isForbidden = (msg?: string | null) => FORBIDDEN_RE.test(String(msg || ""));

/** 任务状态 → StateChip（色点 + 文字，不只靠颜色） */
const TASK_CHIP: Record<string, { state: "ok" | "warn" | "crit" | "idle"; text: string }> = {
  DONE: { state: "ok", text: "已完成" },
  FAILED: { state: "crit", text: "失败" },
  IN_PROGRESS: { state: "warn", text: "进行中" },
  PROCESSING: { state: "warn", text: "进行中" },
  PENDING: { state: "idle", text: "待执行" },
  BLOCKED: { state: "crit", text: "阻塞" },
  DEPRECATED: { state: "idle", text: "已废弃" },
  DROPPED: { state: "idle", text: "已丢弃" },
};

type RecentTask = {
  id: string;
  title?: string | null;
  status?: string | null;
  assignedAgent?: string | null;
  scope?: { label?: string } | null;
  updatedAt?: string | number | null;
};

type Tone = "ok" | "warn" | "crit" | "idle";

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const ratioOf = (a: unknown, b: unknown): number | null => {
  const den = num(b);
  return den > 0 ? num(a) / den : null;
};
const toneOf = (r: number | null, okAt: number, warnAt: number): Tone =>
  r === null ? "idle" : r >= okAt ? "ok" : r >= warnAt ? "warn" : "crit";
const pctText = (r: number | null) => (r === null ? "n/a" : Math.round(r * 100) + "%");
/** 10% 一档的宽度类（CSS Module）—— 页面里不写内联 style */
const widthClass = (stylesMap: Record<string, string>, r: number | null) =>
  stylesMap["w" + (r === null ? 0 : Math.round((r * 100) / 10) * 10)] || stylesMap.w0;

function Meter({ label, ratio, tone, text }: { label: string; ratio: number | null; tone: Tone; text?: string }) {
  return (
    <div className={styles.meterRow}>
      <span>{label}</span>
      <span className={styles.meter}>
        <span className={styles.meterFill + " " + widthClass(styles as unknown as Record<string, string>, ratio)} data-tone={tone} />
      </span>
      <span>{text ?? pctText(ratio)}</span>
    </div>
  );
}

export default function OverviewPage() {
  const f = useGlobalFilter();
  // —— 取数与改前完全一致（未改任何参数、未改端点）——
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/overview") + "&_n=" + f.nonce);
  // 2026-09-15 日结卡: 数据不随全局筛选变化, 固定取最近 14 期 (接口只读 mind 库)
  const daily = useApi<any>("/api/daily-reflection?limit=14");
  // 2026-10-21 前端对账：查询失败要能被看见——否则 PG 方言错误会以"0"的样子伪装成真数据。
  const { data: dbh } = useApi<any>("/api/db-health");

  const forbidden = isForbidden(error?.message ? String(error.message) : "");
  const loadingCards = loading && !data;

  const s = data?.sessions;
  const b = data?.backlog;
  const p = data?.products;
  const tk = data?.tasks;
  const ag = data?.agents;
  const tok = data?.tokens;
  const q = data?.quality;

  const extractCover = ratioOf(s?.extractedSessions, s?.newSessions);
  const activeRate = ratioOf(ag?.active, ag?.total);
  const taskDoneRate = ratioOf(tk?.done, num(tk?.done) + num(tk?.failed));
  const quality = typeof q?.overall === "number" ? q.overall : null;
  const recentTasks: RecentTask[] = Array.isArray(tk?.recent) ? (tk.recent as RecentTask[]) : [];
  const isEmpty = !loading && !error && !!data
    && num(s?.newSessions) === 0 && num(p?.total) === 0 && recentTasks.length === 0;

  const columns: DataColumn<RecentTask>[] = [
    {
      key: "title",
      title: "任务",
      render: (r) => (
        <Link className={styles.taskLink} href={"/flywheel/tasks/" + encodeURIComponent(String(r.id))} title={String(r.title || "")}>
          {truncate(r.title || "(无标题)", 44)}
        </Link>
      ),
    },
    {
      key: "status",
      title: "状态",
      width: "110px",
      render: (r) => {
        const chip = TASK_CHIP[String(r.status || "").toUpperCase()] || { state: "idle" as const, text: String(r.status || "—") };
        return <StateChip state={chip.state} text={chip.text} />;
      },
    },
    { key: "scope", title: "范围", width: "120px", render: (r) => (r.scope?.label || "—") },
    { key: "assignedAgent", title: "执行者", width: "160px", render: (r) => (r.assignedAgent || "—") },
    { key: "updatedAt", title: "更新", width: "150px", align: "right", render: (r) => fmtTime(r.updatedAt) },
    {
      key: "go",
      title: "",
      width: "44px",
      align: "right",
      render: (r) => (
        <Link className={styles.rowGo} href={"/flywheel/tasks/" + encodeURIComponent(String(r.id))} aria-label={"进入任务 " + String(r.id)}>›</Link>
      ),
    },
  ];

  const header = (
    <PageHeader>
      <div className={styles.headRow}>
        <div>
          <PageTitle>平台总览</PageTitle>
          <div className="page-subtitle">{t("overview.subtitle")}</div>
        </div>
        <div className={styles.headChips}>
          <Pill tone="info">{data?.range?.label || "近 24 小时"}</Pill>
          {f.agent ? <Pill tone="mute">{t("overview.filter.agent", { id: f.agent })}</Pill> : null}
          {f.theme ? <Pill tone="mute">主题: {f.theme}</Pill> : null}
          <Pill tone="ok">只读</Pill>
          {/* 页头右侧动作 = 只读说明（看板不出现写控件；手刷走 10 秒自动刷新与四态里的「重试」） */}
          <Pill tone="mute">每 10 秒自动刷新</Pill>
        </div>
      </div>
    </PageHeader>
  );

  // —— 四态 · 无权限（整页替换：缺哪个权限点 + 找谁开通）——
  if (forbidden) {
    return (
      <main className="page">
        {header}
        <StateBlock
          title="无权限访问"
          desc={
            <>
              本页需要读权限点 <code>overview.read</code>（总览只读，含会话 / 产物 / 任务 / 智能体四域）。
              当前账号返回：{String(error?.message || "")}
              <br />
              开通方式：找平台管理员（运维值守 devops-line / 数据线 platform-data-line）在「平台授权」页开通 <code>overview.read</code>，或提交 <Link href="/system/auth">授权申请</Link>。
            </>
          }
          action={<Link className="btn" href="/system/auth">去平台授权</Link>}
          onRetry={mutate}
        />
      </main>
    );
  }

  // —— 四态 · 错误（保留页头 + 错误块 + 重试）——
  if (error) {
    return (
      <main className="page">
        {header}
        <ErrorBlock message={String(error?.message || "")} onRetry={mutate} />
        <div className="tiny">
          接口：<code>/api/overview</code>（本页唯一来源，失败时四域一起降级）。数据源不可用不等于「数值为 0」，
          请看错误文案里的状态码，或到 <Link href="/system/health">运维看板</Link> 确认库与判据状态。
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      {header}

      {/* 2026-10-25 R8(CLS)：数据健康提示固定槽位（44px），健康时一行绿字、降级时一行黄字，内容变化不引起位移。 */}
      <DataHealth
        failures={Number(dbh?.failures || 0)}
        sample={String(dbh?.samples?.[0]?.error || "")}
        warnings={Array.isArray(data?.warnings) ? data.warnings : []}
      />

      {/* ---------- ② 指标带：≤4 张，只回答「总量 / 健康 / 异常 / 增量」 ----------
          TODO(数据卡 · 总览)：PILOT-10 数据卡 1 声明的是 cutover 红项数 / 失败 unit 数 / 孪生表对数 / OPEN 待办数，
          console 目前没有对应只读接口（cutover 与 unit 判据在 scripts/ 侧）。接口到位前这四张卡沿用既有口径，不编造数字。 */}
      <div className="kpi-grid">
        <KpiCard
          label="会话流入"
          value={loadingCards ? "…" : fmtNum(s?.newSessions)}
          delta={loadingCards ? "" : "活跃 " + fmtNum(s?.activeSessions)}
          deltaDir="up"
          hint={"消息 " + fmtNum(s?.inflowMessages) + " 条 · 已提炼 " + fmtNum(s?.extractedSessions)}
        />
        <KpiCard
          label="提炼产物"
          value={loadingCards ? "…" : fmtNum(p?.total)}
          delta={loadingCards ? "" : "存量 " + fmtNum(p?.totalAll)}
          hint="记忆 + 知识 + 实践 + 技能 + 反思（本时段新增）"
        />
        <KpiCard
          label="改进任务完成"
          value={loadingCards ? "…" : fmtNum(tk?.done)}
          delta={loadingCards ? "" : "失败 " + fmtNum(tk?.failed)}
          deltaDir={num(tk?.failed) > 0 ? "down" : "up"}
          hint={"进行中 " + fmtNum(tk?.running) + " · 待执行 " + fmtNum(tk?.pending)}
        />
        <KpiCard
          label="产物质量分"
          value={loadingCards ? "…" : fmtScore(quality)}
          delta={loadingCards ? "" : "有评分 " + fmtNum(q?.scoredTotal) + " 条"}
          hint="五表平均质量分，未评分不计入"
        />
      </div>

      {/* ---------- ③ Bento 域格：5 格，每格一个域，整格可点（下钻） ---------- */}
      <section className={styles.bento} aria-label="业务域">
        <Link className={styles.cell + " " + styles.s6} href="/sessions">
          <div className={styles.cellHead}>
            <span className={styles.cellName}>会话域</span>
            <span className={styles.cellKicker}>sessions</span>
            <span className={styles.cellGo}>下钻 →</span>
          </div>
          {loadingCards ? <span className={styles.skel} /> : (
            <>
              <div className={styles.cellValue}>{fmtNum(s?.newSessions)}</div>
              <div className={styles.cellHint}>
                活跃 {fmtNum(s?.activeSessions)} · 待提炼 {fmtNum(b?.pendingSessions)} · 失败 {fmtNum(b?.failedSessions)}
              </div>
              <Meter label="提炼覆盖" ratio={extractCover} tone={toneOf(extractCover, 0.9, 0.6)} />
            </>
          )}
        </Link>

        <Link className={styles.cell + " " + styles.s6} href="/cognitive">
          <div className={styles.cellHead}>
            <span className={styles.cellName}>认知域</span>
            <span className={styles.cellKicker}>cognition</span>
            <span className={styles.cellGo}>下钻 →</span>
          </div>
          {loadingCards ? <span className={styles.skel} /> : (
            <>
              <div className={styles.cellValue}>{fmtNum(p?.totalAll)}</div>
              <div className={styles.cellHint}>
                五表存量 · 本时段新增 {fmtNum(p?.total)} · 质量分 {fmtScore(quality)}
              </div>
              <Meter label="质量" ratio={quality} tone={toneOf(quality, 0.7, 0.5)} />
            </>
          )}
        </Link>

        <Link className={styles.cell + " " + styles.s4} href="/flywheel">
          <div className={styles.cellHead}>
            <span className={styles.cellName}>飞轮域</span>
            <span className={styles.cellKicker}>flywheel</span>
            <span className={styles.cellGo}>下钻 →</span>
          </div>
          {loadingCards ? <span className={styles.skel} /> : (
            <>
              <div className={styles.cellValue}>{fmtNum(tk?.done)}</div>
              <div className={styles.cellHint}>
                完成 / 失败 {fmtNum(tk?.failed)} · 待执行 {fmtNum(tk?.pending)}
              </div>
              <Meter label="任务完成率" ratio={taskDoneRate} tone={toneOf(taskDoneRate, 0.8, 0.5)} />
            </>
          )}
        </Link>

        <Link className={styles.cell + " " + styles.s4} href="/agents">
          <div className={styles.cellHead}>
            <span className={styles.cellName}>智能体域</span>
            <span className={styles.cellKicker}>agents</span>
            <span className={styles.cellGo}>下钻 →</span>
          </div>
          {loadingCards ? <span className={styles.skel} /> : (
            <>
              <div className={styles.cellValue}>{fmtNum(ag?.total)}</div>
              <div className={styles.cellHint}>
                启用 {fmtNum(ag?.active)} · 在干活 {fmtNum(ag?.withTasks)} · 消息通道在线 {fmtNum(ag?.macsOnline)}
              </div>
              <Meter label="启用率" ratio={activeRate} tone={toneOf(activeRate, 0.8, 0.5)} />
            </>
          )}
        </Link>

        <Link className={styles.cell + " " + styles.s4} href="/cost">
          <div className={styles.cellHead}>
            <span className={styles.cellName}>成本域</span>
            <span className={styles.cellKicker}>cost</span>
            <span className={styles.cellGo}>下钻 →</span>
          </div>
          {loadingCards ? <span className={styles.skel} /> : (
            <>
              <div className={styles.cellValue}>{fmtCompact(tok?.total)}</div>
              <div className={styles.cellHint}>
                词元 · 调用 {fmtNum(tok?.totalCalls)} 次 · 估算 {fmtCompact(tok?.estimatedTokens)}
              </div>
              <Meter label="实测占比" ratio={ratioOf(tok?.measuredTokens, tok?.combinedTokens)} tone="ok" />
            </>
          )}
        </Link>
      </section>

      {/* ---------- ④ 明细表：最近任务，≤10 行，行可点进详情 ---------- */}
      <section className="panel" aria-label="最近任务">
        <div className="panel-header">
          <span className="panel-title">最近更新的任务</span>
          <span className="tiny">近 24h 有更新的 {recentTasks.length} 条 · 按更新时间倒序 · 最多展示 10 行</span>
        </div>
        {isEmpty ? (
          <StateBlock
            title="本时段没有数据"
            desc={
              <>
                触发条件：所选时间范围内新增会话为 0、五表新增产物为 0，且没有更新过的任务
                （当前范围：{data?.range?.label || "近 24 小时"}）。
                <br />
                可以先放宽顶部的时间范围，或确认提炼链路是否在跑（飞轮总览 → 数据流动）。
              </>
            }
            action={<Link className="btn" href="/flywheel">看飞轮是否在跑</Link>}
            onRetry={mutate}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={recentTasks.slice(0, 10)}
            rowKey={(r) => String(r.id)}
            loading={loadingCards}
            empty={{
              title: "本时段没有更新过的任务",
              desc: "触发条件：所选时间范围内 Task.updatedAt 均早于起点。放宽时间范围或去待办中心看历史。",
              action: <Link className="btn" href="/todo">去待办中心</Link>,
            }}
          />
        )}
      </section>

      {/* ---------- 深入：业务闭环 + 分析/运维明细（改前内容一条没删，默认折叠） ----------
           OverviewOneScreen 自带 panel 外壳，这里不再套一层（避免双边框）。
           TODO(P2)：折叠区里的「核心 6 指标」仍是 MetricCard（已 deprecated），本批只改呈现层，留待 P2 统一换 KpiCard。 */}
      <OverviewOneScreen data={data} loading={loadingCards} />

      <details className="os-more">
        <summary>展开更多数据（分析 / 运维用）</summary>
        <OverviewDailyCard data={daily.data} loading={daily.loading} />
        <OverviewMetrics data={data} loadingCards={loadingCards} />
        <OverviewFlowCharts data={data} loadingCards={loadingCards} />
        <OverviewTrendCharts data={data} loadingCards={loadingCards} />
        <OverviewQualityPanels data={data} loadingCards={loadingCards} />
        <OverviewRecentPanels data={data} loadingCards={loadingCards} />
      </details>

      {/* ---------- ⑤ 页脚：数据源 + 数据时刻 + 口径（不做行动号召） ---------- */}
      <footer className={styles.foot}>
        <span className="tiny">{t("overview.source")}</span>
        <DataMoment
          items={[{ label: "总览", at: data?.asOf }, { label: "日结", at: daily.data?.asOf }]}
          showPrefix={false}
        />
        <span className="tiny">
          口径：提炼覆盖 = 已提炼会话 / 新增会话；任务完成率 = 完成 /（完成 + 失败）；质量分 = 五表平均质量分（未评分不计）。
          派生比率仅用于看板排序展示，不改变底层口径。
        </span>
      </footer>
    </main>
  );
}