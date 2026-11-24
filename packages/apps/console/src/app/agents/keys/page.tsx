"use client";

// /agents/keys — 0.5 批E · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → s12 说明（钥匙审批 ≠ 接入审批）→ s12 钥匙表（钥匙 / 归属 / 作用域 / 到期 / 最近使用 / 状态）→ 请求时刻。
// 数据：/api/agent-keys/pending（待审批钥匙，实测 200 + 空集真实 0）+ /api/agent-list（各执行体的权限凭证行）。
//   凭证明文字段一律不展示：只显示凭证编号（截断）、服务名、到期、最近使用与状态。
// 四态：loading / empty（确实没有可展示钥匙）/ error / forbidden(401/403) / unavailable（响应缺数据）。
// 本页只读：批/拒钥匙写操作不在本批开放（写闸门需二次确认与审计）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface PermRow {
  id?: string;
  agent_id?: string;
  service_name?: string;
  token_id?: string;
  expires_at?: string | null;
  permissions?: string | null;
  status?: string | null;
  last_used_at?: string | null;
}
interface AgentRow { agent_id: string; display_name?: string | null; permissions?: PermRow[] }
interface StatusPayload { ok?: boolean; asOf?: string; items?: unknown[]; contractVersion?: string }

type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

function scopeOf(p: PermRow): string {
  if (!p.permissions) return p.service_name || "n/a";
  const s = String(p.permissions);
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return (p.service_name || "") + ":" + j.join(",");
  } catch { /* 非结构化，按原文 */ }
  return (p.service_name || "") + ":" + s;
}
function stateOf(p: PermRow): { text: string; cls: string } {
  const s = String(p.status || "").toUpperCase();
  if (s === "ACTIVE") return { text: "有效", cls: styles.chipOk };
  if (s === "EXPIRED") return { text: "已过期", cls: styles.chipCrit };
  if (s === "REVOKED") return { text: "已撤销", cls: styles.chipCrit };
  return { text: p.status || "n/a", cls: styles.chipIdle };
}

export default function KeysPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [pendingKeys, setPendingKeys] = useState<number | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [listAsOf, setListAsOf] = useState("");
  const [requestedAt, setRequestedAt] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const [ar, kr] = await Promise.all([
        fetch("/api/agent-list", { cache: "no-store" }),
        fetch("/api/agent-keys/pending", { cache: "no-store" }).catch(() => null),
      ]);
      setRequestedAt(new Date().toISOString());
      if (ar.status === 401 || ar.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!ar.ok) {
        setErr("执行体清单接口返回状态码 " + ar.status);
        setPhase("error");
        return;
      }
      const aj = await ar.json();
      const list = Array.isArray(aj) ? aj : Array.isArray(aj.items) ? aj.items : null;
      if (!Array.isArray(list)) {
        setErr("执行体清单响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setAgents(list);
      setListAsOf((aj && aj.asOf) || "");
      if (kr && kr.ok) {
        const kj = (await kr.json()) as StatusPayload;
        if (Array.isArray(kj.items)) {
          setPendingKeys(kj.items.length);
          setPendingNote("");
        } else {
          setPendingKeys(null);
          setPendingNote("待审批响应里没有条目数组");
        }
      } else {
        setPendingKeys(null);
        setPendingNote("待审批读接口" + (kr ? "返回状态码 " + kr.status : "请求失败"));
      }
      setLastOkAt(new Date().toISOString());
      setPhase("ok");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const rows = useMemo(() => {
    const out: Array<{ key: string; who: string; display?: string | null; perms: PermRow[] }> = [];
    for (const a of agents || []) {
      for (const p of a.permissions || []) {
        out.push({ key: String(p.id || p.token_id || Math.random()), who: a.agent_id, display: a.display_name, perms: [p] });
      }
    }
    return out;
  }, [agents]);
  const loading = phase === "loading";

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>钥匙审批</PageTitle>
        <div className="page-subtitle">
          钥匙管的是凭证生命周期，接入审批管的是服务授权；待审批钥匙 {loading ? "…" : pendingKeys !== null ? fmtNum(pendingKeys) : "n/a"}
          {pendingNote ? "（" + pendingNote + "）" : ""}
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
            
            <p className={styles.sub}>两个审批对象不同源，不合并</p>
          </div>
        </div>
        <p className={styles.noteText}>
          钥匙审批 ≠ 接入审批：钥匙管的是凭证生命周期（签发 / 到期 / 轮换 / 鉴权失败排障），接入审批管的是业务服务授权。
          两者是不同对象，故并列而非合并。本页只展示凭证的编号（截断）、归属、作用域、到期、最近使用与状态，不展示任何凭证明文或哈希。
        </p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>钥匙</h2>
            <p className={styles.sub}>钥匙 / 归属 / 作用域 / 到期 / 最近使用 / 状态{phase === "ok" ? " · 共 " + fmtNum(rows.length) + " 条" : ""}</p>
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
            <b className={styles.stateTitle}>钥匙数据不可得</b>
            <p className={styles.stateText}>{err || "接口可用，但响应里没有数据区。"}</p>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.stateMini}>当前没有可展示的凭证记录（执行体权限行返回空集；这不等于「没有任何钥匙」，见页脚口径）。</div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>钥匙</th>
                  <th>归属</th>
                  <th>作用域</th>
                  <th>到期</th>
                  <th>最近使用</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const p = r.perms[0];
                  const st = stateOf(p);
                  return (
                    <tr key={r.key}>
                      <td>{p.token_id ? <span className={styles.chipOk}>已签发</span> : <span className={styles.chipIdle}>未签发</span>}</td>
                      <td>
                        <span className={styles.nameCell}>{r.display || r.who}</span>
                        <span className={styles.subCell}>{r.who}</span>
                      </td>
                      <td className={styles.monoCell}>{scopeOf(p)}</td>
                      <td className={styles.monoCell}>{p.expires_at ? fmtTime(p.expires_at) : "n/a"}</td>
                      <td className={styles.monoCell}>{p.last_used_at ? fmtTime(p.last_used_at) : <span className={styles.naCell}>n/a（未记录）</span>}</td>
                      <td><span className={st.cls}>{st.text}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.foot}>
          <DataMoment items={[{ label: "执行体清单", at: listAsOf }]} />
          {" · 请求时刻 " + (requestedAt ? fmtTime(requestedAt) : "n/a") + " · 待审批读接口无数据时刻"}
        </p>
      </section>
    </main>
  );
}