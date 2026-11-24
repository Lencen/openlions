"use client";

// 0.5.1 B1-2 /audit/daily-summary · Bento P4 审计/日报（2026-11-15）
// slots：页头(日期导航+asOf+chips) → 4×s3 KPI → s12 服务健康 → s12 生产日报 → s6×2 质量 → s12 结论
// 数据：/api/daily-report?date&_gf；缺字段一律 n/a+原因，不写 0。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader, PageTitle } from "@/components/ui";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import BentoKpi from "@/components/bento/BentoKpi";
import BentoState from "@/components/bento/BentoState";
import type { Metric } from "@/components/bento/types";
import DailyHeader from "./_components/DailyHeader";
import { bjToday } from "./_components/shared";
import styles from "./page.module.css";

interface Production { today: number; prev: number; total: number }
interface DR {
  ok?: boolean;
  date?: string;
  summary?: { totalNew: number; totalActive: number; totalErrors: number };
  services?: { name: string; port: number; status: string }[];
  production?: Record<string, Production>;
  quality?: Record<string, number>;
  overCapacity?: { theme: string; count: number }[];
  errors?: unknown[];
  highlights?: { memories?: unknown[]; reflections?: unknown[] };
  asOf?: string;
}
const NUM = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const serviceLabel = (s: string) => s === "online" ? "正常" : s === "http_404" ? "在线但不健康" : s || "n/a";

