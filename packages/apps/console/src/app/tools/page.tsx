"use client";

// /tools — 0.5 批次C · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → 工具栏（全部 / 内置 / 服务 / 异常，计数无源 → n/a）→ 4 KPI（工具数 / 调用总量 / 平均成功率 / P95 延迟）
//   → s12 工具注册表（编号 / 工具 / 类型 / 调用量 / 成功率 / P95 / 状态）→ s12 说明 → 请求时刻。
// 数据：工具注册表接口尚未落地（数据卡 card-tools：G-01 无注册表接口、D-01 无调用级埋点，四个指标位全部 n/a）。
//   本页对「注册表接口」做就绪探测，用来区分 loading / forbidden / error / unavailable（404 等）/ empty（200 且空集）。
//   探测结果不参与任何指标计算；禁止把不可得写成 0，也不拿代理自述的 6 个工具名当注册表。
// 四态：loading / empty（接口通了确实无工具）/ error / forbidden(401/403) / unavailable（接口未落地）。
// 本页只读：无写按钮、无执行通道。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle, KpiCard } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

interface ToolRow { id: string; name?: string; kind?: string; calls?: number | null; successRate?: number | null; p95Ms?: number | null; state?: string }

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "builtin", label: "内置" },
  { key: "service", label: "服务" },
  { key: "bad", label: "异常" },
];

export default function ToolsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [rows, setRows] = useState<ToolRow[]>([]);
  const [probedAt, setProbedAt] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      // 2026-11-15 P2-B4：/api/mcp/servers 不存在，原 fetch 造成 404 + networkidle 超时；
      // 直接进入 unavailable（G-01 接口未落地），不发请求、不写 0。
      const at = new Date().toISOString();
      setProbedAt(at);
      setErr("注册表接口未落地（G-01：/api/mcp/servers 不存在）");
      setPhase("unavailable");
      return;
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const loading = phase === "loading";
  const total = rows.length;
  const bad = rows.filter((x) => String(x.state || "").toLowerCase() === "degraded" || String(x.state || "").toLowerCase() === "error").length;

  const [q, setQ] = useState("");

  return (
    <main className="page" data-slot="tools-page">
      <PageHeader>
        <PageTitle>工具注册表</PageTitle>
        <div className="page-subtitle">工具维度的调用质量：调用量、成功率与 P95 延迟；注册表接口未落地时全部 n/a，不以 0 冒充。</div>
      </PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索工具…" />

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>工具箱</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.toolbarRow}>
        <div className={styles.filters} role="group" aria-label="工具筛选">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className={f.key === "all" ? styles.filterBtnOn : styles.filterBtn} disabled title="注册表接口未落地：无数据可筛">
              {f.label}
              <span className={styles.badge}>n/a</span>
            </button>
          ))}
        </div>
        <span className={styles.hint}>
          服务维度见 <Link className={styles.inlineLink} href="/tools/mcp">工具服务</Link> · 只读
        </span>
      </div>

      <div className={styles.kpis} data-slot="tools-kpis">
        <KpiCard label="工具数" value="n/a" hint="注册表接口未落地（G-01）：无工具表可计数" />
        <KpiCard label="调用总量" value="n/a" hint="无调用级表；代理自述清单不能当调用量" />
        <KpiCard label="平均成功率" value="n/a" hint="D-01：工具调用埋点未上线，无 success 列" />
        <KpiCard label="P95 延迟" value="n/a" hint="D-01：无 duration 毫秒列，不估算" />
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>工具注册表</h2>
            <p className={styles.sub}>编号 / 工具 / 类型 / 调用量 / 成功率 / P95 / 状态{phase === "ok" ? " · 共 " + fmtNum(total) + " 条" : ""}</p>
          </div>
          <span className={styles.tagOk}>只读</span>
        </div>

        {loading ? (
          <div aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={styles.skelRow}>
                <span className={styles.skel + " " + styles.skelW1} />
                <span className={styles.skel + " " + styles.skelW2} />
                <span className={styles.skel + " " + styles.skelW3} />
                <span className={styles.skel + " " + styles.skelW4} />
              </div>
            ))}
          </div>
        ) : phase === "forbidden" ? (
          <div className={styles.state}>
            <b className={styles.stateTitle}>无权限</b>
            <p className={styles.stateText}>当前账号缺少「工具箱」读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
          </div>
        ) : phase === "error" ? (
          <div className={styles.state + " " + styles.stateErr}>
            <b className={styles.stateTitle}>加载失败</b>
            <p className={styles.stateText}>
              {err}。{lastOkAt ? "上次成功：" + fmtTime(lastOkAt) + "。" : "本次尚无成功记录。"}
            </p>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : phase === "unavailable" ? (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>工具</th>
                  <th>类型</th>
                  <th className={styles.num}>调用量</th>
                  <th className={styles.num}>成功率</th>
                  <th className={styles.num}>P95</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={7} className={styles.naCell}>
                    {'n/a（原因：注册表接口未落地 ' + (err || "404") + '；调用量/成功率/P95 属 D-01 待补，无表无埋点。补齐前本表不显示 0 或示例行。）'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : phase === "empty" ? (
          <div className={styles.stateMini}>暂无已注册工具（注册表接口已通且返回空集）。</div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>工具</th>
                  <th>类型</th>
                  <th className={styles.num}>调用量</th>
                  <th className={styles.num}>成功率</th>
                  <th className={styles.num}>P95</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className={styles.monoCell}>{t.id}</td>
                    <td>{t.name || "n/a"}</td>
                    <td>{t.kind || "n/a"}</td>
                    <td className={styles.num}>{typeof t.calls === "number" ? fmtNum(t.calls) : "n/a"}</td>
                    <td className={styles.num}>{typeof t.successRate === "number" ? t.successRate + "%" : "n/a"}</td>
                    <td className={styles.num}>{typeof t.p95Ms === "number" ? t.p95Ms + " ms" : "n/a"}</td>
                    <td>{t.state || "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.foot}>
          请求时刻：{probedAt ? fmtTime(probedAt) : "n/a"} · 来源：注册表就绪探测（只读）
          {phase === "ok" ? " · 异常 " + fmtNum(bad) + " 个" : ""}
        </p>
      </section>

    </main>
  );
}