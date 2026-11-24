"use client";

// /cognitive/memory — 0.5 批次B · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s12｜记忆条目（表格，含快捷筛选工具条）
// 取数（均既有只读端点）：/api/stats（总量/知识数/实践数）、/api/memories（列表，可带 quick）、/api/flywheel-health（近 7 日新增）
// 口径纪律：记忆数标「可读范围」并与全量口径说明（缺口 G-1）；置信度/被引用无字段 → 单元格 n/a；不写 0 冒充。
import { useCallback, useEffect, useState } from "react";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Stats { asOf?: string; data?: { tables?: Record<string, number> }; }
interface MemoryItem {
  id?: string; content?: string | null; summary?: string | null; title?: string | null;
  type?: string | null; tier?: string | null; domain?: string | null; theme?: string | null;
  valueScore?: number | null; qualityScore?: number | null; accessCount?: number | null;
  sourceType?: string | null; sourceId?: string | null; supersededBy?: string | null;
  createdAt?: string | null; updatedAt?: string | null;
}
interface MemoryResp { items?: MemoryItem[]; total?: number; asOf?: string; meta?: { scope?: string }; }
interface Health { asOf?: string; seven?: Record<string, number>; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const DAY = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const clip = (v?: string | null, n = 60) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : "n/a";
};
const QUICK: Array<[string, string]> = [["", "全部"], ["highQuality", "高质量"], ["recent7d", "近 7 天"], ["referenced", "被引用过"]];

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "crit" | "na" }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + (tone === "na" ? " " + styles.na : "")}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function MemoryPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [quick, setQuick] = useState("");
  const [q, setQ] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [mem, setMem] = useState<MemoryResp | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({});
    const memUrl = "/api/memories?page=1&pageSize=20&sortBy=updatedAt&sortOrder=desc" + (quick ? "&quick=" + encodeURIComponent(quick) : "");
    const SOURCES: Array<[string, string]> = [
      ["统计", "/api/stats"],
      ["列表", memUrl],
      ["体检", "/api/flywheel-health"],
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
          if (x.label === "列表") setMem(x.data as MemoryResp);
          if (x.label === "体检") setHealth(x.data as Health);
        } else if ("error" in x && x.error) errs[x.label] = x.error;
      }
      setSrcErr(errs);
      if (!listRs || !("data" in listRs) || !listRs.data) {
        setErr(errs["列表"] || "记忆列表不可得");
        setPhase("error");
        return;
      }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce, quick]);

  const tables = stats?.data?.tables || {};
  const items = Array.isArray(mem?.items) ? mem.items : [];
  const kw = q.trim().toLowerCase();
  const shown = kw
    ? items.filter((m) => [m.content, m.summary, m.title, m.type, m.tier, m.theme]
        .some((v) => String(v || "").toLowerCase().includes(kw)))
    : items;
  const total = typeof mem?.total === "number" ? mem.total : null;
  const sevenMemory = health?.seven?.Memory;

  return (
    <main className="page" data-slot="cognitive-memory-page">
      <PageHeader>
        <PageTitle>记忆库</PageTitle>
        <div className="page-subtitle">会话沉淀的事实与偏好：看它有没有真实沉淀、要不要清理；本页只读。</div>
      </PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索记忆内容 / 标题 / 类型…" />
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>数据</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少记忆库的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「还没有记忆」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          {/* s12｜（KPI/摘要）：4 项，取不到即 n/a + 原因 */}
          <div className={styles.kpis} data-slot="cognitive-memory-kpis">
            <Kpi
              label="记忆数（可读范围）"
              value={stats ? NUM(tables.memory) : "n/a"}
              hint={stats ? "可读范围（资产归属过滤后）；全量口径差 1 行（缺口 G-1，见数据字典），不静默当总量" : "n/a（原因：" + (srcErr["统计"] || "统计接口不可得") + "）"}
              tone={stats ? "ok" : "na"}
            />
            <Kpi
              label="近 7 日新增记忆"
              value={health ? NUM(sevenMemory) : "n/a"}
              hint={health ? "近 7 日按创建时间 · 源：同表体检口径" : "n/a（原因：" + (srcErr["体检"] || "体检接口不可得") + " · 不写 0）"}
              tone={health ? "ok" : "na"}
            />
            <Kpi
              label="知识数"
              value={stats ? NUM(tables.knowledge) : "n/a"}
              hint={stats ? "知识表全量（字典口径）" : "n/a（原因：" + (srcErr["统计"] || "统计接口不可得") + "）"}
              tone={stats ? "ok" : "na"}
            />
            <Kpi
              label="实践数"
              value={stats ? NUM(tables.practice) : "n/a"}
              hint={stats ? "实践表全量（字典口径）" : "n/a（原因：" + (srcErr["统计"] || "统计接口不可得") + "）"}
              tone={stats ? "ok" : "na"}
            />
          </div>

          <div className={styles.toolbar} role="group" aria-label="记忆快捷筛选">
            {QUICK.map(([key, label]) => (
              <button key={key || "all"} type="button" className={styles.filter + (quick === key ? " " + styles.filterOn : "")} onClick={() => setQuick(key)}>
                {label}{key === "" ? <span className={styles.badge}>{total == null ? "n/a" : NUM(total)}</span> : null}
              </button>
            ))}
            <span className={styles.hint}>快捷筛选口径在后端；计数仅「全部」可取（其余无逐档计数接口，不写假数）</span>
          </div>

          {/* s12｜记忆条目（表格） */}
          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>记忆条目</h2><p className={styles.sub}>{total == null ? "当前列表" : "当前筛选共 " + NUM(total) + " 条（生效中口径，不含已替代）"} · 默认更新时间倒序</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>
            {items.length === 0 ? (
              <div className={styles.stateMini}>
                {quick
                  ? "没有匹配的记录（接口正常返回 0 条，列表本身有数据）—— 清除筛选后重看。"
                  : "还没有记忆（接口正常返回空集，非加载中）—— 近 7 日新增为 0 时先查提炼链路。"}
              </div>
            ) : shown.length === 0 ? (
              <div className={styles.stateMini}>无匹配记忆（关键词「{q}」）—— 清除搜索后重看。</div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr>
                      <th>编号</th><th>内容</th><th>类型</th><th>来源（类型/编号）</th><th>置信度</th><th>被引用</th><th className={styles.num}>访问</th><th>状态</th><th>更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((m, i) => (
                      <tr key={m.id || i}>
                        <td className={styles.mono}>{m.id || "n/a"}</td>
                        <td className={styles.name} title={m.title || m.content || ""}>{clip(m.title || m.content)}</td>
                        <td>{m.type || "n/a"}</td>
                        <td className={styles.dim}>{[m.sourceType, m.sourceId ? String(m.sourceId).slice(0, 14) : null].filter(Boolean).join(" · ") || "n/a"}</td>
                        <td className={styles.na}>n/a（无该字段，缺口 G-4）</td>
                        <td className={styles.na}>n/a（无引用数字段；访问次数见右列）</td>
                        <td className={styles.num}>{NUM(typeof m.accessCount === "number" ? m.accessCount : null)}</td>
                        <td><span className={styles.tagPlain + (m.supersededBy ? "" : " " + styles.toneOk)}>{m.supersededBy ? "已被取代" : "生效中"}</span></td>
                        <td className={styles.mono}>{DAY(m.updatedAt || m.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <footer className={styles.foot}>
            <DataMoment
              items={[
                { label: "统计", at: stats?.asOf },
                { label: "列表", at: mem?.asOf },
                { label: "近 7 日新增", at: health?.asOf },
              ]}
              showPrefix={false}
            />
            <span className={styles.footNote}>口径：记忆数 = 统计接口可读范围（全量口径见数据字典 G-1，两者差 1 行资产归属过滤）；列表 = 生效中口径（不含已替代），total 即当前筛选条数；置信度 / 被引用无字段 → 单元格 n/a，不伪造；访问次数是真实字段但与「被引用」不同口径，分列显示。</span>
          </footer>
        </>
      )}
    </main>
  );
}