export default function DailySummaryPage() {
  const router = useRouter();
  const [date, setDate] = useState(bjToday());
  const [data, setData] = useState<DR | null>(null);
  const [phase, setPhase] = useState<"loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable">("loading");
  const [err, setErr] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    try {
      const d = new URLSearchParams(window.location.search).get("date");
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
    } catch {}
  }, []);

  const changeDate = useCallback((d: string) => {
    setDate(d);
    try { router.push("/audit/daily-summary?date=" + d, { scroll: false }); } catch {}
  }, [router]);

  useEffect(() => {
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/daily-report?date=" + date, { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) { setErr("日报接口不可得（" + r.status + "）"); setPhase("error"); return; }
        const j: DR = await r.json();
        if (!alive) return;
        if (j.ok === false) { setErr("日报服务未启用或上游不可达"); setPhase("unavailable"); return; }
        setData(j);
        const has = !!(j.summary || j.services?.length || j.production);
        setPhase(has ? "ok" : "empty");
      } catch {
        if (alive) { setErr("日报请求失败（网络/服务不可用）"); setPhase("error"); }
      }
    })();
    return () => { alive = false; };
  }, [date, reloadKey]);

  const mk = (v: number | null, hint: string, unit = ""): Metric => v == null
    ? { kind: "na", reason: hint }
    : { kind: "value", value: NUM(v), unit, hint, tone: "info" };

  const prodRows = Object.entries(data?.production || {}).sort((a, b) => b[1].total - a[1].total);
  const exportCsv = () => {
    if (!data) return;
    const rows: string[][] = [["类型", "今日", "昨日", "累计"]];
    prodRows.forEach(([k, v]) => rows.push([k, String(v.today), String(v.prev), String(v.total)]));
    rows.push(["汇总", "totalActive=" + String(data.summary?.totalActive ?? "n/a"), "totalErrors=" + String(data.summary?.totalErrors ?? "n/a"), "asOf=" + String(data.asOf || "n/a")]);
    const csv = "\uFEFF" + rows.map((r) => r.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "daily-summary-" + date + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const serviceRows = data?.services || [];

  return (
    <main className="page">
      <PageHeader>
        <div className={styles.headRow}>
          <div>
            <PageTitle>每日审计摘要</PageTitle>
            <div className="page-subtitle">当日操作、变更与异常的汇总；数据时刻随行</div>
          </div>
          <DailyHeader date={date} setDate={changeDate} />
        </div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>审计</span><span>日报</span><span className={styles.crumbOn}>只读</span></div>
      <div className={styles.toolbar}>
        <button type="button" className={styles.btn} onClick={() => setReloadKey((k) => k + 1)}>刷新</button>
        <button type="button" className={styles.btn} onClick={exportCsv} disabled={!data}>导出 CSV（只读）</button>
      </div>

      {phase === "loading" && <BentoState phase="loading" />}
      {phase === "forbidden" && <BentoState phase="forbidden" title="无权限" detail="当前账号没有查看日报的权限（401/403）。" />}
      {phase === "error" && <BentoState phase="error" title="日报不可得" detail={err} onRetry={() => setDate((d) => d)} />}
      {phase === "unavailable" && <BentoState phase="unavailable" title="日报服务不可用" detail={err} />}
      {phase === "empty" && <BentoState phase="empty" title="当日无日报" detail="接口正常返回，但当日无总结数据。" />}

      {phase === "ok" && data && (
        <BentoGrid>
          <BentoCard title="总任务" span={3}><BentoKpi label="累计活跃" metric={mk(data.summary?.totalActive ?? null, "日报接口 totalActive")} /></BentoCard>
          <BentoCard title="成功" span={3}><BentoKpi label="成功数" metric={{ kind: "na", reason: "日报接口无成功计数字段" }} /></BentoCard>
          <BentoCard title="失败" span={3}><BentoKpi label="异常数" metric={mk(data.summary?.totalErrors ?? null, "日报接口 totalErrors")} /></BentoCard>
          <BentoCard title="平均耗时" span={3}><BentoKpi label="耗时" metric={{ kind: "na", reason: "日报接口无平均耗时字段" }} /></BentoCard>

          <BentoCard title="服务健康" sub={"日期 " + date + " · 端口状态"} span={12}>
            {serviceRows.length ? (
              <table className={styles.tbl}>
                <thead><tr><th>服务</th><th>端口</th><th>状态</th><th>响应</th><th>最近</th></tr></thead>
                <tbody>{serviceRows.map((s, i) => (
                  <tr key={i}><td className={styles.name}>{s.name}</td><td className="num">{s.port}</td><td><span className={s.status === "online" ? styles.tagOk : styles.tagWarn}>{serviceLabel(s.status)}</span></td><td className={styles.na}>n/a（接口未返回响应耗时）</td><td className={styles.na}>n/a（接口未返回最近探测时刻）</td></tr>
                ))}</tbody>
              </table>
            ) : <div className={styles.stateMini}>服务健康无数据（接口正常但空集）</div>}
            <p className={styles.foot}>注：mind 的 HTTP 404 ≠ 进程死亡（存活按进程/TCP 级；404 仅表示接口不存在/在线但不健康）。</p>
          </BentoCard>

          <BentoCard title="生产日报" sub={"产出类型汇总 · 近 " + date} span={12}>
            {prodRows.length ? (
              <table className={styles.tbl}>
                <thead><tr><th>类型</th><th>今日</th><th>昨日</th><th>累计</th><th>状态/耗时/负责人</th></tr></thead>
                <tbody>{prodRows.map(([k, v]) => (
                  <tr key={k}><td className={styles.name}>{k}</td><td className="num">{NUM(v.today)}</td><td className="num">{NUM(v.prev)}</td><td className="num">{NUM(v.total)}</td><td className={styles.na}>n/a（日报接口无逐条明细）</td></tr>
                ))}</tbody>
              </table>
            ) : <div className={styles.stateMini}>当日无生产数据（接口正常但空集）</div>}
          </BentoCard>

          <BentoCard title="质量指标" span={6}>
            {data.quality && Object.keys(data.quality).length ? (
              <ul className={styles.kv}>{Object.entries(data.quality).map(([k, v]) => <li key={k}><span>{k}</span><b>{NUM(v)}</b></li>)}</ul>
            ) : <div className={styles.stateMini}>n/a（质量面板未返回字段）</div>}
          </BentoCard>
          <BentoCard title="异常与容量" span={6}>
            {(data.overCapacity || []).length ? (
              <ul className={styles.kv}>{data.overCapacity!.slice(0, 6).map((x) => <li key={x.theme}><span>{x.theme}</span><b>{NUM(x.count)}</b></li>)}</ul>
            ) : <div className={styles.stateMini}>无超容量主题（接口返回空集）</div>}
          </BentoCard>

          <BentoCard title="结论" span={12}>
            {(data.highlights?.memories || []).length || (data.highlights?.reflections || []).length ? (
              <div className={styles.stateMini}>结论数据已返回（{String((data.highlights?.memories || []).length)} 条记忆 / {String((data.highlights?.reflections || []).length)} 条反思）</div>
            ) : <div className={styles.stateMini}>无结论数据（接口返回空集）</div>}
            <p className={styles.foot}>数据时刻：{data.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "请求时刻（接口未下发 asOf，非库内时刻）"} · 来源：/api/daily-report（只读）</p>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}