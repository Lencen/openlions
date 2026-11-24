"use client";

// /cognitive/knowledge — 0.5 批次D · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s12｜知识条目（表格，含快捷筛选工具条）
// 取数（既有只读端点）：/api/stats（字典口径知识数）、/api/flywheel-health（近 7 日新增）、/api/knowledge-list（列表）
// 口径纪律（数据卡 card-cognitive-knowledge）：三个「知识总数」不得互相冒充 ——
//   ①字典全表 = 统计接口 tables.knowledge；②列表有效 = 剔已归档；③治理库存不进指标位。
//   列表接口不回数据时刻（G-2）→ 页脚标「请求时刻（客户端，非库内时刻）」；验证态/引用使用字典无条目 → n/a + 原因。
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui";
import KnowledgeGovernancePanel from "./_components/KnowledgeGovernancePanel";
import styles from "./page.module.css";

// 0.6.2 U-02 检查项③：补 unavailable（数据不可得 ≠ 请求失败）
type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

interface Stats { asOf?: string; data?: { tables?: Record<string, number> }; }
interface Health { asOf?: string; seven?: Record<string, number>; }
interface KItem {
  id?: string; title?: string; category?: string | null; theme?: string | null; domain?: string | null;
  confidence?: number | null; qualityScore?: number | null; usageCount?: number | null;
  sourceType?: string | null; agentSource?: string | null; supersededBy?: string | null;
  stale?: boolean | null; verification?: string | null; humanConfirmed?: boolean | null;
  updatedAt?: string | null; createdAt?: string | null;
}
interface KResp { items?: KItem[]; total?: number; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const DAY = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const clip = (v?: string | null, n = 56) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : "n/a";
};
const QUICK: Array<[string, string]> = [["", "全部"], ["highQuality", "高质量"], ["recent7d", "近 7 天"], ["referenced", "被引用过"]];

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "crit" | "na" }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + (tone === "na" ? " " + styles.na : tone === "warn" ? " " + styles.warn : tone === "crit" ? " " + styles.crit : "")}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

