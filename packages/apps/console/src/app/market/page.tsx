"use client";
// 业务看板（/market）—— 看板模板 C。
//
// 2026-11-04（ord-20261104-032 · P1 试点）：只改呈现层。
//   页头 → 指标带（≤4 KpiCard）→ Bento 六域格（每格一个域，整格可点）→ 明细表（服务目录，DataTable ≤10 行）→ 页脚口径。
//   四态：加载（骨架）/ 错误（单域降级 + 错误块，不整页报错）/ 空（本时段无数据 + 域内空态）/ 无权限（整页替换）。
//
// 取数说明（请评审时确认）：
//   ① 本页**原有**的服务目录取数（/api/market/services）逐字保留：同一个 useEffect、同一个 fetch、同样的状态处理。
//   ② 六域看板需要跨域聚合，而 console 现有聚合接口只有 /api/overview（智能体 / 会话 / 飞轮任务 / 认知产物 / 成本）。
//      这里新增两个**只读**调用：/api/overview 与 /api/agent-services（工具域）。两者都是既有端点，
//      **没有新增或修改任何 API 路由、没有改任何既有调用的参数**；聚合接口本身是后端工作
//      （见 docs/design/uiux-bento-2026-11/IMPLEMENTATION-PLAN.md §3 风险表「六域数据源跨 6 个接口」）。
//   ③ 数据卡（PILOT-10 数据卡 2）声明的「派单闭环率 / 送达率 / 验收未覆盖数」在 console 无只读接口，
//      业务域标签也还没入 Todo.meta —— 这些不编造数字，统一在页脚与 TODO 注释里标出来。
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtScore } from "@/lib/format";
import { DataTable, ErrorBlock, KpiCard, PageHeader, PageTitle, Pill, StateBlock, StateChip } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import styles from "./page.module.css";

interface Svc {
  id: string;
  name: string | null;
  version: string | null;
  vendor: string | null;
  pricing: string | null;
  capabilities: number;
  permissions: string[];
  valid: boolean;
  status?: string;
}
const PRICE_LABEL: Record<string, string> = { free: "免费", "one-time": "一次性", subscription: "订阅", metered: "按量" };
const STATUS_LABEL: Record<string, string> = { pending: "待审核", approved: "已通过", rejected: "已驳回" };

type Tone = "ok" | "warn" | "crit" | "idle";

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const isForbidden = (msg?: string | null) => FORBIDDEN_RE.test(String(msg || ""));

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
const WIDTH_CLASS: Record<number, string> = { 0: "w0", 10: "w10", 20: "w20", 30: "w30", 40: "w40", 50: "w50", 60: "w60", 70: "w70", 80: "w80", 90: "w90", 100: "w100" };

/** 域格：整格可点（下钻），一格只讲一个域 */
function Domain({
  href, name, kicker, value, hint, meter, loading, span = "s4",
}: {
  href: string;
  name: string;
  kicker: string;
  value: ReactNode;
  hint: ReactNode;
  meter?: { label: string; ratio: number | null; tone: Tone };
  loading?: boolean;
  /** Bento 跨度：不等宽是模板要求（4/6/12 混排） */
  span?: "s4" | "s6" | "s12";
}) {
  return (
    <Link className={styles.cell + " " + styles[span]} href={href}>
      <div className={styles.cellHead}>
        <span className={styles.cellName}>{name}</span>
        <span className={styles.cellKicker}>{kicker}</span>
        <span className={styles.cellGo}>{href === "#catalog" ? "看目录 ↓" : "下钻 →"}</span>
      </div>
      {loading ? (
        <span className={styles.skel} />
      ) : (
        <>
          <div className={styles.cellValue}>{value}</div>
          <div className={styles.cellHint}>{hint}</div>
          {meter ? (
            <div className={styles.meterRow}>
              <span>{meter.label}</span>
              <span className={styles.meter}>
                <span
                  className={styles.meterFill + " " + (styles[WIDTH_CLASS[meter.ratio === null ? 0 : Math.round((meter.ratio * 100) / 10) * 10]] || styles.w0)}
                  data-tone={meter.tone}
                />
              </span>
              <span>{pctText(meter.ratio)}</span>
            </div>
          ) : null}
        </>
      )}
    </Link>
  );
}

