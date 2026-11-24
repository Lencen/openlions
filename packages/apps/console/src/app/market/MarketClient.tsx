"use client";

// /market — 0.5 D6-D12 业务看板 · demo slot 还原（2026-11-13）
// slots: s12 六域 strip → 6×s4 域卡 → s8 趋势 + s4 异常 → s12 各域明细
// 缺数据原位 n/a+原因（周环比/健康度/趋势无字典条目/接口）；demo 示例值禁入。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PageHeader, PageTitle, Pill } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import styles from "./page.module.css";

interface B {
  ok?: boolean; asOf?: string;
  agents?: { total: number | null; active: number | null } | null;
  sessions?: { total: number | null } | null;
  flywheel?: { pending: number; processing: number; backlog: number } | null;
  data?: { memory: number | null; knowledge: number | null; practice: number | null; skill: number | null; reflection: number | null; total: number } | null;
  tools?: { active: number; registered: number } | null;
  services?: { count: number } | null;
  business?: { done7d: number | null } | null;
  unavailable?: Array<{ field?: string; reason?: string }>;
}
const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const SUBS: Record<string, string> = { agents: "智能体数据", sessions: "会话数据", flywheel: "飞轮数据", data: "数据资产", tools: "工具服务", services: "服务目录" };
const DOMAINS = [
  { key: "agents", label: "智能体", href: "/agents" },
  { key: "sessions", label: "会话", href: "/sessions" },
  { key: "flywheel", label: "飞轮", href: "/flywheel" },
  { key: "data", label: "数据", href: "/cognitive/memory" },
  { key: "tools", label: "工具", href: "/tools" },
  { key: "services", label: "服务", href: "/design" },
];

