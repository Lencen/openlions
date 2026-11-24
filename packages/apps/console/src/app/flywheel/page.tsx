"use client";

// /flywheel — 0.5 批次B · demo slot 还原（2026-11-13）
// slots：s12｜六段闭环（KPI/摘要）· s8｜各段覆盖率（KPI/摘要）· s4｜断点（列表）· s12｜最近执行（表格）
// 页首另有 4 项指标带（数据卡 9）：提炼失败率 / 认知链 24h 新增 / 飞轮积压 / 六段覆盖率（口径未定义 → n/a + 原因）
// 取数（均既有只读端点）：/api/flywheel/card9、/api/flywheel-health、/api/flywheel-dashboard、/api/flywheel-flow
// 口径纪律：取不到一律 n/a + 原因，不写 0；窗口计数全 0 但无口径时按不可得处理（见数据卡 G-2）。
import { useCallback, useEffect, useState } from "react";
import DataMoment from "@/components/DataMoment";
// 0.6.1 U-39：13 个二级入口下沉到父页「功能入口」带（侧栏不再有二级菜单）
import FeatureEntries from "@/components/FeatureEntries";
import { NAV_GROUPS } from "@/config/nav";
import { useRouter } from "next/navigation";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable" | "empty";

interface Check {
  id: string;
  label?: string;
  threshold?: string;
  value?: string | null;
  valueNum?: number | null;
  extra?: { lastActiveHours?: number; attempts?: number };
  state?: string;
  reason?: string;
}
interface Card9 { asOf?: string; status?: string; checks?: Check[]; reason?: string; }
interface Verdict { level?: string; text?: string; }
interface Health { asOf?: string; verdict?: Verdict[]; }
interface EventRow { stage?: string; sourceType?: string; cnt?: number | string; }
interface Dash { recentEvents?: EventRow[]; lastTick?: { createdAt?: string } | null; timestamp?: string; }
interface Step { id?: string; label?: string; qty?: { m5?: number; m15?: number; h1?: number; h24?: number }; }
interface Flow { ok?: boolean; steps?: Step[]; timestamp?: string; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const STATE_TEXT: Record<string, string> = { pass: "阈值内", fail: "越线", na: "不可判" };

export default function FlywheelPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [c9, setC9] = useState<Card9 | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [dash, setDash] = useState<Dash | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);
  // 0.6.4 U-56b B-02：飞轮事件吞吐 30 天趋势（[team] 06:43 契约：UTC 自然日、缺日不补 0）
  const [trendF, setTrendF] = useState<Array<{ day: string; n: number }> | null>(null);
  const [trendFReason, setTrendFReason] = useState("");

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({}); setC9(null); setHealth(null); setDash(null); setFlow(null);
    // 0.6.4 U-56b B-01（设计 判据⑦）：?state=empty|error|unavailable 强制复现四态（复用既有渲染块）
    const forced = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("state") : null;
    if (forced === "empty" || forced === "error" || forced === "unavailable") {
      setErr("（复现模式：?state=" + forced + "）");
      setPhase(forced as "empty" | "error" | "unavailable");
      return;
    }
    // 趋势独立取数：失败/无数据都保留 na + 原因（设计 判据⑤：不得画空线、不得假 0 线）
    fetch("/api/flywheel/assets/trend?asset=flywheel_event&days=30", { cache: "no-store" })
      .then((x) => (x.ok ? x.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        if (Array.isArray(j.trend) && j.trend.length > 0) { setTrendF(j.trend); setTrendFReason(""); }
        else { setTrendF(null); setTrendFReason(String(j.reason || "30 天趋势未采集")); }
      })
      .catch(() => { if (alive) { setTrendF(null); setTrendFReason("趋势请求失败（网络/服务不可用）"); } });
    const SOURCES: Array<[string, string]> = [
      ["指标带", "/api/flywheel/card9"],
      ["体检", "/api/flywheel-health"],
      ["看板", "/api/flywheel-dashboard"],
      ["流水线", "/api/flywheel-flow"],
    ];
    Promise.all(SOURCES.map(async ([label, url]) => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.status === 401 || r.status === 403) return { label, forbidden: true as const };
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          if (FORBIDDEN_RE.test(txt)) return { label, forbidden: true as const };
          return { label, error: label + "读取失败（状态码 " + r.status + "）" };
        }
        const j = await r.json();
        return { label, data: j };
      } catch (e: unknown) {
        return { label, error: label + "请求失败：" + String((e as Error)?.message || e).slice(0, 80) };
      }
    })).then((rs) => {
      if (!alive) return;
      if (rs.some((x) => "forbidden" in x && x.forbidden)) { setPhase("forbidden"); return; }
      const errs: Record<string, string> = {};
      let okCount = 0;
      for (const x of rs) {
        if ("data" in x && x.data) {
          okCount++;
          if (x.label === "指标带") setC9(x.data as Card9);
          if (x.label === "体检") setHealth(x.data as Health);
          if (x.label === "看板") setDash(x.data as Dash);
          if (x.label === "流水线") setFlow(x.data as Flow);
        } else if ("error" in x && x.error) {
          errs[x.label] = x.error;
        }
      }
      setSrcErr(errs);
      if (okCount === 0) { setErr("飞轮的四个只读来源都取不到数据"); setPhase("error"); return; }
      if (rs.every((x) => "error" in x)) { setErr("飞轮的四个只读来源都取不到数据"); setPhase("error"); return; }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce]);

  const checks = Array.isArray(c9?.checks) ? c9.checks : [];
  const byId = (id: string) => checks.find((c) => c.id === id);
  const failRate = byId("extract_fail_rate");
  const cognition = byId("cognition_24h");
  const backlog = byId("backlog");

  const kpiHint = (c: Check | undefined, srcLabel: string) => {
    if (!c) return "n/a（原因：" + (c9 ? "该条指标未返回" : srcLabel + "不可得") + "）";
    if (c.valueNum == null) return "n/a（原因：" + (c.reason || "该条查询失败") + "）";
    return "阈值 " + (c.threshold || "n/a") + " · 判定 " + (STATE_TEXT[String(c.state)] || "不可判");
  };
  const kpiTone = (c: Check | undefined): "ok" | "warn" | "crit" | "na" => {
    if (!c || c.valueNum == null) return "na";
    return c.state === "fail" ? "crit" : c.state === "pass" ? "ok" : "na";
  };
  const kpiValue = (c: Check | undefined, suffix: string) => (c && c.valueNum != null ? NUM(c.valueNum) + suffix : "n/a");

  const steps = Array.isArray(flow?.steps) ? flow.steps.slice(0, 6) : [];
  const flowSum = steps.reduce((s, x) => s + (Number(x.qty?.h24) || 0), 0);
  const flowUsable = steps.length > 0 && flowSum > 0;
  const flowReason = !flow
    ? "n/a（原因：" + (srcErr["流水线"] || "流水线接口不可得") + "）"
    : steps.length === 0
      ? "n/a（原因：流水线接口未返回阶段）"
      : "n/a（原因：接口窗口计数全为 0，与库内飞轮事件历史存量矛盾，疑采集口径断/假 0 候选；按不可得处理，不写 0，见数据卡 G-2）";

  const verdict = Array.isArray(health?.verdict) ? health.verdict : [];
  const events = Array.isArray(dash?.recentEvents) ? dash.recentEvents : [];

  return (
    <main className="page" data-phase={phase} data-slot="flywheel-page">
      <PageHeader>
        <PageTitle>飞轮结构</PageTitle>
        <div className="page-subtitle">
          采集 → 提炼 → 反思 → 实践 → 改进 → 验证 六段闭环：看它转不转、哪一段卡住；本页只读。
          数据卡 9 口径（并入页头，不占槽）：提炼失败率 {kpiValue(failRate, "%")} · 认知链 24h 新增 {kpiValue(cognition, " 条")}{cognition ? (cognition.state === "fail" ? "（断流）" : "（正常）") : ""} · 飞轮积压 {kpiValue(backlog, " 条")} · 六段覆盖率 n/a（口径未定义，缺口 G1）。
        </div>
      </PageHeader>
      {/* 0.6.1 U-39：原侧栏二级入口（6 个）下沉到父页顶部「功能入口」带 */}
      <FeatureEntries
        items={(NAV_GROUPS.find((g) => g.id === "flywheel")?.items.find((i) => i.id === "flywheel")?.children || []).map((c) => ({
          href: c.href || "#",
          label: c.label,
          icon: c.icon,
          desc: c.desc,
        }))}
      />
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>飞轮</span><span>现有</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少飞轮看板的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「飞轮没数据」，请稍后重试或到运维看板确认库状态。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "unavailable" && (
        <div className={styles.state}>
          <b>飞轮数据未接入</b>
          <p>{err || "四路只读接口均不可得"}；未接入不等于「飞轮不转」，请在运维看板确认服务状态后再看本页。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "empty" && (
        <div className={styles.state}>
          <b>暂无飞轮数据</b>
          <p>四路只读接口正常返回但当前没有任何事件/任务/体检记录（empty，非不可得、非加载中）。{err ? " · " + err : ""}</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          {/* s12｜六段闭环（KPI/摘要）：窗口计数只作摘要；全 0 且与存量矛盾时按不可得处理 */}
          <div className={styles.bento} data-slot="flywheel-loop">
            <section className={styles.card + " " + styles.s12 + ""}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>六段闭环</h2><p className={styles.sub}>采集 → 提炼 → 反思 → 实践 → 改进 → 验证 · 近 24 小时窗口计数</p></div>
                <span className={flowUsable ? styles.tagOk : styles.tagNa}>{flowUsable ? "有窗口流量" : "不可得"}</span>
              </div>
              {flowUsable ? (
                <div className={styles.flow}>
                  {steps.map((s, i) => (
                    <div key={s.id || i} className={styles.flowStep}>
                      <div className={styles.flowN}>{String(i + 1).padStart(2, "0")}</div>
                      <div className={styles.flowT}>{s.label || "n/a"}</div>
                      <div className={styles.flowV}>{NUM(Number(s.qty?.h24) || 0)}</div>
                      <div className={styles.flowD}>近 24 小时</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.flow}>
                  {steps.length > 0 ? steps.map((s, i) => (
                    <div key={s.id || i} className={styles.flowStep}>
                      <div className={styles.flowN}>{String(i + 1).padStart(2, "0")}</div>
                      <div className={styles.flowT}>{s.label || "n/a"}</div>
                      <div className={styles.flowV + " " + styles.na}>n/a</div>
                      <div className={styles.flowD}>窗口计数不可得</div>
                    </div>
                  )) : null}
                  <p className={styles.naLine}>{flowReason}</p>
                </div>
              )}
              {/* 0.6.4 U-56b 判据⑤：30 天趋势——**不占格位**（设计 口径 4×6=24），作为本卡内的一行说明；
                  无历史数据必须 na + 原因，不得画空线或假 0 线。 */}
              <div className={styles.trendWrap}>
                <p className={styles.naLine} data-trend-summary={trendF ? "ok" : "na"} data-trend-state={trendF ? "ok" : "na"}>
                  30 天趋势（飞轮事件吞吐）：{trendF
                    ? "合计 " + trendF.reduce((s, x) => s + x.n, 0).toLocaleString("zh-CN") + " 条 · 有数据 " + trendF.length + " 天"
                    : "n/a（原因：" + (trendFReason || "30 天趋势未采集") + "）"}
                </p>
                {trendF ? (
                  /* 纯 SVG 迷你折线，不引图表库；缺日不补 0（序列只含有数据的日子） */
                  <svg className={styles.spark} viewBox="0 0 300 40" preserveAspectRatio="none" role="img" aria-label="飞轮事件吞吐近 30 天折线">
                    <polyline
                      fill="none" stroke="var(--brand)" strokeWidth="1.5"
                      points={trendF.map((x, i) => {
                        const max = Math.max(1, ...trendF.map((y) => y.n));
                        const px = trendF.length === 1 ? 150 : (i / (trendF.length - 1)) * 300;
                        const py = 38 - (x.n / max) * 34;
                        return px.toFixed(1) + "," + py.toFixed(1);
                      }).join(" ")}
                    />
                  </svg>
                ) : null}
              </div>
            </section>

            {/* s8｜各段覆盖率（KPI/摘要）：口径未定义 → 固定 n/a */}
            <section role="link" tabIndex={0} aria-label="查看各段覆盖率" onClick={() => router.push("/flywheel/coverage")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/flywheel/coverage"); } }} className={styles.card + " " + styles.s8 + ""}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>各段覆盖率</h2><p className={styles.sub}>六段各自的覆盖率（分母口径未定义）</p></div>
                <span className={styles.tagNa}>n/a</span>
              </div>
              <div className={styles.stateMini}>n/a（原因：六段覆盖率口径未定义，缺口 G1 —— 分子/分母/来源表均未定；不自造百分比、不写 0）。待数据线补齐口径后接入。</div>
            </section>

            {/* s4｜断点（列表）：来自体检结论 */}
            <section role="link" tabIndex={0} aria-label="查看断点详情" onClick={() => router.push("/flywheel/audit")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/flywheel/audit"); } }} className={styles.card + " " + styles.s4 + ""} data-metric-value={health ? String(verdict.length) : "na"}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>断点</h2><p className={styles.sub}>{health ? "来自体检结论 · " + verdict.length + " 条" : "来自体检结论"}</p></div>
                <span className={health ? styles.tagOk : styles.tagNa}>{health ? "只读" : "不可得"}</span>
              </div>
              {!health ? (
                <div className={styles.stateMini}>n/a（原因：{srcErr["体检"] || "体检接口不可得"}）</div>
              ) : verdict.length === 0 ? (
                <>
                  {/* 0.6.4 U-56b 板④-3（设计 判据③）：0 断点是**真 0**（真实的好结果），必须显示数值 0，不是 n/a */}
                  <div className={styles.bigZero + " " + styles.ok} data-true-zero="true">0</div>
                  <div className={styles.stateMini}>未发现断点（体检结论为空集 = 真 0，非 n/a、非取不到）—— 体检每小时更新，可稍后再看。</div>
                </>
              ) : (
                <ul className={styles.list}>
                  {verdict.map((v, i) => (
                    <li key={i}>
                      <span className={styles.dot + " " + (v.level === "crit" ? styles.dotCrit : v.level === "warn" ? styles.dotWarn : styles.dotOk)} />
                      <span className={styles.listText}>{v.text || "n/a"}</span>
                      <span className={styles.listMeta}>{v.level === "crit" ? "P1" : v.level === "warn" ? "P2" : "正常"}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className={styles.naLine}>责任线：n/a（体检结论无责任线字段，不猜线名）</p>
            </section>

            {/* D-05-05 板④ 格4 硬指标：口径未落地 -> n/a（不写 0） */}
            <section role="link" tabIndex={0} aria-label="查看硬指标" onClick={() => router.push("/flywheel/hard-metrics")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/flywheel/hard-metrics"); } }} className={styles.card + " " + styles.s4 + ""}>
              <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>硬指标</h2><p className={styles.sub}>飞轮硬指标（口径未落地）</p></div><span className={styles.tagNa}>n/a</span></div>
              <div className={styles.stateMini}>n/a（原因：硬指标口径未定义，缺口 G1 —— 分子/分母/来源表均未定；不自造数值、不写 0）。待数据线补齐口径后接入。</div>
            </section>
            {/* D-05-05 板④ 格5 模型用量：token/费用字段未落地 -> n/a（不写 0） */}
            <section role="link" tabIndex={0} aria-label="查看模型用量" onClick={() => router.push("/flywheel/llm-usage")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/flywheel/llm-usage"); } }} className={styles.card + " " + styles.s4 + ""}>
              <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>模型用量</h2><p className={styles.sub}>模型调用量 / 费用（无单价表）</p></div><span className={styles.tagNa}>n/a</span></div>
              <div className={styles.stateMini}>n/a（原因：模型调用量/费用字段未落地、且无单价表；按 U-02 口径不写 0、不写人民币零值）。</div>
            </section>

            {/* s12｜最近执行（表格）：接口只给近 5 分钟事件聚合，无逐轮输入/产出/耗时字段 */}
            <section role="link" tabIndex={0} aria-label="查看看板运行记录" onClick={() => router.push("/flywheel/logs")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/flywheel/logs"); } }} className={styles.card + " " + styles.s12 + ""}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>最近执行</h2><p className={styles.sub}>近 5 分钟事件聚合 · 轮次/输入/产出/耗时字段未落地，不伪造</p></div>
                <span className={dash ? styles.tagOk : styles.tagNa}>{dash ? "只读" : "不可得"}</span>
              </div>
              {!dash ? (
                <div className={styles.stateMini}>n/a（原因：{srcErr["看板"] || "看板接口不可得"}）</div>
              ) : events.length === 0 ? (
                <div className={styles.stateMini}>本时段没有飞轮事件（接口正常返回空集，非加载中）。最近一次事件时刻：{dash.lastTick?.createdAt ? new Date(dash.lastTick.createdAt).toLocaleString("zh-CN", { hour12: false }) : "不可得"}。</div>
              ) : (
                <table className={styles.tbl}>
                  <thead><tr><th>阶段</th><th>来源类型</th><th className={styles.num}>事件数</th></tr></thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={i}>
                        <td>{e.stage || "n/a"}</td>
                        <td>{e.sourceType || "n/a"}</td>
                        <td className={styles.num}>{NUM(Number(e.cnt) || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <footer className={styles.foot}>
            <DataMoment
              items={[
                { label: "指标带", at: c9?.asOf },
                { label: "体检", at: health?.asOf },
                { label: "看板", at: dash?.timestamp },
                { label: "流水线", at: flow?.timestamp },
              ]}
              showPrefix={false}
            />
            <span className={styles.footNote}>口径：指标带 = 数据卡 9（4 条判据，取不到即 n/a + 原因，不写 0）；六段闭环 = 流水线接口的窗口事件计数（全 0 且与事件存量矛盾时按不可得处理）；最近执行 = 近 5 分钟事件聚合。数据时刻逐源标注，不互相借用。</span>
          </footer>
        </>
      )}
    </main>
  );
}