export default function MarketPage() {
  // ① 业务域聚合（只读，既有端点）。聚合口径是「5 分钟聚合」，轮询按 5 分钟，不打重查询。
  const { data: ovd, loading: ovLoading, error: ovError, mutate: ovMutate } = useApi<any>("/api/overview", { pollMs: 300000 });
  // ② 工具域：业务服务目录（只读，既有端点）
  const { data: toolRaw, error: toolError, mutate: toolMutate } = useApi<any>("/api/agent-services", { pollMs: 300000 });

  // ③ 服务目录 —— 逐字保留改前的取数逻辑（同一个 fetch / 同一个 URL / 同样的错误处理），只多了一个加载标记用于四态。
  const [list, setList] = useState<Svc[]>([]);
  const [msg, setMsg] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  useEffect(() => {
    fetch("/api/market/services").then((r) => r.json()).then((j: { services?: Svc[]; error?: string }) => {
      setList(j.services || []);
      if (j.error) setMsg(j.error);
    }).catch(() => setMsg("读取失败")).finally(() => setCatalogLoading(false));
  }, []);

  const s = ovd?.sessions;
  const b = ovd?.backlog;
  const p = ovd?.products;
  const tk = ovd?.tasks;
  const ag = ovd?.agents;
  const q = ovd?.quality;
  const svcs: Svc[] = Array.isArray(list) ? list : [];
  const tools = Array.isArray(toolRaw) ? (toolRaw as any[]) : [];

  const ovErr = ovError ? String((ovError as Error)?.message || ovError) : "";
  const toolErr = toolError ? String((toolError as Error)?.message || toolError) : "";
  const forbidden = isForbidden(ovErr) || isForbidden(toolErr) || isForbidden(msg);
  const failedSources = [
    ovErr ? "/api/overview（智能体 / 会话 / 飞轮 / 数据域）" : "",
    toolErr ? "/api/agent-services（工具域）" : "",
    msg ? "/api/market/services（服务目录）" : "",
  ].filter(Boolean);

  const quality = typeof q?.overall === "number" ? q.overall : null;
  const activeRate = ratioOf(ag?.active, ag?.total);
  const extractCover = ratioOf(s?.extractedSessions, s?.newSessions);
  const taskDoneRate = ratioOf(tk?.done, num(tk?.done) + num(tk?.failed));
  const validRate = svcs.length ? svcs.filter((x) => x.valid).length / svcs.length : null;
  const toolCount = toolRaw === undefined ? null : tools.length;
  const allEmpty = !ovLoading && !ovErr && !catalogLoading && !svcs.length && num(p?.totalAll) === 0;

  const header = (
    <PageHeader>
      <div className={styles.headRow}>
        <div>
          <PageTitle>业务看板</PageTitle>
          <div className="page-subtitle">
            聚合六域（智能体 / 会话 / 飞轮 / 数据 / 工具 / 服务）：有多少、涨没涨、哪个域异常。运维视角请看
            <Link href="/system/health">运维看板</Link>。
          </div>
        </div>
        <div className={styles.headChips}>
          <Pill tone="info">看板</Pill>
          <Pill tone="ok">只读</Pill>
          <Pill tone="mute">5 分钟聚合</Pill>
          {/* 页头右侧动作 = 只读说明（看板不出现写控件；重试在错误块里） */}
        </div>
      </div>
    </PageHeader>
  );

  // —— 四态 · 无权限（整页替换：说明缺哪个权限 + 找谁开通）——
  if (forbidden) {
    return (
      <main className="page">
        {header}
        <StateBlock
          title="无权限访问"
          desc={
            <>
              业务看板只读，但仍需要读权限点 <code>overview.read</code>（业务域聚合）与 <code>service.read</code>（服务目录）。
              当前返回：{ovErr || toolErr || msg}
              <br />
              开通方式：找平台管理员（运维值守 devops-line）在「平台授权」页开通上述权限点，或提交
              <Link href="/system/auth">授权申请</Link>。
            </>
          }
          action={<Link className="btn" href="/system/auth">去平台授权</Link>}
          onRetry={() => { ovMutate(); toolMutate(); }}
        />
      </main>
    );
  }

  const catalogColumns: DataColumn<Svc>[] = [
    {
      key: "name",
      title: "服务",
      render: (r) => (
        <>
          <span className={styles.svcName}>{r.name || r.id}</span>
          <span className={styles.svcSub}>{r.vendor || "—"} · {r.id}</span>
        </>
      ),
    },
    { key: "version", title: "版本", width: "90px", render: (r) => (r.version ? "v" + r.version : "—") },
    { key: "pricing", title: "定价", width: "100px", render: (r) => PRICE_LABEL[String(r.pricing)] || r.pricing || "—" },
    { key: "capabilities", title: "能力", width: "80px", align: "right", render: (r) => fmtNum(r.capabilities) },
    {
      key: "permissions",
      title: "权限",
      render: (r) => <span className="tiny">{(r.permissions || []).join(" / ") || "无"}</span>,
    },
    {
      key: "status",
      title: "审核",
      width: "120px",
      render: (r) => {
        const st = String(r.status || "").toLowerCase();
        if (st === "rejected") return <StateChip state="crit" text="已驳回" />;
        if (!st || st === "pending") return <StateChip state="warn" text={STATUS_LABEL.pending} />;
        return r.valid ? <StateChip state="ok" text={STATUS_LABEL.approved} /> : <StateChip state="crit" text="契约未通过" />;
      },
    },
  ];

  return (
    <main className="page">
      {header}

      {/* ---------- ② 指标带：≤4 张（规模 / 健康 / 异常 / 增量） ----------
          TODO(数据卡 · 业务看板)：数据卡 2 要求「近 7 日完成数 / 派单闭环率 / 派单送达率 / 验收未覆盖数」，
          对应接口与业务域标签（Todo.meta）都还没到位（平台线 11-07 前补）。到位前这里用六域可算的同口径指标顶上。 */}
      <div className="kpi-grid">
        <KpiCard
          label="域规模"
          value={ovLoading ? "…" : fmtNum(p?.totalAll)}
          hint="6 域 · 五表认知资产存量"
        />
        <KpiCard
          label="数据健康"
          value={ovLoading ? "…" : quality === null ? "—" : Math.round(quality * 100) + "%"}
          delta={ovLoading ? "" : "质量分 " + fmtScore(quality)}
          hint="五表平均质量分，未评分不计"
        />
        <KpiCard
          label="异常"
          value={ovLoading ? "…" : fmtNum(tk?.failed)}
          delta={ovLoading ? "" : "失败会话 " + fmtNum(b?.failedSessions)}
          deltaDir={num(tk?.failed) > 0 ? "down" : "up"}
          hint="值为失败任务数 · delta 为提炼失败会话"
        />
        <KpiCard
          label="近窗增量"
          value={ovLoading ? "…" : fmtNum(p?.total)}
          delta={ovLoading ? "" : "会话流入 " + fmtNum(s?.newSessions)}
          deltaDir="up"
          hint="本时段新增产物数量"
        />
      </div>

      {/* 错误：单域降级 —— 哪个域失败标哪个域，同时给一个可重试的错误块，不整页报错 */}
      {failedSources.length > 0 && !forbidden ? (
        <ErrorBlock
          message={"以下数据源读取失败，相关域已降级显示「该域不可用」：" + failedSources.join("；") + "。" + (ovErr || toolErr || msg)}
          onRetry={() => { ovMutate(); toolMutate(); }}
        />
      ) : null}

      {allEmpty ? (
        <StateBlock
          title="六域本时段都没有数据"
          desc={
            <>
              触发条件：所选时间范围内新增会话 / 新增产物 / 任务均为 0，且服务目录为空。
              <br />
              先确认提炼链路（<Link href="/flywheel">飞轮</Link>）与接入（<Link href="/agents/onboard">接入向导</Link>）是否在跑；
              服务目录为空时请看 <Link href="/system/api">服务注册</Link>。
            </>
          }
          onRetry={() => { ovMutate(); }}
        />
      ) : null}

      {/* ---------- ③ Bento 六域格：每格一个域，整格可点 ---------- */}
      <section className={styles.bento} aria-label="业务六域">
        <Domain
          href="/agents"
          name="智能体域"
          kicker="agents"
          span="s6"
          loading={ovLoading && !ovd}
          value={fmtNum(ag?.total)}
          hint={ovErr ? "该域不可用（/api/overview）" : "启用 " + fmtNum(ag?.active) + " · 在干活 " + fmtNum(ag?.withTasks) + " · 消息通道在线 " + fmtNum(ag?.macsOnline)}
          meter={{ label: "启用率", ratio: activeRate, tone: toneOf(activeRate, 0.8, 0.5) }}
        />
        <Domain
          href="/sessions"
          name="会话域"
          kicker="sessions"
          span="s6"
          loading={ovLoading && !ovd}
          value={fmtNum(s?.newSessions)}
          hint={ovErr ? "该域不可用（/api/overview）" : "活跃 " + fmtNum(s?.activeSessions) + " · 待提炼 " + fmtNum(b?.pendingSessions) + " · 失败 " + fmtNum(b?.failedSessions)}
          meter={{ label: "提炼覆盖", ratio: extractCover, tone: toneOf(extractCover, 0.9, 0.6) }}
        />
        <Domain
          href="/flywheel"
          name="飞轮域"
          kicker="flywheel"
          loading={ovLoading && !ovd}
          value={fmtNum(p?.total)}
          hint={ovErr ? "该域不可用（/api/overview）" : "任务完成 " + fmtNum(tk?.done) + " · 失败 " + fmtNum(tk?.failed) + " · 待执行 " + fmtNum(tk?.pending)}
          meter={{ label: "任务完成率", ratio: taskDoneRate, tone: toneOf(taskDoneRate, 0.8, 0.5) }}
        />
        <Domain
          href="/cognitive"
          name="数据域"
          kicker="cognition"
          loading={ovLoading && !ovd}
          value={fmtNum(p?.totalAll)}
          hint={ovErr ? "该域不可用（/api/overview）" : "五表存量 · 质量分 " + fmtScore(quality) + " · 有评分 " + fmtNum(q?.scoredTotal) + " 条"}
          meter={{ label: "质量", ratio: quality, tone: toneOf(quality, 0.7, 0.5) }}
        />
        <Domain
          href="/system/business"
          name="工具域"
          kicker="tools / services"
          value={toolCount === null ? "—" : fmtNum(toolCount)}
          hint={toolErr ? "该域不可用（/api/agent-services）" : "已登记业务服务（AgentService）· 授权矩阵见 /system/business"}
        />
        <Domain
          href="#catalog"
          name="服务域"
          kicker="market"
          span="s12"
          value={catalogLoading ? "…" : fmtNum(svcs.length)}
          hint={msg ? "该域不可用（/api/market/services）" : "已收录 " + fmtNum(svcs.length) + " 个 · 契约通过 " + fmtNum(svcs.filter((x) => x.valid).length) + " · 待审 " + fmtNum(svcs.filter((x) => !x.status || String(x.status) === "pending").length)}
          meter={{ label: "契约通过", ratio: validRate, tone: toneOf(validRate, 0.9, 0.6) }}
        />
      </section>

      {/* ---------- ④ 明细表：服务目录（≤10 行；服务域的下钻落点） ---------- */}
      <section className="panel" id="catalog" aria-label="服务目录">
        <div className="panel-header">
          <span className="panel-title">服务目录（服务域明细）</span>
          <span className="tiny">共 {svcs.length} 条 · 只展示前 10 行 · 来源 /api/market/services</span>
        </div>
        <DataTable
          columns={catalogColumns}
          rows={svcs.slice(0, 10)}
          rowKey={(r) => String(r.id)}
          loading={catalogLoading}
          error={msg || null}
          empty={{
            title: "暂无已收录服务",
            desc: "触发条件：services/index.json 为空，或 /api/market/services 未返回 services 数组。审核通过后才会出现在这里。",
            action: <Link className="btn" href="/system/api">看服务注册</Link>,
          }}
        />
        <div className="tiny">
          口径：只读目录 · 安装 / 结算在后续版本开放 · 行内无写操作（审核状态由平台侧维护）。
        </div>
      </section>

      {/* ---------- ⑤ 页脚：数据源 + 各源数据时刻 + 口径 ---------- */}
      <footer className={styles.foot}>
        <span className="tiny">
          数据源：/api/overview（六域聚合）· /api/agent-services（工具域）· /api/market/services（服务目录）· 只读 · 5 分钟聚合
        </span>
        {/* 逐源时刻：业务域有 asOf；服务目录接口没有时刻字段，这里不借别人的时刻（显式写在下一行文字里） */}
        <DataMoment items={[{ label: "业务域", at: ovd?.asOf }]} showPrefix={false} />
        <span className="tiny">服务目录：/api/market/services 未返回数据时刻</span>
        <span className="tiny">
          口径：派生比率（启用率 / 提炼覆盖 / 任务完成率 / 质量 / 契约通过）仅用于看板排序展示，不改变底层口径。
          派单闭环率、送达率、验收未覆盖数暂无只读接口 —— 数据卡到位前不显示，也不写 0。
        </span>
      </footer>
    </main>
  );
}