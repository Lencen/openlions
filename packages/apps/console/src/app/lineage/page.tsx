"use client";

// /lineage — 0.5 批次B · demo slot 还原（2026-11-13）
// slots：s8｜血缘链路（KPI/摘要）· s4｜链路统计（stats）· s12｜数据血脉表（窗口增量 / 全量口径）
// 页首另有 4 项指标带：窗口内产物落库 / 注入使用 / 产物存量（全量）/ 验证态（接口坏字段 → n/a + 原因）
// 取数（既有只读端点）：/api/lineage（默认近 24 小时窗口）
// 口径纪律（按 DATA-FIELD-MAP + 数据卡）：
//   · 窗口增量与全量必须同屏，避免把「窗口 0」读成「库空了」；
//   · 注入使用 = 后台明细查询上限 500，达到上限写「≥500（截断）」，不当精确值；
//   · 验证态 / 知识使用接口字段为坏值 → 一律 n/a + 原因，不渲染 0、不显示 5572 年坏时间。
import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Stage { id?: string; label?: string; value?: number | null; unit?: string; note?: string; }
interface TableAgg { n?: number; total?: number; }
interface Consumption { injectionEvents?: number | null; injectedArtifacts?: number | null; consumedTasks?: number | null; }
interface Lineage {
  asOf?: string; range?: { key?: string; label?: string }; warnings?: string[];
  stages?: Stage[]; intake?: { inflowSessions?: number; inflowMessages?: number; extractedSessions?: number; droppedSessions?: number };
  products?: { total?: number | null; byTable?: Record<string, TableAgg> };
  consumption?: Consumption; verification?: Record<string, unknown>;
}

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "crit" | "na" }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + (tone === "na" ? " " + styles.na : tone === "warn" ? " " + styles.warn : "")}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function LineagePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [data, setData] = useState<Lineage | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setData(null);
    (async () => {
      try {
        const r = await fetch("/api/lineage?range=24h", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          if (FORBIDDEN_RE.test(txt)) { setPhase("forbidden"); return; }
          setErr("血缘接口读取失败（状态码 " + r.status + "）");
          setPhase("error");
          return;
        }
        const j: Lineage = await r.json();
        if (!alive) return;
        setData(j);
        setPhase("ok");
      } catch (e: unknown) {
        if (!alive) return;
        setErr("血缘接口请求失败：" + String((e as Error)?.message || e).slice(0, 80));
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const stages = Array.isArray(data?.stages) ? data!.stages! : [];
  const stage = (id: string) => stages.find((s) => s.id === id);
  const byTable = data?.products?.byTable || {};
  const totalProducts = ["Memory", "Knowledge", "Practice", "Skill"].reduce((acc, k) => {
    const t = byTable[k]?.total;
    return typeof t === "number" && Number.isFinite(t) ? acc + t : acc;
  }, 0);
  const hasTotal = ["Memory", "Knowledge", "Practice", "Skill"].every((k) => typeof byTable[k]?.total === "number");
  const windowLabel = data?.range?.label || "近 24 小时";
  const intake = data?.intake || {};
  const cons = data?.consumption || {};
  const storeStage = stage("store");
  const useStage = stage("use");
  const useValue = typeof useStage?.value === "number" ? useStage.value : null;
  const useTruncated = useValue != null && useValue >= 500;
  const fmtUse = useTruncated ? "≥500（截断）" : useValue != null ? NUM(useValue) : "n/a";
  const stageVal = (id: string) => {
    const s = stage(id);
    return s && typeof s.value === "number" && Number.isFinite(s.value) ? NUM(s.value) : "n/a";
  };
  const verificationBroken = !data?.verification || Object.keys(data.verification || {}).every((k) => {
    const v = (data!.verification as Record<string, unknown>)[k];
    return v && typeof v === "object" && Object.keys(v as object).length === 0;
  });

  return (
    <main className="page" data-slot="lineage-page">
      <PageHeader>
        <PageTitle>血缘</PageTitle>
        <div className="page-subtitle">数据与产物的上下游关系：窗口增量与全量同屏，用户看「断在哪一段」；本页只读。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>数据</span><span>现有</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少数据血缘的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「链路断了」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && data && (
        <>
          {/* 指标带：窗口增量 + 全量同屏；坏字段 → n/a + 原因 */}
          <div className={styles.kpis}>
            <Kpi
              label={"窗口内产物落库（" + windowLabel + "）"}
              value={storeStage ? NUM(Number(storeStage.value) || 0) + " 条" : "n/a"}
              hint={storeStage ? "窗口增量；窗口内 0 条 = 真 0（非库空），全量见第 3 项" : "n/a（原因：接口未返回落库段）"}
              tone={storeStage ? (Number(storeStage.value) === 0 ? "warn" : "ok") : "na"}
            />
            <Kpi
              label={"注入使用（" + windowLabel + "）"}
              value={fmtUse}
              hint={useValue == null ? "n/a（原因：接口未返回使用段）" : useTruncated ? "截断：后台明细查询上限 500，非精确全量；同窗口涉及 " + NUM(cons.injectedArtifacts) + " 条产物 / " + NUM(cons.consumedTasks) + " 个任务" : "窗口增量；未达查询上限，为真实计数"}
              tone={useValue == null ? "na" : useTruncated ? "warn" : "ok"}
            />
            <Kpi
              label="产物存量（全量）"
              value={hasTotal ? NUM(totalProducts) + " 条" : "n/a"}
              hint={hasTotal ? "全量口径（字典）：记忆 " + NUM(byTable.Memory.total) + " · 知识 " + NUM(byTable.Knowledge.total) + " · 实践 " + NUM(byTable.Practice.total) + " · 技能 " + NUM(byTable.Skill.total) : "n/a（原因：接口未返回全量对照）"}
              tone={hasTotal ? "ok" : "na"}
            />

          </div>

          <div className={styles.bento}>
            {/* s8｜血缘链路（KPI/摘要）：五段链路，值 = 窗口派生，非字典指标（缺口 G-1，仅流程示意） */}
            <section className={styles.card + " " + styles.s8}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>血缘链路</h2><p className={styles.sub}>会话入湖 → 提炼 → 落库 → 使用 → 回流 · {windowLabel}窗口派生（未定口径）</p></div>
                <span className={styles.tagNa}>未定口径</span>
              </div>
              <div className={styles.lane}>
                {stages.map((s, i) => (
                  <div key={s.id || i} className={styles.laneNode}>
                    <div className={styles.laneLabel}>{s.label || "n/a"}</div>
                    <div className={styles.laneValue}>{s.id === "use" ? fmtUse : NUM(Number(s.value) || 0)}</div>
                    <div className={styles.laneUnit}>{s.unit || "n/a"}</div>
                    <div className={styles.laneNote}>{s.note || "n/a"}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* s4｜链路统计（stats） */}
            <section className={styles.card + " " + styles.s4}>
              <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>链路统计</h2><p className={styles.sub}>{windowLabel}窗口</p></div><span className={styles.tagOk}>只读</span></div>
              <ul className={styles.stats}>
                <li><span className={styles.statK}>窗口内产物</span><b className={styles.statV}>{data.products && data.products.total != null ? NUM(data.products.total) + " 条" : "n/a"}</b></li>
                <li><span className={styles.statK}>注入涉及产物</span><b className={styles.statV}>{cons.injectedArtifacts != null ? NUM(cons.injectedArtifacts) + " 条" : "n/a"}</b></li>
                <li><span className={styles.statK}>认领任务</span><b className={styles.statV}>{cons.consumedTasks != null ? NUM(cons.consumedTasks) + " 个" : "n/a"}</b></li>
              </ul>
              <p className={styles.naLine}>积压 / 最近事件 / 验证态接口字段为坏值 → n/a（原因：接口修复前不渲染 0，见数据卡 G-2）。</p>
            </section>

            {/* s12｜边明细（demo 槽名不改）：边接口未落地 → 数据 n/a + 原因；五段汇总放该卡 note，不替换槽 */}
            <section className={styles.card + " " + styles.s12}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>边明细</h2><p className={styles.sub}>时间 / 操作 / 来源 / 目标 / 类型 / 备注 · {windowLabel}窗口</p></div>
                <span className={styles.tagNa}>不可得</span>
              </div>
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>时间</th><th>操作</th><th>来源</th><th>目标</th><th>类型</th><th>备注</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className={styles.na}>n/a</td>
                      <td className={styles.na}>n/a</td>
                      <td className={styles.na}>n/a</td>
                      <td className={styles.na}>n/a</td>
                      <td className={styles.na}>n/a</td>
                      <td className={styles.dim}>n/a（原因：边明细接口未落地 —— 数据卡 G-1 无字典条目、G-2 接口字段为坏值；不伪造边、不渲染 0）</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className={styles.noteBox}>
                <b className={styles.noteTitle}>五段汇总（窗口增量 / 全量对照 · 本卡辅助说明，不占槽）</b>
                <ul className={styles.sumList}>
                  <li>① 会话入湖：{intake.inflowSessions != null ? NUM(intake.inflowSessions) + " 个会话" : "n/a"}{intake.inflowMessages != null ? "（" + NUM(intake.inflowMessages) + " 条消息）" : ""}</li>
                  <li>② 提炼 / 结构化：{stageVal("extract") === "n/a" ? "n/a" : stageVal("extract") + " 个会话完成"}</li>
                  <li>③ 产物落库：窗口增量 {data.products && data.products.total != null ? NUM(data.products.total) + " 条" : "n/a"} / 全量 {hasTotal ? NUM(totalProducts) + " 条（记忆/知识/实践/技能）" : "n/a"}</li>
                  <li>④ 认领 / 注入使用：{fmtUse} 次（涉及 {NUM(cons.injectedArtifacts)} 条产物 / {NUM(cons.consumedTasks)} 个任务；明细查询上限 500）</li>
                  <li>⑤ 智能体产出回流：{stageVal("submit") === "n/a" ? "n/a" : stageVal("submit") + " 次提交"}</li>
                </ul>
              </div>
            </section>
          </div>

          {Array.isArray(data.warnings) && data.warnings.length > 0 ? (
            <div className={styles.warnNote}>部分数据源降级：{data.warnings.join("；")}</div>
          ) : null}

          <footer className={styles.foot}>
            <span>数据时刻：{data.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "该源无时刻（不显示占位符）"} · 窗口：{windowLabel} · 来源：血缘接口（只读）</span>
            <span className={styles.footNote}>口径：五段链路值均为窗口派生、字典无血缘条目（缺口 G-1），只作流程示意、不上指标位；窗口增量与全量同屏（避免把窗口 0 读成库空）；注入使用达到后台查询上限 500 时写「≥500（截断）」，不当精确值；验证态 / 知识使用为坏字段 → n/a + 原因。</span>
          </footer>
        </>
      )}
    </main>
  );
}