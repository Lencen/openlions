"use client";

// /sessions — 0.5 批次A · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → 工具栏（视图切换 / 搜索 / 状态筛选）→ 4 KPI（会话总数 / 今日 / 进行中 / 平均时长）
//   → s12 会话表（编号 / 标题 / 智能体 / 消息 / 时长 / 状态 / 负责人 / 更新）→ 逐源数据时刻。
// 取数：/api/session-list（活库会话行）+ /api/session-stats（同源统计），均为只读接口，本页无写操作。
// 无源口径按 n/a + 原因显示：今日（无日窗口计数接口）、进行中（提取状态四态里没有这一项）、
//   平均时长（字典 D-02 口径待补：回合边界未聚合成表）。禁止写 0 或示例值。
// 四态：loading / empty / error / forbidden(401/403) / unavailable（接口可用但数据不可得）。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle, KpiCard } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface SessionItem {
  session_uid: string;
  agent_id: string;
  title?: string | null;
  message_count?: number | null;
  status?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  updated_at?: string | null;
  uploaded_at?: string | null;
}
interface ListPayload {
  result?: { data?: { items?: SessionItem[]; total?: number } };
  source?: string;
  asOf?: string;
}
interface StatsPayload {
  result?: { data?: { total?: number; byStatus?: Record<string, number> } };
  asOf?: string;
}

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

const PAGE_SIZE = 20;

interface StatusMeta { text: string; tone: "ok" | "warn" | "crit" | "idle" }
const STATUS_META: Record<string, StatusMeta> = {
  DONE: { text: "已提炼", tone: "ok" },
  PROCESSED: { text: "已提炼", tone: "ok" },
  PENDING: { text: "待提炼", tone: "warn" },
  FAILED: { text: "提炼失败", tone: "crit" },
  SKIPPED: { text: "已跳过", tone: "idle" },
  RUNNING: { text: "进行中", tone: "warn" },
};
const statusMeta = (s?: string | null): StatusMeta => {
  const m = STATUS_META[String(s || "").toUpperCase()];
  return m || { text: s ? String(s) : "未知", tone: "idle" };
};

const FILTERS = [
  { key: "ALL", label: "全部" },
  { key: "ok", label: "已提炼" },
  { key: "warn", label: "待提炼" },
  { key: "crit", label: "提炼失败" },
  { key: "idle", label: "已跳过" },
] as const;

function chipClass(tone: StatusMeta["tone"]): string {
  if (tone === "ok") return styles.chipOk;
  if (tone === "warn") return styles.chipWarn;
  if (tone === "crit") return styles.chipCrit;
  return styles.chipIdle;
}

function fmtShort(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return mm + "-" + dd + " " + hh + ":" + mi;
}

/** 会话时长：只有起止时刻都齐（会话已结束）才算；否则 n/a（不拿「现在 - 开始」当结论）。 */
function fmtDuration(start?: string | null, end?: string | null): string | null {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const mins = Math.round((b - a) / 60000);
  if (mins < 1) return "<1 分钟";
  if (mins < 60) return mins + " 分钟";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h + " 小时" + (m ? " " + m + " 分" : "");
}

