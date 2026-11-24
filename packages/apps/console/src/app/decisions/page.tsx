"use client";
/**
 * /decisions —— 决策治理（0.6.3 U-19，frontend 只读列表）
 *
 * 口径：
 *   · 后端决策库未就绪 -> API 503 -> 本页 unavailable + 原因（不显示假 0 条）
 *   · 就绪后展示：标题 / 状态 / 优先级 / 决策人 / 决策时刻 / 理由摘要
 *   · 四态：loading / ok / error / unavailable（403 时 forbidden）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import { t } from "@/i18n";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";
/**
 * 字段命名：按 platform-data 确认（mind 库既有约定 = PascalCase 表 + camelCase 列；
 * API 返回 camelCase）。三者一一对应：DecisionItem / DecisionAnalysis8D / DecisionOutcome。
 */
interface Decision {
  id?: string; title?: string; status?: string; priority?: string;
  decidedBy?: string | null; decidedAt?: string | null; reason?: string | null; createdAt?: string | null;
}
/** 8b-1：五值映射进 i18n；8b-2/3：未知值显式显示（不空白、不显英文原值） */
function statusLabel(status?: string): string {
  switch (status) {
    case "pending": return t("decisions.status.pending");
    case "decided": return t("decisions.status.decided");
    case "executing": return t("decisions.status.executing");
    case "done": return t("decisions.status.done");
    case "rejected": return t("decisions.status.rejected");
    default: return t("decisions.status.unknown", { status: status || "n/a" });
  }
}
const fmt = (v?: string) => {
  if (!v) return "n/a";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "n/a" : d.toLocaleString("zh-CN", { hour12: false });
};

export default function DecisionsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [rows, setRows] = useState<Decision[] | null>(null);
  const [asOf, setAsOf] = useState("");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);
  // 判据 4（模板 A 三件套）：搜索 + 排序
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState("decidedAt_desc");

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr("");
    // 2b：?state=error|forbidden|unavailable|empty 强制复现（判据可复跑）
    const forced = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("state") : null;
    if (forced === "empty") {
      // 设计 03:32：?state=empty 必须展示「暂无决策记录」，不能比默认空库态更空
      // -> 走 ok 相位 + rows=[] 复用同一个空态块（判据：文案齐全且 len 不小于默认态）
      setRows([]);
      setAsOf(new Date().toISOString());
      setPhase("ok");
      return;
    }
    if (forced === "error" || forced === "forbidden" || forced === "unavailable") {
      setErr("（复现模式：?state=" + forced + "）");
      setPhase(forced as Phase);
      return;
    }
    (async () => {
      try {
        const r = await fetch("/api/decisions?limit=100", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        const j = await r.json().catch(() => null);
        if (r.status === 503) { setErr((j && j.error) || "决策库未接入"); setPhase("unavailable"); return; }
        if (!r.ok) { setErr((j && j.error) || ("接口 " + r.status)); setPhase("error"); return; }
        if (!j?.ok || !Array.isArray(j.rows)) { setErr("返回格式不符（期望 rows 数组）"); setPhase("error"); return; }
        setRows(j.rows);
        setAsOf(j.asOf || "");
        setPhase("ok");
      } catch { if (alive) { setErr("请求失败（网络/服务不可用）"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [nonce]);

  /** 判据 4：搜索（标题/决策人/状态/优先级/理由）+ 排序（时间/状态） */
  const shown = useMemo(() => {
    const list = (rows || []).slice();
    const kw = q.trim().toLowerCase();
    const filtered = kw
      ? list.filter((d) =>
          [d.title, d.decidedBy, d.status, d.priority, d.reason].some((v) =>
            String(v || "").toLowerCase().includes(kw)
          )
        )
      : list;
    return filtered.slice().sort((a, b) => {
      if (sortBy === "decidedAt_asc") return String(a.decidedAt || "").localeCompare(String(b.decidedAt || ""));
      if (sortBy === "status") return String(a.status || "").localeCompare(String(b.status || ""));
      return String(b.decidedAt || "").localeCompare(String(a.decidedAt || ""));
    });
  }, [rows, q, sortBy]);

  return (
    <main className="page" data-slot="decisions-page">
      <PageHeader>
        <PageTitle>决策治理</PageTitle>
        <div className="page-subtitle">团队与决策治理：决策事项 / 8 维分析 / 落地追踪（只读；数据来自决策库）</div>
      </PageHeader>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}><b>无权限</b><p>当前账号没有查看决策库的权限（401/403）。</p></div>
      )}
      {phase === "unavailable" && (
        <div className={styles.state}>
          <b>决策库未接入</b>
          <p>{err || "决策库不可用（不等于没有决策）"}；数据线就绪后本页自动可用。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b>
          <p>{err}；失败不等于「没有决策」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && rows && (
        <>
          <PageSearch value={q} onChange={setQ} placeholder="搜索决策标题 / 决策人 / 状态…" />
          <div className={styles.bar}>
            <span className={styles.count}>共 {shown.length} 条{shown.length !== rows.length ? "（筛后 / 总 " + rows.length + "）" : ""}</span>
            <label className={styles.sort}>
              排序
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="排序方式">
                <option value="decidedAt_desc">决策时刻（新→旧）</option>
                <option value="decidedAt_asc">决策时刻（旧→新）</option>
                <option value="status">状态</option>
              </select>
            </label>
            <span className={styles.asOf}>数据时刻 {asOf ? fmt(asOf) : "n/a"}</span>
            <button className="btn" type="button" onClick={reload}>刷新</button>
          </div>
          {rows.length === 0 ? (
            <div className={styles.state}>
              <b>暂无决策记录</b>
              <p>决策库正常返回空集（非加载中、非失败）。</p>
            </div>
          ) : (
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th data-sortable="true" aria-sort={sortBy === "decidedAt_desc" || sortBy === "decidedAt_asc" ? "none" : "none"}>决策事项</th>
                  <th data-sortable="true" aria-sort={sortBy === "status" ? "ascending" : "none"}>状态</th>
                  <th>优先级</th>
                  <th>决策人</th>
                  <th data-sortable="true">决策时刻</th>
                  <th>理由摘要</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d, i) => (
                  <tr key={d.id || i}>
                    <td className={styles.name}>
                      {d.id ? <Link href={"/decisions/" + encodeURIComponent(d.id)}>{d.title || d.id}</Link> : (d.title || "n/a")}
                    </td>
                    <td><span className={styles.tag} data-status={d.status || "unknown"}>{statusLabel(d.status)}</span></td>
                    <td className={styles.pri} data-pri={d.priority || ""}>{d.priority || "n/a"}</td>
                    <td>{d.decidedBy || "n/a"}</td>
                    <td>{fmt(d.decidedAt || undefined)}</td>
                    <td className={styles.reason}>{d.reason || "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}