function KnowledgePageInner() {
  // 2026-11-15 B4-6/R1：/cognitive/knowledge/governance 307 -> ?tab=governance 的目标页此前**没有治理 tab**
  //   （R1 实测：目标页 HTML 无治理块、/api/knowledge-governance 有数 58,749）。本页补 tab 承载，治理正文复用
  //   既有 KnowledgeGovernancePanel（取数 /api/knowledge-governance + /api/knowledge-dedupe，只读）。
  const sp = useSearchParams();
  const tab = sp.get("tab") === "governance" ? "governance" : "list";
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [quick, setQuick] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [list, setList] = useState<KResp | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({});
    const listUrl = "/api/knowledge-list?page=1&pageSize=20&sortBy=updatedAt&sortOrder=desc" + (quick ? "&quick=" + encodeURIComponent(quick) : "");
    const SOURCES: Array<[string, string]> = [
      ["统计", "/api/stats"],
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
          if (x.label === "统计") setStats(x.data as Stats);
          if (x.label === "体检") setHealth(x.data as Health);
          if (x.label === "列表") setList(x.data as KResp);
        } else if ("error" in x && x.error) errs[x.label] = x.error;
      }
      setSrcErr(errs);
      // 0.6.2 U-02：数据不可得用 unavailable（而非 error）——与 /about /todo 同族页一致
      if (!listRs || !("data" in listRs) || !listRs.data) { setErr(errs["列表"] || "知识列表不可得"); setPhase("unavailable"); return; }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce, quick]);

  const tables = stats?.data?.tables || {};
  const dictTotal = typeof tables.knowledge === "number" ? tables.knowledge : null;
  const listTotal = typeof list?.total === "number" ? list.total : null;
  const seven = health?.seven?.Knowledge;
  const archivedDiff = dictTotal != null && listTotal != null ? dictTotal - listTotal : null;
  const items = Array.isArray(list?.items) ? list.items : [];

  const govState = (m: KItem) => {
    if (m.supersededBy) return { text: "已归档", cls: styles.toneMute };
    if (m.stale) return { text: "已标记过期", cls: styles.toneWarn };
    if (m.verification) return { text: String(m.verification), cls: styles.toneMute };
    return { text: "在库", cls: styles.toneOk };
  };

  return (
    <main className="page" data-slot="cognitive-knowledge-page">
      <PageHeader>
        <PageTitle>知识库</PageTitle>
        <div className="page-subtitle">
          {tab === "governance"
            ? "知识治理概览：结构化整理与长期维护（只读；审核动作统一在 /todo）"
            : "结构化知识条目与治理状态：三个「知识总数」口径分开标；本页只读。"}
        </div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>数据</span><span>{tab === "governance" ? "治理" : "列表"}</span><span className={styles.crumbOn}>只读</span></div>
      <div className={styles.tabs} role="tablist" aria-label="知识库视图" data-slot="cognitive-knowledge-tabs">
        <a role="tab" aria-selected={tab === "list"} className={styles.tab + (tab === "list" ? " " + styles.tabOn : "")} href="/cognitive/knowledge">知识列表</a>
        <a role="tab" aria-selected={tab === "governance"} className={styles.tab + (tab === "governance" ? " " + styles.tabOn : "")} href="/cognitive/knowledge?tab=governance">治理概览</a>
      </div>

      {tab === "governance" && (
        <section className={styles.card + " " + styles.s12} data-span="12">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>治理概览</h2>
              <p className={styles.sub}>数据来自 /api/knowledge-governance + /api/knowledge-dedupe（只读；自动治理由定时任务每周执行，人工审核在 /todo）</p>
            </div>
            <span className={styles.tagOk}>只读</span>
          </div>
          <KnowledgeGovernancePanel />
          <p className={styles.footNote}>本视图由 /cognitive/knowledge/governance 307 重定向目标承载；治理字段均为库内真实值，加载失败会显式提示（不写 0）。</p>
        </section>
      )}

      {tab === "list" && (<>
      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少知识库的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「知识库为空」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "unavailable" && (
        <div className={styles.state}>
          <b>数据不可得</b><p>{err || "知识数据源不可用（不等于知识库为空）"}；请稍后重试或联系管理员。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <div className={styles.kpis}>
            <Kpi
              label="知识数（字典全表）"
              value={dictTotal != null ? NUM(dictTotal) : "n/a"}
              hint={dictTotal != null ? "字典口径（全表计数）· 与列表口径不同，不互相冒充" : "n/a（原因：" + (srcErr["统计"] || "统计接口不可得") + "）"}
              tone={dictTotal != null ? "ok" : "na"}
            />
            <Kpi
              label="列表有效（派生）"
              value={listTotal != null ? NUM(listTotal) : "n/a"}
              hint={listTotal != null ? "列表口径（剔已归档）· 与全表差 " + NUM(archivedDiff) + " 条 = 已归档行（派生，非字典指标）" : "n/a（原因：" + (srcErr["列表"] || "列表接口不可得") + "）"}
              tone={listTotal != null ? "ok" : "na"}
            />
            <Kpi
              label="近 7 日新增（派生）"
              value={health ? NUM(seven) : "n/a"}
              hint={health ? "近 7 日按创建时间（体检口径，派生非字典指标）" : "n/a（原因：" + (srcErr["体检"] || "体检接口不可得") + " · 不写 0）"}
              tone={health ? "ok" : "na"}
            />
            <Kpi
              label="验证态 / 引用使用"
              value="n/a"
              hint="n/a（原因：字典无「验证态」「引用使用」条目；引用使用聚合接口字段为坏值 —— 不写 0、不自造口径）"
              tone="na"
            />
          </div>

          <div className={styles.toolbar} role="group" aria-label="知识快捷筛选">
            {QUICK.map(([key, label]) => (
              <button key={key || "all"} type="button" className={styles.filter + (quick === key ? " " + styles.filterOn : "")} onClick={() => setQuick(key)}>
                {label}{key === "" ? <span className={styles.badge}>{listTotal == null ? "n/a" : NUM(listTotal)}</span> : null}
              </button>
            ))}
            <span className={styles.hint}>快捷筛选口径在后端 · 当前筛选共 {listTotal == null ? "n/a" : NUM(listTotal)} 条（列表口径）</span>
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>知识条目</h2><p className={styles.sub}>默认更新时间倒序 · 编号可点进详情 · 缺字段列保留并标 n/a</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>
            {items.length === 0 ? (
              <div className={styles.stateMini}>
                {quick
                  ? "没有匹配的知识条目（接口正常返回 0 条，列表本身有数据）—— 切回「全部」或清除筛选。"
                  : "还没有知识条目（接口正常返回空集，非加载中）—— 去提炼链路确认是否有新产物。"}
              </div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>编号</th><th>标题</th><th>分类</th><th>主题</th><th>域</th><th>来源</th><th className={styles.num}>使用次数</th><th className={styles.num}>质量分</th><th>状态</th><th>更新时间</th></tr>
                  </thead>
                  <tbody>
                    {items.map((m, i) => {
                      const g = govState(m);
                      return (
                        <tr key={m.id || i}>
                          <td className={styles.mono}><a className={styles.link} href={"/cognitive/knowledge/detail?id=" + encodeURIComponent(String(m.id || ""))}>{m.id ? String(m.id).slice(0, 14) : "n/a"}</a></td>
                          <td className={styles.name} title={m.title || ""}>{clip(m.title)}</td>
                          <td>{m.category || "n/a"}</td>
                          <td>{m.theme || "n/a"}</td>
                          <td>{m.domain || "n/a"}</td>
                          <td className={styles.dim}>{[m.agentSource, m.sourceType].filter(Boolean).join(" · ") || "n/a"}</td>
                          <td className={styles.num}>{NUM(typeof m.usageCount === "number" ? m.usageCount : null)}</td>
                          <td className={styles.num}>{typeof m.qualityScore === "number" ? m.qualityScore.toFixed(2) : "n/a"}</td>
                          <td><span className={styles.tagPlain + " " + g.cls}>{g.text}</span></td>
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
            <DataMoment items={[{ label: "统计", at: stats?.asOf }, { label: "体检", at: health?.asOf }]} showPrefix={false} />
            <span className={styles.footNote}>列表时刻：请求时刻（客户端，非库内时刻 —— 列表接口不回数据时刻，缺口 G-2）；口径：知识数 = 字典全表；列表有效 = 剔已归档（派生）；近 7 日新增 = 体检口径（派生）；验证态 / 引用使用字典无条目 → n/a + 原因，不写 0。</span>
          </footer>
        </>
      )}
      </>)}
    </main>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={<main className="page"><PageHeader><PageTitle>知识库</PageTitle><div className="page-subtitle">结构化知识条目与治理状态（只读）</div></PageHeader><div className={styles.state}>加载中…</div></main>}>
      <KnowledgePageInner />
    </Suspense>
  );
}