export default function SessionsPage() {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<SessionItem[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [listAsOf, setListAsOf] = useState("");
  const [statsAsOf, setStatsAsOf] = useState("");
  const [source, setSource] = useState("");
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("ALL");

  const load = useCallback(async (p: number) => {
    setPhase("loading");
    setErr("");
    try {
      const [lr, sr] = await Promise.all([
        fetch("/api/session-list?page=" + p + "&pageSize=" + PAGE_SIZE, { cache: "no-store" }),
        fetch("/api/session-stats", { cache: "no-store" }).catch(() => null),
      ]);
      if (lr.status === 401 || lr.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!lr.ok) {
        setErr("会话列表读取接口返回状态码 " + lr.status);
        setPhase("error");
        return;
      }
      const lj = (await lr.json()) as ListPayload;
      const data = lj && lj.result && lj.result.data;
      if (!data || !Array.isArray(data.items)) {
        setErr("会话列表响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setItems(data.items);
      setTotal(typeof data.total === "number" ? data.total : null);
      setListAsOf(lj.asOf || "");
      setSource(lj.source || "");
      if (sr && sr.ok) {
        const sj = (await sr.json()) as StatsPayload;
        setStats(sj);
        setStatsAsOf(sj.asOf || "");
      } else {
        setStats(null);
        setStatsAsOf("");
      }
      setLastOkAt(new Date().toISOString());
      setPhase("ok");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load(page);
  }, [page, load]);

  const all = items || [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: all.length, ok: 0, warn: 0, crit: 0, idle: 0 };
    for (const s of all) {
      const tone = statusMeta(s.status).tone;
      c[tone] = (c[tone] || 0) + 1;
    }
    return c;
  }, [all]);

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return all.filter((s) => {
      if (filter !== "ALL" && statusMeta(s.status).tone !== filter) return false;
      if (!kw) return true;
      const hay = [s.title, s.agent_id, s.session_uid].filter(Boolean).join(" ").toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }, [all, q, filter]);

  const statsTotal = stats && stats.result && stats.result.data ? stats.result.data.total : undefined;
  const shownTotal = typeof statsTotal === "number" ? statsTotal : total;
  const pages = shownTotal ? Math.max(1, Math.ceil(shownTotal / PAGE_SIZE)) : 1;
  const staleSource = source.indexOf("fallback") === 0;
  const loading = phase === "loading";
  const hasRows = phase === "ok" && rows.length > 0;

  return (
    <main className="page" data-slot="sessions-page">
      <PageHeader>
        <PageTitle>会话中心</PageTitle>
        <div className="page-subtitle">全部智能体会话的提炼状态与消息量；点行查看会话详情。</div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>服务</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.toolbarRow} data-slot="sessions-toolbar">
        <div className={styles.segTabs} role="group" aria-label="会话视图">
          <span className={styles.segTabOn}>会话列表</span>
          <Link className={styles.segTab} href="/messages/session">会话工作台 →</Link>
        </div>
        <input
          className={styles.searchInput}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 智能体 / 编号"
          aria-label="搜索会话：标题、智能体、编号"
        />
        <div className={styles.filters} role="group" aria-label="状态筛选">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? styles.filterBtnOn : styles.filterBtn}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className={styles.badge}>{items ? counts[f.key] || 0 : "…"}</span>
            </button>
          ))}
        </div>
        <span className={styles.hint}>筛选只作用于本页；分页与取数未改</span>
      </div>

      {staleSource ? (
        <div className={styles.noteWarn}>会话列表当前取自回退数据源（{source}），可能与实时状态不一致；活库恢复后本提示会消失。</div>
      ) : null}

      <div className={styles.kpis}>
        <KpiCard
          label="会话总数"
          value={loading ? "…" : typeof shownTotal === "number" ? fmtNum(shownTotal) : "n/a"}
          hint={loading ? "读取中" : typeof shownTotal === "number" ? (stats ? "活库同源统计（测量时刻见页脚）" : "列表接口返回的总数") : "统计与列表都不可得"}
          asOf={statsAsOf || listAsOf || null}
        />
        <KpiCard label="今日" value="n/a" hint="无日窗口计数接口（该口径未登记），不折算" />
        <KpiCard label="进行中" value="n/a" hint="提取状态只有已提炼/待提炼/失败/已跳过，无「进行中」" />
        <KpiCard label="平均时长" value="n/a" hint="口径待补（回合边界未聚合成表），不编数字" />
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>会话</h2>
            <p className={styles.sub}>
              编号 / 标题 / 智能体 / 消息 / 时长 / 状态 / 负责人 / 更新
              {shownTotal ? " · 共 " + fmtNum(shownTotal) + " 条" : ""}
            </p>
          </div>
          <span className={styles.tagOk}>只读</span>
        </div>

        {loading ? (
          <div aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={styles.skelRow}>
                <span className={styles.skel + " " + styles.skelW1} />
                <span className={styles.skel + " " + styles.skelW2} />
                <span className={styles.skel + " " + styles.skelW3} />
                <span className={styles.skel + " " + styles.skelW4} />
                <span className={styles.skel + " " + styles.skelW5} />
              </div>
            ))}
          </div>
        ) : phase === "forbidden" ? (
          <div className={styles.state}>
            <b className={styles.stateTitle}>无权限</b>
            <p className={styles.stateText}>
              当前账号缺少「会话管理」的读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。
            </p>
          </div>
        ) : phase === "error" ? (
          <div className={styles.state + " " + styles.stateErr}>
            <b className={styles.stateTitle}>加载失败</b>
            <p className={styles.stateText}>
              {err}。读取接口：会话列表与统计。{lastOkAt ? "上次成功：" + fmtTime(lastOkAt) + "。" : "本次尚无成功记录。"}
            </p>
            <button type="button" className={styles.btn} onClick={() => load(page)}>重试</button>
          </div>
        ) : phase === "unavailable" ? (
          <div className={styles.state}>
            <b className={styles.stateTitle}>会话数据不可得</b>
            <p className={styles.stateText}>{err || "读取接口可用，但响应里没有可用数据行。"}</p>
            <button type="button" className={styles.btn} onClick={() => load(page)}>重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.stateMini}>
            {q || filter !== "ALL" ? "没有匹配的会话：清空搜索或切换状态筛选。" : "本页没有会话：可翻页查看历史会话，或稍后刷新。"}
          </div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>标题</th>
                  <th>智能体</th>
                  <th className={styles.num}>消息</th>
                  <th>时长</th>
                  <th>状态</th>
                  <th>负责人</th>
                  <th>更新</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const meta = statusMeta(s.status);
                  const dur = fmtDuration(s.started_at, s.ended_at);
                  const href = "/sessions/detail?id=" + encodeURIComponent(s.session_uid);
                  return (
                    <tr key={s.session_uid}>
                      <td><Link className={styles.monoLink} href={href}>{s.session_uid}</Link></td>
                      <td><Link className={styles.nameLink} href={href}>{s.title || "—"}</Link></td>
                      <td>
                        <Link className={styles.nameLink} href={"/agents/detail?agentId=" + encodeURIComponent(s.agent_id || "")}>
                          {s.agent_id || "—"}
                        </Link>
                      </td>
                      <td className={styles.num}>{typeof s.message_count === "number" ? fmtNum(s.message_count) : "n/a"}</td>
                      <td>{dur || <span className={styles.naCell} title="会话未结束或缺少起止时刻">n/a</span>}</td>
                      <td><span className={chipClass(meta.tone)}>{meta.text}</span></td>
                      <td><span className={styles.naCell} title="会话表无负责人字段">n/a</span></td>
                      <td className={styles.monoCell}>{fmtShort(s.updated_at || s.uploaded_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasRows || (phase === "ok" && rows.length === 0) ? (
          <div className={styles.pagerRow}>
            <span>
              共 {typeof shownTotal === "number" ? fmtNum(shownTotal) + " 条" : "n/a"} · 第 {page}/{pages} 页 · 每页 {PAGE_SIZE}
            </span>
            <span className={styles.pagerBtns}>
              <button type="button" className={styles.btn} disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>上一页</button>
              <button type="button" className={styles.btn} disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>下一页</button>
            </span>
          </div>
        ) : null}

        <p className={styles.foot}>
          <DataMoment items={[{ label: "会话列表", at: listAsOf }, { label: "会话统计", at: statsAsOf }]} />
          {" · 来源：活库会话表（只读）"}
        </p>
      </section>
    </main>
  );
}
