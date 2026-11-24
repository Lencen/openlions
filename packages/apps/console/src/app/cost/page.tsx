"use client";

// 0.5.1 B1-4 /cost · Bento P5 图表（2026-11-15）
// slots：页头(range 24h/7d/30d + URL) → Hero 总 token → 4×s3 KPI → s8 趋势 + s4 按 Agent → s12 明细(分页)
// 数据：/api/token-usage?range=；空库显示 empty（dev 空库标注），不把 0 当真实消耗。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader, PageTitle } from "@/components/ui";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import BentoKpi from "@/components/bento/BentoKpi";
import BentoState from "@/components/bento/BentoState";
import type { Metric } from "@/components/bento/types";
import { fmtNum, fmtTokens, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

const RANGES = [["24h","近 24 小时"],["7d","近 7 天"],["30d","近 30 天"]] as const;
type RangeKey = typeof RANGES[number][0];
type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

export default function CostPage() {
  const router = useRouter();
  const [range, setRange] = useState<RangeKey>("24h");
  const [data, setData] = useState<any>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    try {
      const r = new URLSearchParams(window.location.search).get("range");
      if (r === "24h" || r === "7d" || r === "30d") setRange(r);
    } catch {}
  }, []);

  const changeRange = useCallback((r: RangeKey) => {
    setRange(r); setPage(0);
    try { router.push("/cost?range=" + r, { scroll: false }); } catch {}
  }, [router]);

  useEffect(() => {
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        const res = await fetch("/api/token-usage?range=" + range, { cache: "no-store" });
        if (!alive) return;
        if (res.status === 401 || res.status === 403) { setPhase("forbidden"); return; }
        if (!res.ok) { setErr("消耗接口不可得（" + res.status + "）"); setPhase("error"); return; }
        const j = await res.json();
        if (!alive) return;
        setData(j);
        const s = j.summary || {};
        const empty = !s.calls && !s.measuredTokens && !s.estimatedTokens;
        setPhase(empty ? "empty" : "ok");
      } catch {
        if (alive) { setErr("消耗请求失败（网络/服务不可用）"); setPhase("error"); }
      }
    })();
    return () => { alive = false; };
  }, [range]);

  const s = data?.summary || {};
  const trend = data?.trend || {};
  const tokens: number[] = Array.isArray(trend.tokens) ? trend.tokens : [];
  const points = Array.isArray(trend.points) ? trend.points : [];
  const maxTok = Math.max(1, ...tokens);
  const byAgent = (Array.isArray(data?.byAgent) ? data.byAgent : []).slice().sort((a: any, b: any) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 5);
  const calls = Array.isArray(data?.topCalls) ? data.topCalls : [];
  const pageSize = 20;
  const pageRows = calls.slice(page * pageSize, page * pageSize + pageSize);
  const pages = Math.max(1, Math.ceil(calls.length / pageSize));

  const mk = (v: number | null, hint: string, unit = ""): Metric => v == null
    ? { kind: "na", reason: hint }
    : { kind: "value", value: fmtTokens(v), unit, hint, tone: "info" };

  return (
    <main className="page" data-slot="cost-page">
      <h1 className={styles.srOnly}>成本与消耗</h1>
      <PageHeader>
        <div className={styles.headRow}>
          <div>
            <PageTitle>成本</PageTitle>
            <div className="page-subtitle">模型调用量与分摊口径（只统计词元数量，不折算金额）</div>
          </div>
          <div className={styles.rangeBox} role="tablist" aria-label="时间范围">
            {RANGES.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={range === k} className={range === k ? styles.rangeOn : styles.rangeBtn} onClick={() => changeRange(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div className={styles.chips} aria-label="页面层级"><span>#</span><span>成本</span><span>消耗</span><span className={styles.crumbOn}>只读</span></div>
      </PageHeader>

      {phase === "loading" && <BentoState phase="loading" />}
      {phase === "forbidden" && <BentoState phase="forbidden" title="无权限" detail="当前账号没有查看消耗的权限（401/403）。" />}
      {phase === "error" && <BentoState phase="error" title="消耗不可得" detail={err} onRetry={() => changeRange(range)} />}
      {phase === "unavailable" && <BentoState phase="unavailable" title="消耗服务不可用" detail={err} />}
      {phase === "empty" && (
        <BentoState phase="empty" title="窗口内无消耗数据" detail="接口正常返回但没有任何 CALL_LLM 记录；dev 空库/未接管理库时也会如此，不能当作真实 0 消耗。" />
      )}

      {phase === "ok" && (
        <BentoGrid>
          <BentoCard title="总消耗（实测）" sub="只统计实测 tok=，不含估算" span={12}>
            <div className={styles.hero} data-slot="cost-hero">
              <b className={styles.heroNum}>{fmtTokens(s.totalTokens || 0)}</b>
              <span className={styles.heroUnit}>tokens</span>
              <span className={styles.heroMeta}>区间 {range} · 调用 {fmtNum(s.calls)} · 实测 {fmtNum(s.measuredCalls)} · 估算 {fmtTokens(s.estimatedTokens || 0)} · 合计（实测+估算，仅展示）{fmtTokens(s.combinedTokens ?? ((s.totalTokens || 0) + (s.estimatedTokens || 0)))}</span>
            </div>
          </BentoCard>

          <BentoCard title="实测 tokens" span={3}><BentoKpi label={"近 " + range} metric={mk(s.totalTokens ?? null, "接口 measuredTokens")} /></BentoCard>
          <BentoCard title="7 日均" span={3}><BentoKpi label="日均 tokens" metric={{ kind: "na", reason: "接口未返回按日均值；需按日桶计算后再展示" }} /></BentoCard>
          <BentoCard title="调用数" span={3}><BentoKpi label="总调用" metric={mk(s.calls ?? null, "CALL_LLM 行数（含未计量）", "次")} /></BentoCard>
          <BentoCard title="平均/调用" span={3}><BentoKpi label="实测均值" metric={mk(s.avgTokensPerMeasuredCall ?? null, "仅实测调用", "tokens")} /></BentoCard>

          <BentoCard title="词元趋势" sub={"按 " + (trend.bucketKind || "小时/日") + " 桶"} span={8}>
            {tokens.length ? (
              <div className={styles.bars} aria-label="词元趋势">
                {tokens.map((v, i) => (
                  <span key={i} className={styles.bar} style={{ height: Math.max(2, Math.round((v / maxTok) * 120)) + "px" }} title={((points[i] && (points[i].label || points[i].ts)) ? String(points[i].label || points[i].ts) : "") + " · " + fmtTokens(v)} />
                ))}
              </div>
            ) : <div className={styles.stateMini}>无趋势数据（接口返回空桶）</div>}
          </BentoCard>
          <BentoCard title="按智能体（前五）" span={4}>
            {byAgent.length ? (
              <ul className={styles.kv}>{byAgent.map((a: any) => <li key={a.agentId}><span>{a.agentId}</span><b>{fmtTokens(a.tokens || 0)}</b></li>)}</ul>
            ) : <div className={styles.stateMini}>无智能体归因数据（窗口内无自报用量）</div>}
          </BentoCard>

          <BentoCard title="明细" sub={"共 " + fmtNum(calls.length) + " 条 · 每页 " + pageSize} span={12}>
            {calls.length ? (
              <>
                <table className={styles.tbl}>
                  <thead><tr><th>时间</th><th>Agent/来源</th><th>stage</th><th>模型</th><th>tokens</th><th>耗时</th></tr></thead>
                  <tbody>{pageRows.map((c: any, i: number) => (
                    <tr key={i}><td>{c.at ? fmtTime(c.at) : "n/a"}</td><td>{c.agentId || c.entry || "平台"}</td><td>{c.entry || "n/a"}</td><td>{c.model || "n/a"}</td><td className="num">{c.tokens ? fmtTokens(c.tokens) : "n/a"}</td><td className="num">{c.durationMs ? Math.round(c.durationMs / 1000) + "s" : "n/a"}</td></tr>
                  ))}</tbody>
                </table>
                <div className={styles.pager}>
                  <button type="button" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
                  <span>{page + 1}/{pages}</span>
                  <button type="button" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>下一页</button>
                </div>
              </>
            ) : <div className={styles.stateMini}>窗口内无调用明细（接口返回空集）</div>}
            <p className={styles.foot}>数据时刻：{data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "请求时刻（接口未下发 asOf）"} · 来源：/api/token-usage（只读）</p>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}