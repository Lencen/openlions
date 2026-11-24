"use client";

// /cognitive/skills — 0.5 批次D · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s12｜技能清单（表格，含快捷筛选工具条）
// 取数（既有只读端点）：/api/stats（有效技能数）、/api/flywheel-health（近 7 日新增）、
//   /api/skills-list（列表 + 待复核存量计数）
// 口径纪律（数据卡 card-cognitive-skills）：
//   · 技能数 = 统计/列表口径（剔历史存量），字典全表口径差 legacy 行（G-1）→ 标签写「有效」，不冒充全表；
//   · 「步骤」列是布尔徽标（列表不下发步骤全文），不是步骤全文；
//   · 有效率 / 调用热区无调用级埋点（D-01）→ n/a + 原因；列表无数据时刻（G-2）→ 页脚标请求时刻。
import { useCallback, useEffect, useState } from "react";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Stats { asOf?: string; data?: { tables?: Record<string, number> }; }
interface Health { asOf?: string; seven?: Record<string, number>; }
interface SItem {
  id?: string; name?: string; businessName?: string | null; technicalName?: string | null;
  category?: string | null; level?: string | null; description?: string | null; trigger?: string | null;
  qualityScore?: number | null; totalUsageCount?: number | null; source?: string | null;
  hasContent?: boolean | null; content?: string | null; legacy?: boolean | null;
  updatedAt?: string | null; createdAt?: string | null;
}
interface SResp { items?: SItem[]; total?: number; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const DAY = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const clip = (v?: string | null, n = 60) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : "n/a";
};
const QUICK: Array<[string, string]> = [["", "全部"], ["highQuality", "高质量"], ["recent7d", "近 7 天"], ["pendingReview", "待复核"]];

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "crit" | "na" }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + (tone === "na" ? " " + styles.na : "")}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function SkillsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [quick, setQuick] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [list, setList] = useState<SResp | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({});
    const listUrl = "/api/skills-list?page=1&pageSize=20&sortBy=updatedAt&sortOrder=desc" + (quick ? "&quick=" + encodeURIComponent(quick) : "");
    const SOURCES: Array<[string, string]> = [
      ["统计", "/api/stats"],
      ["体检", "/api/flywheel-health"],
      ["列表", listUrl],
      ["待复核计数", "/api/skills-list?page=1&pageSize=1&quick=pendingReview"],
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
          if (x.label === "列表") setList(x.data as SResp);
          if (x.label === "待复核计数") {
            const n = (x.data as SResp).total;
            setReviewCount(typeof n === "number" ? n : null);
          }
        } else if ("error" in x && x.error) errs[x.label] = x.error;
      }
      setSrcErr(errs);
      if (!listRs || !("data" in listRs) || !listRs.data) { setErr(errs["列表"] || "技能列表不可得"); setPhase("error"); return; }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce, quick]);

  const tables = stats?.data?.tables || {};
  const effectiveTotal = typeof tables.skill === "number" ? tables.skill : null;
  const listTotal = typeof list?.total === "number" ? list.total : null;
  const seven = health?.seven?.Skill;
  const items = Array.isArray(list?.items) ? list.items : [];
  const hasSteps = (m: SItem) => m.hasContent === true || (m.content != null && String(m.content).trim().length > 0);

  return (
    <main className="page" data-slot="cognitive-skills-page">
      <PageHeader>
        <PageTitle>技能</PageTitle>
        <div className="page-subtitle">可复用技能与步骤完整度：技能数按「有效」口径，不冒充全表；本页只读。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>数据</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少技能的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「没有技能」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <div className={styles.kpis} data-slot="cognitive-skills-kpis">
            <Kpi
              label="技能数（有效）"
              value={effectiveTotal != null ? NUM(effectiveTotal) : "n/a"}
              hint={effectiveTotal != null ? "统计/列表口径（剔历史存量）· 字典全表口径差历史存量行（缺口 G-1），不拿有效值冒充全表" : "n/a（原因：" + (srcErr["统计"] || "统计接口不可得") + "）"}
              tone={effectiveTotal != null ? "ok" : "na"}
            />
            <Kpi
              label="近 7 日新增（派生）"
              value={health ? NUM(seven) : "n/a"}
              hint={health ? "近 7 日按创建时间（体检口径，派生非字典指标）" : "n/a（原因：" + (srcErr["体检"] || "体检接口不可得") + " · 不写 0）"}
              tone={health ? "ok" : "na"}
            />
            <Kpi
              label="无步骤 / 待复核存量"
              value={reviewCount != null ? NUM(reviewCount) : "n/a"}
              hint={reviewCount != null ? "快捷筛选「待复核」口径（含无步骤 / 步骤失效存量）· 派生，非字典指标" : "n/a（原因：" + (srcErr["待复核计数"] || "快捷筛选接口不可得") + "）"}
              tone={reviewCount != null ? "warn" : "na"}
            />
            <Kpi
              label="有效率 / 调用热区"
              value="n/a"
              hint="n/a（原因：无调用级埋点，字典 D-01 缺成功率 / 耗时字段；不拿质量分均值冒充）"
              tone="na"
            />
          </div>

          <div className={styles.toolbar} role="group" aria-label="技能快捷筛选">
            {QUICK.map(([key, label]) => (
              <button key={key || "all"} type="button" className={styles.filter + (quick === key ? " " + styles.filterOn : "")} onClick={() => setQuick(key)}>
                {label}{key === "" ? <span className={styles.badge}>{listTotal == null ? "n/a" : NUM(listTotal)}</span> : null}
              </button>
            ))}
            <span className={styles.hint}>快捷筛选口径在后端 · 当前筛选共 {listTotal == null ? "n/a" : NUM(listTotal)} 条（列表口径）</span>
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>技能清单</h2><p className={styles.sub}>默认更新时间倒序 · 「步骤」为布尔徽标（列表不下发步骤全文）· 成功率无埋点 → n/a</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>
            {items.length === 0 ? (
              <div className={styles.stateMini}>
                {quick
                  ? "没有匹配的技能（接口正常返回 0 条，列表本身有数据）—— 切回「全部」或清除筛选。"
                  : "还没有技能（接口正常返回空集，非加载中）—— 去提炼 / 结构化链路确认是否有技能产物。"}
              </div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>编号</th><th>技能</th><th>分类</th><th>等级</th><th>步骤</th><th>触发词</th><th className={styles.num}>调用次数</th><th>成功率</th><th className={styles.num}>质量分</th><th>更新时间</th></tr>
                  </thead>
                  <tbody>
                    {items.map((m, i) => (
                      <tr key={m.id || i}>
                        <td className={styles.mono}><a className={styles.link} href={"/cognitive/skills/detail?id=" + encodeURIComponent(String(m.id || ""))}>{m.id ? String(m.id).slice(0, 14) : "n/a"}</a></td>
                        <td className={styles.name} title={m.businessName || m.name || ""}>{clip(m.businessName || m.name)}</td>
                        <td>{m.category || "n/a"}</td>
                        <td>{m.level || "n/a"}</td>
                        <td><span className={styles.tagPlain + " " + (hasSteps(m) ? styles.toneOk : styles.toneWarn)}>{hasSteps(m) ? "有步骤" : "无步骤"}</span></td>
                        <td className={styles.dim + " " + styles.trig} title={m.trigger || ""}>{clip(m.trigger, 40)}</td>
                        <td className={styles.num}>{NUM(typeof m.totalUsageCount === "number" ? m.totalUsageCount : null)}</td>
                        <td className={styles.na}>n/a（无埋点）</td>
                        <td className={styles.num}>{typeof m.qualityScore === "number" ? m.qualityScore.toFixed(2) : "n/a"}</td>
                        <td className={styles.mono}>{DAY(m.updatedAt || m.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <footer className={styles.foot}>
            <DataMoment items={[{ label: "统计", at: stats?.asOf }, { label: "体检", at: health?.asOf }]} showPrefix={false} />
            <span className={styles.footNote}>列表时刻：请求时刻（客户端，非库内时刻 —— 列表接口不回数据时刻，缺口 G-2）；口径：技能数 = 统计/列表有效口径（剔历史存量，字典全表见 G-1）；近 7 日新增 = 体检口径（派生）；无步骤 / 待复核存量 = 快捷筛选口径（派生）；有效率 / 调用热区无调用级埋点 → n/a + 原因，不写 0。</span>
          </footer>
        </>
      )}
    </main>
  );
}
