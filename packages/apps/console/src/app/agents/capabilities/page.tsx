"use client";

// /agents/capabilities — 0.5 批E · demo slot 还原（2026-11-13）
// 槽位：页头 + 4 chips → s12 能力清单（能力 / 来源 / 绑定执行体 / 近 7 天调用 / 成功率 / 状态）。
// 数据：/api/agent-services（服务清单）+ /api/agent-permissions（按服务统计绑定执行体）+ /api/stats（技能/记忆规模）。
//   近 7 天调用、成功率无调用级埋点（D-01）→ 单元格 n/a + 原因；不写 0。
// 四态：loading / empty / error / forbidden(401/403) / unavailable（响应缺数据区）。
// 本页只读：能力绑定与授权写操作不在本页。

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface Service { id?: string; name: string; display_name?: string | null; status?: string | null; description?: string | null }
interface PermRow { agent_id?: string; permissions?: Array<{ service_name?: string; status?: string | null }> }
interface StatsPayload { data?: { tables?: { skill?: number; memory?: number } }; asOf?: string }

type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

export default function CapabilitiesPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [services, setServices] = useState<Service[] | null>(null);
  const [perms, setPerms] = useState<PermRow[] | null>(null);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [servicesAsOf, setServicesAsOf] = useState("");
  const [statsAsOf, setStatsAsOf] = useState("");
  const [requestedAt, setRequestedAt] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const [sr, pr, st] = await Promise.all([
        fetch("/api/agent-services", { cache: "no-store" }),
        fetch("/api/agent-permissions", { cache: "no-store" }).catch(() => null),
        fetch("/api/stats", { cache: "no-store" }).catch(() => null),
      ]);
      setRequestedAt(new Date().toISOString());
      if (sr.status === 401 || sr.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!sr.ok) {
        setErr("服务清单接口返回状态码 " + sr.status);
        setPhase("error");
        return;
      }
      const sj = await sr.json();
      const list = Array.isArray(sj) ? sj : Array.isArray(sj.services) ? sj.services : null;
      if (!Array.isArray(list)) {
        setErr("服务清单响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setServices(list);
      setServicesAsOf((sj && sj.asOf) || "");
      if (pr && pr.ok) {
        const pj = await pr.json();
        setPerms(Array.isArray(pj) ? pj : Array.isArray(pj.items) ? pj.items : null);
      } else {
        setPerms(null);
      }
      if (st && st.ok) {
        const stj = (await st.json()) as StatsPayload;
        setStats(stj);
        setStatsAsOf(stj.asOf || "");
      } else {
        setStats(null);
        setStatsAsOf("");
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
  const rows = services || [];
  const bindingCount = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const p of perms || []) {
      const aid = String(p.agent_id || "");
      for (const x of p.permissions || []) {
        const svc = String(x.service_name || "");
        if (!svc) continue;
        if (!map[svc]) map[svc] = new Set();
        if (aid) map[svc].add(aid);
      }
    }
    const out: Record<string, number> = {};
    for (const k of Object.keys(map)) out[k] = map[k].size;
    return out;
  }, [perms]);
  const skill = stats && stats.data && stats.data.tables ? stats.data.tables.skill : undefined;
  const memory = stats && stats.data && stats.data.tables ? stats.data.tables.memory : undefined;

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>能力中心</PageTitle>
        <div className="page-subtitle">
          业务服务与认知资产规模：技能 {loading ? "…" : typeof skill === "number" ? fmtNum(skill) : "n/a"} · 记忆 {loading ? "…" : typeof memory === "number" ? fmtNum(memory) : "n/a"} · 可用服务 {loading ? "…" : fmtNum(rows.filter((r) => String(r.status || "").toUpperCase() === "ACTIVE").length)}
        </div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>成员</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>能力清单</h2>
            <p className={styles.sub}>能力 / 来源 / 绑定执行体 / 近 7 天调用 / 成功率 / 状态{phase === "ok" || phase === "empty" ? " · 共 " + fmtNum(rows.length) + " 项" : ""}</p>
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
              </div>
            ))}
          </div>
        ) : phase === "forbidden" ? (
          <div className={styles.state}>
            <b className={styles.stateTitle}>无权限</b>
            <p className={styles.stateText}>当前账号缺少「成员」读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
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
          <div className={styles.state}>
            <b className={styles.stateTitle}>能力数据不可得</b>
            <p className={styles.stateText}>{err || "接口可用，但响应里没有数据区。"}</p>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.stateMini}>暂无可列的业务服务（接口正常返回空集）。</div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>能力</th>
                  <th>来源</th>
                  <th className={styles.num}>绑定执行体</th>
                  <th className={styles.num}>近 7 天调用</th>
                  <th>成功率</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const on = String(s.status || "").toUpperCase() === "ACTIVE";
                  const bind = perms ? bindingCount[String(s.name)] : undefined;
                  return (
                    <tr key={s.id || s.name}>
                      <td>
                        <span className={styles.nameCell}>{s.display_name || s.name}</span>
                        <span className={styles.subCell}>{s.description || "n/a"}</span>
                      </td>
                      <td>{s.name}</td>
                      <td className={styles.num}>{perms ? fmtNum(bind || 0) : <span className={styles.naCell} title="权限接口不可得">n/a</span>}</td>
                      <td className={styles.num}><span className={styles.naCell} title="D-01：无调用级埋点">n/a</span></td>
                      <td><span className={styles.naCell} title="D-01：无 success 列">n/a</span></td>
                      <td><span className={on ? styles.chipOk : styles.chipIdle}>{on ? "可用" : s.status || "未知"}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.foot}>
          <DataMoment items={[{ label: "服务清单", at: servicesAsOf }, { label: "认知资产统计", at: statsAsOf }]} />
          {" · 请求时刻 " + (requestedAt ? fmtTime(requestedAt) : "n/a") + " · 服务清单接口无数据时刻时显示「未知」，不借统计源时刻"}
        </p>
      </section>
    </main>
  );
}
