"use client";

// /cognitive/practice — 0.5 批次D · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s12｜实践记录（表格，含快捷筛选工具条）
// 取数（既有只读端点）：/api/practice-list（列表 total）、/api/flywheel-health（近 7 日新增）
// 口径纪律（数据卡 card-cognitive-practice）：
//   · 列表 total = 41,148 是**含归档**的全表口径（本页列表不默认剔归档）→ 标签写「含归档」，不写成「有效实践」；
//   · 有效实践数无 BFF 出口、字典无条目 → n/a + 原因；「可转改进任务」接口未落地 → n/a，不画假按钮；
//   · 列表无数据时刻（G-2）→ 页脚标请求时刻。
import { useCallback, useEffect, useState } from "react";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Health { asOf?: string; seven?: Record<string, number>; }
interface PItem {
  id?: string; title?: string; type?: string | null; difficulty?: string | number | null;
  outcome?: string | null; qualityScore?: number | null; theme?: string | null;
  description?: string | null; lesson?: string | null; supersededBy?: string | null;
  updatedAt?: string | null; createdAt?: string | null;
}
interface PResp { items?: PItem[]; total?: number; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const DAY = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const clip = (v?: string | null, n = 56) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : "n/a";
};
const QUICK: Array<[string, string]> = [["", "全部"], ["highQuality", "高质量"], ["recent7d", "近 7 天"], ["pendingReview", "待复核"]];
const OUTCOME_LABEL: Record<string, string> = { FAILED: "失败", PARTIAL: "部分达成", SUCCESS: "成功", OK: "成功", DONE: "完成" };
const OUTCOME_TONE: Record<string, string> = { FAILED: "toneCrit", PARTIAL: "toneWarn", SUCCESS: "toneOk", OK: "toneOk", DONE: "toneOk" };

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "crit" | "na" }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + (tone === "na" ? " " + styles.na : "")}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function PracticePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [quick, setQuick] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [list, setList] = useState<PResp | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({});
    const listUrl = "/api/practice-list?page=1&pageSize=20&sortBy=updatedAt&sortOrder=desc" + (quick ? "&quick=" + encodeURIComponent(quick) : "");
    const SOURCES: Array<[string, string]> = [
      ["体检", "/api/flywheel-health"],
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
          if (x.label === "体检") setHealth(x.data as Health);
          if (x.label === "列表") setList(x.data as PResp);
        } else if ("error" in x && x.error) errs[x.label] = x.error;
      }
      setSrcErr(errs);
      if (!listRs || !("data" in listRs) || !listRs.data) { setErr(errs["列表"] || "实践列表不可得"); setPhase("error"); return; }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce, quick]);

  const listTotal = typeof list?.total === "number" ? list.total : null;
  const seven = health?.seven?.Practice;
  const items = Array.isArray(list?.items) ? list.items : [];

  return (
    <main className="page" data-slot="cognitive-practice-page">
      <PageHeader>
        <PageTitle>实践</PageTitle>
        <div className="page-subtitle">已复盘的实践记录：列表为含归档的全表口径；有效口径与「转改进任务」暂无接口，n/a 标注；本页只读。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>数据</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少实践的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「没有实践」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <div className={styles.kpis} data-slot="cognitive-practice-kpis">
            <Kpi
              label="实践数（含归档）"
              value={listTotal != null ? NUM(listTotal) : "n/a"}
              hint={listTotal != null ? "全表口径含已归档（本页列表不默认剔除归档）· 不写成「有效实践」" : "n/a（原因：" + (srcErr["列表"] || "列表接口不可得") + "）"}
              tone={listTotal != null ? "ok" : "na"}
            />
            <Kpi
              label="近 7 日新增（派生）"
              value={health ? NUM(seven) : "n/a"}
              hint={health ? "近 7 日按创建时间（体检口径，派生非字典指标）" : "n/a（原因：" + (srcErr["体检"] || "体检接口不可得") + " · 不写 0）"}
              tone={health ? "ok" : "na"}
            />
            <Kpi
              label="有效实践数"
              value="n/a"
              hint="n/a（原因：字典无「有效实践数」条目；列表接口无默认归档过滤，取不到有效口径 —— 不拿含归档数冒充，缺口 G-1）"
              tone="na"
            />
            <Kpi
              label="可转改进任务数"
              value="n/a"
              hint="n/a（原因：转派接口未落地（缺口 G-4）；能力未上线前不画不可点的转派按钮）"
              tone="na"
            />
          </div>

          <div className={styles.toolbar} role="group" aria-label="实践快捷筛选">
            {QUICK.map(([key, label]) => (
              <button key={key || "all"} type="button" className={styles.filter + (quick === key ? " " + styles.filterOn : "")} onClick={() => setQuick(key)}>
                {label}{key === "" ? <span className={styles.badge}>{listTotal == null ? "n/a" : NUM(listTotal)}</span> : null}
              </button>
            ))}
            <span className={styles.hint}>快捷筛选口径在后端 · 当前筛选共 {listTotal == null ? "n/a" : NUM(listTotal)} 条（列表口径，含归档）</span>
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>实践记录</h2><p className={styles.sub}>默认更新时间倒序 · 结果列按后端枚举展示 · 「采纳 / 转改进任务」无字段 → 不伪造</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>
            {items.length === 0 ? (
              <div className={styles.stateMini}>
                {quick
                  ? "没有匹配的实践记录（接口正常返回 0 条，列表本身有数据）—— 切回「全部」或清除筛选。"
                  : "还没有实践记录（接口正常返回空集，非加载中）—— 去提炼 / 结构化链路确认是否有实践产物。"}
              </div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>编号</th><th>实践</th><th>类型</th><th>难度</th><th>结果</th><th className={styles.num}>质量分</th><th>主题</th><th>更新时间</th></tr>
                  </thead>
                  <tbody>
                    {items.map((m, i) => {
                      const oc = String(m.outcome || "");
                      return (
                        <tr key={m.id || i}>
                          <td className={styles.mono}><a className={styles.link} href={"/cognitive/practice/detail?id=" + encodeURIComponent(String(m.id || ""))}>{m.id ? String(m.id).slice(0, 14) : "n/a"}</a></td>
                          <td className={styles.name} title={m.title || m.lesson || ""}>{clip(m.title)}</td>
                          <td>{m.type || "n/a"}</td>
                          <td>{m.difficulty != null && String(m.difficulty) !== "" ? String(m.difficulty) : "n/a"}</td>
                          <td><span className={styles.tagPlain + " " + (OUTCOME_TONE[oc] ? styles[OUTCOME_TONE[oc]] : styles.toneMute)}>{OUTCOME_LABEL[oc] || (oc || "n/a")}</span></td>
                          <td className={styles.num}>{typeof m.qualityScore === "number" ? m.qualityScore.toFixed(2) : "n/a"}</td>
                          <td>{m.theme || "n/a"}</td>
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
            <DataMoment items={[{ label: "体检", at: health?.asOf }]} showPrefix={false} />
            <span className={styles.footNote}>列表时刻：请求时刻（客户端，非库内时刻 —— 列表接口不回数据时刻，缺口 G-2）；口径：实践数 = 列表全表口径（含归档；有效口径无接口，见 G-1）；近 7 日新增 = 体检口径（派生）；有效实践数 / 可转改进任务数 = n/a + 原因，不写 0、不画假按钮。</span>
          </footer>
        </>
      )}
    </main>
  );
}