export default function MarketPage({ forcedState = null }: { forcedState?: string | null }) {
  const router = useRouter();
  // 2026-11-19 F6/B-01：服务端传入 ?state= 强制态（page.tsx 解析 searchParams）；非法值忽略。
  const FORCED = forcedState === "empty" || forcedState === "error" || forcedState === "unavailable" || forcedState === "forbidden" ? forcedState : null;
  const [b, setB] = useState<B | null>(null);
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "forbidden" | "unavailable" | "empty">(FORCED ?? "loading");
  const [err, setErr] = useState(FORCED ? "（复现模式：?state=" + FORCED + "）" : "");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    // 2026-11-19 F6/B-01：?state= 已提到服务端（page.tsx -> forcedState），SSR 首屏即强制态。
    //   强制态下不取数、不改态（保证「看到的 = URL 要求的」，也避免 hydrate 后闪回真实态）。
    if (FORCED) return;
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/board-overview", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) { setErr("六域接口 " + r.status); setPhase("error"); return; }
        const j: B = await r.json();
        if (!alive) return;
        if (j.ok !== true) { setErr("六域不可得"); setPhase("unavailable"); return; }
        setB(j); setPhase("ok");
      } catch { if (alive) { setErr("六域请求失败"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [nonce, FORCED]);

  const val = (k: string): string => {
    if (!b) return "n/a";
    if (k === "agents") return n(b.agents?.total);
    if (k === "sessions") return n(b.sessions?.total);
    if (k === "flywheel") return b.flywheel ? n(b.flywheel.backlog) : "n/a";
    if (k === "data") return n(b.data?.total);
    if (k === "tools") return n(b.tools?.active);
    // 0.6.4 U-56b 板②-6：服务域用 board-overview.services.count（设计 24 格表 498201727）
    //   原来返回 "n/a"（字典无条目数），现按口径接 services.count
    if (k === "services") return n(b.services?.count);
    return "n/a";
  };
  const detail = (k: string): string[] => {
    if (k === "agents") return ["可用 " + n(b?.agents?.active), "注册 " + n(b?.agents?.total), "来源 AgentRegistry"];
    if (k === "sessions") return ["总数 " + n(b?.sessions?.total), "时刻 " + (b?.asOf ? new Date(b.asOf).toLocaleTimeString("zh-CN", { hour12: false }) : "n/a"), "来源 Session"];
    if (k === "flywheel") return ["排队 " + (b?.flywheel ? n(b.flywheel.pending) : "n/a"), "处理中 " + (b?.flywheel ? n(b.flywheel.processing) : "n/a"), "积压=排队+处理中"];
    if (k === "data") return ["记忆 " + n(b?.data?.memory), "知识 " + n(b?.data?.knowledge), "反思 " + n(b?.data?.reflection)];
    if (k === "tools") return ["可用 " + n(b?.tools?.active), "注册 " + n(b?.tools?.registered), "可用服务数（字典）"];
    return ["字典无条目数", "目录 " + n(b?.services?.count) + " 条", "仅下钻参考"];
  };

  const [q, setQ] = useState("");

  return (
    <main className="page" data-phase={phase}>
      <PageHeader>
        <PageTitle>业务看板</PageTitle>
        <div className="page-subtitle">六域规模与业务指标（只读）；周环比 / 健康度 / 趋势无字典口径处 n/a。</div>
        <Pill tone="neutral">只读</Pill>
      </PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索域…" />
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>看板</span><span>现有</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state} role="status" aria-busy="true">加载中…</div>}
      {phase === "forbidden" && <div className={styles.state} role="alert"><b>无权限</b><p>当前账号没有查看业务看板的权限（401/403）。</p></div>}
      {phase === "unavailable" && <div className={styles.state} role="alert"><b>六域不可得</b><p>{err || "只读聚合不可用"}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "error" && <div className={styles.state} role="alert"><b>加载失败</b><p>{err}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "empty" && (
        <div className={styles.state}>
          <b>暂无六域数据</b>
          <p>六域接口正常返回但当前没有任何域名目（empty，非不可得、非加载中）。{err ? " · " + err : ""}</p>
          <button className="btn" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "ok" && b && (
        <div className={styles.bento}>
          {/* s12 strip */}
          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>六域总览</h2><p className={styles.cardSub}>Bento 每格一个域 · 点击下钻</p></div><span className={styles.tagOk}>只读</span></div>
            <div className={styles.strip}>
            {DOMAINS.map((d) => (
              <Link key={d.key} href={d.href} className={styles.stripCell}>
                <span className={styles.dot} />
                <span className={styles.stripLabel}>{d.label}</span>
                <b className={styles.stripVal}>{val(d.key)}</b>
              </Link>
            ))}
            </div>
          </section>

          {/* 6×s4 cards */}
          {DOMAINS.map((d) => (
            <section key={d.key} role="link" tabIndex={0} aria-label={"整格可点：进入" + d.href} onClick={() => router.push(d.href)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(d.href); } }} className={styles.card + " " + styles.s4 + ""}>
              <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>{d.label}</h2><p className={styles.cardSub}>{SUBS[d.key] || "域数据"}</p></div><Link className={styles.more} href={d.href}>下钻 →</Link></div>
              <div className={styles.big}>{val(d.key)}</div>
              <div className={styles.delta + " " + styles.na}>周环比 n/a（无字典条目）</div>
              <ul className={styles.mini}>{detail(d.key).map((x, i) => <li key={i}>{x}</li>)}</ul>
              <div className={styles.meterLine}><span className="tiny">健康度</span><span className={styles.meter}><i className={styles.meterFill0} /></span><span className="tiny">n/a</span></div>
            </section>
          ))}

          {/* s8 trend + s4 anomalies */}
          <section className={styles.card + " " + styles.s8}>
            <div className={styles.cardHead}><h2 className={styles.cardTitle}>业务量趋势</h2><span className="tiny">近 30 天</span></div>
            <div className={styles.stateMini}>30 天趋势未采集（无只读接口；不伪造曲线）</div>
          </section>
          <section className={styles.card + " " + styles.s4}>
            <div className={styles.cardHead}><h2 className={styles.cardTitle}>异常与下钻</h2><span className="tiny">{(b.unavailable || []).length} 条</span></div>
            <ul className={styles.list}>
              {(b.unavailable || []).map((u, i) => (<li key={i}><span className={styles.dotWarn} /><span>{u.field}：{u.reason}</span></li>))}
              <li><span className={styles.dotWarn} /><span>服务域：字典无条目数 → n/a（目录 {n(b.services?.count)} 条仅下钻）</span></li>
              <li><span className={styles.dotWarn} /><span>周环比/健康度：无字典口径 → n/a</span></li>
            </ul>
          </section>

          {/* s12 detail table */}
          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}><h2 className={styles.cardTitle}>各域明细</h2><span className="tiny">只读</span></div>
            <table className={styles.tbl}>
              <thead><tr><th>域</th><th>规模</th><th>周环比</th><th>健康度</th><th>主入口</th><th>责任线</th></tr></thead>
              <tbody>
                {DOMAINS.map((d) => (
                  <tr key={d.key}>
                    <td className={styles.name}>{d.label}</td>
                    <td className="num">{val(d.key)}</td>
                    <td className={styles.na}>n/a</td>
                    <td className={styles.na}>n/a</td>
                    <td><Link className={styles.more} href={d.href}>{d.href}</Link></td>
                    <td className={styles.na}>n/a（无字段）</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </main>
  );
}