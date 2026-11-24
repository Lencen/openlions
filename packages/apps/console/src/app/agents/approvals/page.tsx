"use client";

// /agents/approvals — 0.5 批E · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → s12 摘要（4 KPI：待审批 / 今日通过 / 今日拒绝 / 审批人）→ s12 接入审批 → 请求时刻。
// 数据：/api/agent-approvals（待审批）+ /api/agent-approvals/history（历史）；数据卡 card-agents-approvals 已标：
//   两个接口当前均不可得（500 / 502，上游 admin 鉴权失败）→ 四项 KPI 一律 n/a + 原因，表格整表 n/a，禁止显示假 0。
// 四态：loading / empty（接口通且确实 0 条）/ error / forbidden(401/403) / unavailable（响应不是数组）。
// 本页只读：审批动作不在本批开放（写闸门需二次确认与审计；当前读接口亦不可得）。

import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle, KpiCard } from "@/components/ui";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface PendingAgent { agent_id?: string; display_name?: string; channel?: string; host?: string; requestedAt?: string | null; status?: string; requested_services?: string[] }
interface HistoryRow { createdAt?: string | null; action?: string | null; agent_id?: string | null; actor?: string | null; result?: string | null }

type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

function chipClass(state?: string | null): string {
  if (state === "APPROVED" || state === "通过") return styles.chipOk;
  if (state === "REJECTED" || state === "拒绝") return styles.chipCrit;
  if (state === "PENDING" || state === "待批") return styles.chipWarn;
  return styles.chipIdle;
}

export default function ApprovalsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [pending, setPending] = useState<PendingAgent[] | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [historyErr, setHistoryErr] = useState("");
  const [requestedAt, setRequestedAt] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    setHistoryErr("");
    try {
      const [pr, hr] = await Promise.all([
        fetch("/api/agent-approvals", { cache: "no-store" }),
        fetch("/api/agent-approvals/history", { cache: "no-store" }).catch(() => null),
      ]);
      setRequestedAt(new Date().toISOString());
      if (pr.status === 401 || pr.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!pr.ok) {
        setErr("待审批读接口返回状态码 " + pr.status + "（上游管理端鉴权失败，见数据卡 card-agents-approvals）");
        setPhase("error");
        return;
      }
      const pj = await pr.json();
      const list = Array.isArray(pj) ? pj : Array.isArray(pj.items) ? pj.items : null;
      if (!Array.isArray(list)) {
        setErr("待审批响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setPending(list);
      if (hr && hr.ok) {
        const hj = await hr.json();
        const hist = Array.isArray(hj) ? hj : Array.isArray(hj.rows) ? hj.rows : null;
        setHistory(hist);
        if (!hist) setHistoryErr("历史响应里没有可用的数据行");
      } else {
        setHistory(null);
        setHistoryErr("审批历史读接口" + (hr ? "返回状态码 " + hr.status : "请求失败") + "（上游鉴权失败）");
      }
      setLastOkAt(new Date().toISOString());
      setPhase(list.length ? "ok" : "empty");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const loading = phase === "loading";
  const rows = pending || [];

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>接入审批</PageTitle>
        <div className="page-subtitle">执行体接入申请：待审批列表与审批历史；接口不可得时四项指标一律 n/a，不显示假 0。</div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>成员</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.kpis}>
        <KpiCard label="待审批" value="n/a" hint="读接口不可得（500，上游管理端鉴权失败）；恢复前不自造数字" />
        <KpiCard label="今日通过" value="n/a" hint="依赖审批历史（502）；字典无「今日通过」条目" />
        <KpiCard label="今日拒绝" value="n/a" hint="依赖审批历史（502）；字典无「今日拒绝」条目" />
        <KpiCard label="审批人" value="n/a" hint="历史接口不可得；管理身份未在页面下发" />
      </div>

      <section className={styles.card}>
        <p className={styles.sub}>审批接口当前不可得（读 500 / 历史 502）；本页只读展示，KPI 与表格均为 n/a+原因，不写 0；恢复后按真实审批数据展示。</p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>接入审批</h2>
            <p className={styles.sub}>编号 / 申请方 / 对象 / 说明 / 提交 / 状态{phase === "ok" || phase === "empty" ? " · 共 " + fmtNum(rows.length) + " 条" : ""}</p>
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
              </div>
            ))}
          </div>
        ) : phase === "forbidden" ? (
          <div className={styles.state}>
            <b className={styles.stateTitle}>无权限</b>
            <p className={styles.stateText}>当前账号缺少「成员」读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
          </div>
        ) : phase === "error" || phase === "unavailable" ? (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>申请方</th>
                  <th>对象</th>
                  <th>说明</th>
                  <th>提交</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={6} className={styles.naCell}>
                    n/a（原因：{err || "响应里没有可用的数据行"}；四项指标同样 n/a。恢复判据：待审批接口返 200 且为数组、历史接口返 200。不显示 0。）
                  </td>
                </tr>
              </tbody>
            </table>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.stateMini}>当前没有待审批的接入申请（接口正常返回空集）。</div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>申请方</th>
                  <th>对象</th>
                  <th>说明</th>
                  <th>提交</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a, i) => (
                  <tr key={(a.agent_id || "") + i}>
                    <td className={styles.monoCell}>{a.agent_id || "n/a"}</td>
                    <td>{a.display_name || a.agent_id || "n/a"}</td>
                    <td className={styles.monoCell}>{a.channel || "n/a"} / {a.host || "n/a"}</td>
                    <td>请求接入平台{a.requested_services && a.requested_services.length ? "（业务 " + a.requested_services.length + " 项）" : ""}</td>
                    <td className={styles.monoCell}>{a.requestedAt ? fmtTime(a.requestedAt) : "n/a"}</td>
                    <td><span className={chipClass(a.status)}>{a.status === "PENDING" ? "待批" : a.status || "待批"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.foot}>
          请求时刻：{requestedAt ? fmtTime(requestedAt) : "n/a"}
          {historyErr ? " · 审批历史：" + historyErr : history ? " · 审批历史 " + fmtNum(history.length) + " 条" : ""}
          {" · 来源：接入审批读接口（只读）"}
        </p>
      </section>
    </main>
  );
}