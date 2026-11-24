"use client";

// /cognitive/reflection — 0.5 批次D · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s12｜反思记录（表格，含快捷筛选工具条）
// 取数（既有只读端点）：/api/stats（字典口径反思产出数）、/api/flywheel-health（反思 24h 新增）、
//   /api/flywheel/card9（反思任务新鲜度 process）、/api/reflection-list（列表 + 内容新鲜度派生）
// 口径纪律（数据卡 card-cognitive-reflection）：
//   · 反思产出数 = 字典全表；列表 total 剔 2 行测试数据 → 两值并列标差；
//   · 反思 24h 新增 = 0 是真实值（content 84h 无新内容），显示 0 + 测量时刻，不写 n/a；
//   · 反思任务新鲜度（process，主题反思表 status=OK）与反思内容新鲜度（content，反思表）两表不同，不可相减/互换。
import { useCallback, useEffect, useState } from "react";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Stats { asOf?: string; data?: { tables?: Record<string, number> }; }
interface Health { asOf?: string; five24?: Record<string, number>; }
interface Check { id: string; extra?: { lastActiveHours?: number }; valueNum?: number | null; state?: string; }
interface Card9 { asOf?: string; checks?: Check[]; }
interface RItem {
  id?: string; title?: string; description?: string | null; lesson?: string | null; improvements?: string | null;
  category?: string | null; priority?: string | null; status?: string | null; score?: number | null;
  sourceType?: string | null; theme?: string | null; updatedAt?: string | null; createdAt?: string | null;
}
interface RResp { items?: RItem[]; total?: number; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const DAY = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const clip = (v?: string | null, n = 60) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : "n/a";
};
const QUICK: Array<[string, string]> = [["", "全部"], ["recent7d", "近 7 天"], ["referenced", "被引用过"], ["pendingReview", "待复核"]];
const STATUS_LABEL: Record<string, string> = { COMPLETED: "已完成", RESOLVED: "已解决", FAILED: "失败", OPEN: "进行中", PENDING: "待处理" };
const STATUS_TONE: Record<string, string> = { COMPLETED: "toneOk", RESOLVED: "toneOk", FAILED: "toneCrit", OPEN: "toneWarn", PENDING: "toneWarn" };
const PROCESS_SLO = 36;
const CONTENT_SLO = 144;

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "crit" | "na" }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + (tone === "na" ? " " + styles.na : tone === "warn" ? " " + styles.warn : tone === "crit" ? " " + styles.crit : "")}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function ReflectionPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [quick, setQuick] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [c9, setC9] = useState<Card9 | null>(null);
  const [list, setList] = useState<RResp | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({});
    const listUrl = "/api/reflection-list?page=1&pageSize=20&sortBy=updatedAt&sortOrder=desc" + (quick ? "&quick=" + encodeURIComponent(quick) : "");
    const SOURCES: Array<[string, string]> = [
      ["统计", "/api/stats"],
      ["体检", "/api/flywheel-health"],
      ["指标带", "/api/flywheel/card9"],
      ["列表", listUrl],
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
        return { label, data: await r.json() };
      } catch (e: unknown) {
        return { label, error: label + "请求失败：" + String((e as Error)?.message || e).slice(0, 80) };
      }
    })).then((rs) => {
      if (!alive) return;
      if (rs.some((x) => "forbidden" in x && x.forbidden)) { setPhase("forbidden"); return; }
      const errs: Record<string, string> = {};
      const listRs = rs.find((x) => x.label === "列表");
      for (const x of rs) {
        if ("data" in x && x.data) {
          if (x.label === "统计") setStats(x.data as Stats);
          if (x.label === "体检") setHealth(x.data as Health);
          if (x.label === "指标带") setC9(x.data as Card9);
          if (x.label === "列表") setList(x.data as RResp);
        } else if ("error" in x && x.error) errs[x.label] = x.error;
      }
      setSrcErr(errs);
      if (!listRs || !("data" in listRs) || !listRs.data) { setErr(errs["列表"] || "反思列表不可得"); setPhase("error"); return; }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce, quick]);

  const tables = stats?.data?.tables || {};
  const dictTotal = typeof tables.reflection === "number" ? tables.reflection : null;
  const listTotal = typeof list?.total === "number" ? list.total : null;
  const diff = dictTotal != null && listTotal != null ? dictTotal - listTotal : null;
  const add24 = health?.five24?.Reflection;
  const processCheck = (c9?.checks || []).find((c) => c.id === "cognition_24h");
  const processHours = typeof processCheck?.extra?.lastActiveHours === "number" ? processCheck.extra.lastActiveHours : null;
  const items = Array.isArray(list?.items) ? list.items : [];
  const latestItem = items.slice().sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  })[0];
  const contentHours = latestItem?.updatedAt ? Math.round(((Date.now() - new Date(latestItem.updatedAt).getTime()) / 3600000) * 10) / 10 : null;

  const statusOf = (s?: string | null) => {
    const key = String(s || "");
    const cls = STATUS_TONE[key] ? styles[STATUS_TONE[key]] : styles.toneMute;
    return { text: STATUS_LABEL[key] || (key || "n/a"), cls };
  };

  return (
    <main className="page" data-slot="cognitive-reflection-page">
      <PageHeader>
        <PageTitle>反思</PageTitle>
        <div className="page-subtitle">反思记录与教训：任务新鲜度与内容新鲜度分开看，两表不同；本页只读。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>数据</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少反思的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「没有反思」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <div className={styles.kpis} data-slot="cognitive-reflection-kpis">
            <Kpi
              label="反思产出数（字典全表）"
              value={dictTotal != null ? NUM(dictTotal) : "n/a"}
              hint={dictTotal != null ? "字典口径 · 列表 " + NUM(listTotal) + "（剔 " + NUM(diff) + " 行测试数据，派生对照）" : "n/a（原因：" + (srcErr["统计"] || "统计接口不可得") + "）"}
              tone={dictTotal != null ? "ok" : "na"}
            />
            <Kpi
              label="反思 24h 新增"
              value={health ? NUM(add24) + " 条" : "n/a"}
              hint={health ? "真 0 是有效值（近 24h 无新反思，非缺失）· 字典刷新档 5 分钟" : "n/a（原因：" + (srcErr["体检"] || "体检接口不可得") + " · 不写 0）"}
              tone={health ? "ok" : "na"}
            />
            <Kpi
              label="反思任务新鲜度（process）"
              value={processHours != null ? processHours + " 小时" : "n/a"}
              hint={processHours != null ? "liveness 唯一事实源：主题反思表（只认成功状态）· SLO ≤" + PROCESS_SLO + " 小时" + (processHours > PROCESS_SLO ? " · 已越线" : "") : "n/a（原因：" + (srcErr["指标带"] || "指标带接口不可得") + "）"}
              tone={processHours == null ? "na" : processHours > PROCESS_SLO ? "crit" : "ok"}
            />
            <Kpi
              label="反思内容新鲜度（content）"
              value={contentHours != null ? contentHours + " 小时" : "n/a"}
              hint={contentHours != null ? "反思表最新更新时间距今 · SLO ≤" + CONTENT_SLO + " 小时 · 与任务新鲜度为两表，不可相减" : "n/a（原因：列表无更新时间字段或列表为空）"}
              tone={contentHours == null ? "na" : contentHours > CONTENT_SLO ? "crit" : "ok"}
            />
          </div>

          <div className={styles.toolbar} role="group" aria-label="反思快捷筛选">
            {QUICK.map(([key, label]) => (
              <button key={key || "all"} type="button" className={styles.filter + (quick === key ? " " + styles.filterOn : "")} onClick={() => setQuick(key)}>
                {label}{key === "" ? <span className={styles.badge}>{listTotal == null ? "n/a" : NUM(listTotal)}</span> : null}
              </button>
            ))}
            <span className={styles.hint}>快捷筛选口径在后端 · 当前筛选共 {listTotal == null ? "n/a" : NUM(listTotal)} 条（列表口径）</span>
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>反思记录</h2><p className={styles.sub}>默认更新时间倒序 · 编号可点进详情 · 「转改进任务」无字段 → n/a</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>
            {items.length === 0 ? (
              <div className={styles.stateMini}>
                {quick
                  ? "没有匹配的反思记录（接口正常返回 0 条，列表本身有数据）—— 切回「全部」或清除筛选。"
                  : "还没有反思记录（接口正常返回空集，非加载中）—— 去飞轮反思确认提炼与反思阶段。"}
              </div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>编号</th><th>主题</th><th>结论</th><th>分类</th><th>优先级</th><th className={styles.num}>分数</th><th>来源类型</th><th>状态</th><th>转改进任务</th><th>更新时间</th></tr>
                  </thead>
                  <tbody>
                    {items.map((m, i) => {
                      const st = statusOf(m.status);
                      return (
                        <tr key={m.id || i}>
                          <td className={styles.mono}><a className={styles.link} href={"/cognitive/reflection/detail?id=" + encodeURIComponent(String(m.id || ""))}>{m.id ? String(m.id).slice(0, 14) : "n/a"}</a></td>
                          <td className={styles.name} title={m.title || ""}>{clip(m.title)}</td>
                          <td className={styles.dim + " " + styles.concl} title={m.lesson || m.description || ""}>{clip(m.lesson || m.description || m.improvements, 70)}</td>
                          <td>{m.category || "n/a"}</td>
                          <td>{m.priority || "n/a"}</td>
                          <td className={styles.num}>{typeof m.score === "number" ? m.score.toFixed(2) : "n/a"}</td>
                          <td className={styles.dim}>{m.sourceType || "n/a"}</td>
                          <td><span className={styles.tagPlain + " " + st.cls}>{st.text}</span></td>
                          <td className={styles.na}>n/a（无字段）</td>
                          <td className={styles.mono}>{DAY(m.updatedAt || m.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <footer className={styles.foot}>
            <DataMoment items={[{ label: "统计", at: stats?.asOf }, { label: "体检", at: health?.asOf }, { label: "指标带", at: c9?.asOf }]} showPrefix={false} />
            <span className={styles.footNote}>列表时刻：请求时刻（客户端，非库内时刻 —— 列表接口不回数据时刻，缺口 G-2）；口径：反思产出数 = 字典全表（列表剔 2 行测试数据）；24h 新增 = 体检口径（0 是真实值）；任务新鲜度（process）= 主题反思表成功状态最近活动；内容新鲜度（content）= 反思表最新更新时间；两表不同，不可相减、不可互换。</span>
          </footer>
        </>
      )}
    </main>
  );
}
