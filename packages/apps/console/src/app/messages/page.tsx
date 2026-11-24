"use client";

// /messages — 0.5 批次A · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → 工具栏（频道消息 / 跨会话管理）→ 4 KPI（消息数 24h / 频道 / 投递成功 / 平均延迟）
//   → s12 频道消息流表（时间 / 频道 / 发送方 / 接收方 / 类型 / 投递）→ 逐源数据时刻。
// 取数：/api/macs-status（库就绪）+ /api/macs/conversations（会话与参与方）+ /api/macs/manage（消息行、24h 计数），均只读。
// 无已签口径的 KPI 一律 n/a + 原因：投递成功率、平均延迟；不写 0、不拿示例值顶替。
// 四态：loading / empty / error / forbidden(401/403) / unavailable（消息库未就绪）。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle, KpiCard } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import PageSearch from "@/components/ui/PageSearch";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface MacsStatus { ok?: boolean; ready?: boolean; tables?: number | null; reason?: string | null; asOf?: string }
interface Conversation { id: string; type?: string; title?: string; participants?: string[]; lastAt?: string | null; lastFrom?: string | null; transport?: string | null }
interface ConversationsPayload { ok?: boolean; count?: number; conversations?: Conversation[]; asOf?: string; reason?: string }
interface MessageRow { id: string; conversationId: string; conversation?: string; from?: string; text?: string; type?: string; transport?: string | null; brain?: string | null; at?: string | null }
interface ManagePayload { ok?: boolean; total?: number; count?: number; messages?: MessageRow[]; reason?: string }

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

const KIND_LABEL: Record<string, string> = {
  p2p_text: "点对点消息",
  group_text: "群组消息",
  system: "系统消息",
  notice: "通知",
  order: "指令",
  ack: "回执",
};
const DELIVERY: Record<string, { text: string; tone: "ok" | "warn" | "crit" | "idle" }> = {
  delivered: { text: "已投递", tone: "ok" },
  read: { text: "已读", tone: "ok" },
  pending: { text: "待投递", tone: "warn" },
  expired: { text: "已过期", tone: "crit" },
  failed: { text: "失败", tone: "crit" },
  undeliverable: { text: "不可达", tone: "crit" },
};
const deliveryOf = (s?: string | null) => (s && DELIVERY[s] ? DELIVERY[s] : { text: "n/a", tone: "idle" as const });
const kindOf = (s?: string | null) => (s ? KIND_LABEL[s] || s : "n/a");

function chipClass(tone: "ok" | "warn" | "crit" | "idle"): string {
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
  const ss = String(d.getSeconds()).padStart(2, "0");
  return mm + "-" + dd + " " + hh + ":" + mi + ":" + ss;
}

export default function MessagesPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [status, setStatus] = useState<MacsStatus | null>(null);
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [convCount, setConvCount] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<MessageRow[] | null>(null);
  const [msg24h, setMsg24h] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [measuredAt, setMeasuredAt] = useState("");
  const [convAsOf, setConvAsOf] = useState("");
  const [statusAsOf, setStatusAsOf] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const [sr, cr, mr, wr] = await Promise.all([
        fetch("/api/macs-status", { cache: "no-store" }),
        fetch("/api/macs/conversations", { cache: "no-store" }),
        fetch("/api/macs/manage?limit=50", { cache: "no-store" }).catch(() => null),
        fetch("/api/macs/manage?since=24&limit=1", { cache: "no-store" }).catch(() => null),
      ]);
      if ([sr, cr].some((r) => r.status === 401 || r.status === 403) || (mr !== null && (mr.status === 401 || mr.status === 403))) {
        setPhase("forbidden");
        return;
      }
      if (mr === null) {
        setErr("消息行读取接口请求失败（网络异常或超时）");
        setPhase("error");
        return;
      }
      if (!sr.ok || !cr.ok) {
        setErr("读取接口返回状态码 就绪探测 " + sr.status + " / 会话列表 " + cr.status);
        setPhase("error");
        return;
      }
      const sj = (await sr.json()) as MacsStatus;
      const cj = (await cr.json()) as ConversationsPayload;
      setStatus(sj);
      setStatusAsOf(sj.asOf || "");
      if (sj.ready !== true) {
        setErr(sj.reason || "消息库尚未就绪");
        setPhase("unavailable");
        return;
      }
      if (!cj || cj.ok !== true) {
        setErr(cj && cj.reason ? cj.reason : "会话列表不可得");
        setPhase("unavailable");
        return;
      }
      setConvs(Array.isArray(cj.conversations) ? cj.conversations : []);
      setConvCount(typeof cj.count === "number" ? cj.count : null);
      setConvAsOf(cj.asOf || "");
      if (wr && wr.ok) {
        const wj = (await wr.json()) as ManagePayload;
        setMsg24h(typeof wj.total === "number" ? wj.total : null);
      } else {
        setMsg24h(null);
      }
      setMeasuredAt(new Date().toISOString());
      if (!mr.ok) {
        setErr("消息行读取接口返回状态码 " + mr.status);
        setPhase("error");
        return;
      }
      const mj = (await mr.json()) as ManagePayload;
      if (mj && mj.ok === false) {
        setErr(mj.reason || "消息行不可得");
        setPhase("unavailable");
        return;
      }
      setMsgs(Array.isArray(mj.messages) ? mj.messages : []);
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

  const participants = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const c of convs || []) map[c.id] = Array.isArray(c.participants) ? c.participants : [];
    return map;
  }, [convs]);

  const allRows = msgs || [];
  const kw = q.trim().toLowerCase();
  const rows = kw
    ? allRows.filter((m) => [m.conversation, m.conversationId, m.from, m.type]
        .some((v) => String(v || "").toLowerCase().includes(kw)))
    : allRows;
  const loading = phase === "loading";

  /** 接收方：取会话参与方里除发送方以外的成员。自身会话（参与方与发送方是同一智能体）
   *  没有独立接收方 —— 显式写「自身会话」，不写具体的某个名字，也不留空。 */
  const receiverOf = (m: MessageRow): { text: string; self: boolean } | null => {
    const ps = participants[m.conversationId] || [];
    const to = ps.filter((p) => p && p !== m.from);
    if (to.length) return { text: to.join("、"), self: false };
    if (ps.length && ps.every((p) => p === m.from)) return { text: "自身会话", self: true };
    return null;
  };

  return (
    <main className="page" data-slot="messages-page">
      <PageHeader>
        <PageTitle>消息</PageTitle>
        <div className="page-subtitle">频道消息流与投递状态；发送在会话内完成，本页只读。</div>
      </PageHeader>

      <PageSearch value={q} onChange={setQ} placeholder="搜索频道 / 会话 / 发送方 / 类型…" />

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>服务</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.toolbarRow}>
        <div className={styles.segTabs} role="group" aria-label="消息视图">
          <span className={styles.segTabOn}>频道消息</span>
          <Link className={styles.segTab} href="/messages/manage">跨会话管理 →</Link>
          <Link className={styles.segTab} href="/messages/failed">未送达消息 →</Link>
        </div>
        <span className={styles.hint}>只读（发送在会话内）</span>
      </div>

      <div className={styles.kpis} data-slot="messages-kpis">
        <KpiCard
          label="消息数（24h）"
          value={loading ? "…" : typeof msg24h === "number" ? fmtNum(msg24h) : "n/a"}
          hint={loading ? "读取中" : typeof msg24h === "number" ? "窗口类指标 · 测量时刻见页脚" : "24h 计数不可得"}
          asOf={measuredAt || null}
        />
        <KpiCard
          label="频道"
          value={loading ? "…" : typeof convCount === "number" ? fmtNum(convCount) : "n/a"}
          hint={loading ? "读取中" : typeof convCount === "number" ? "会话行数（接口返回）" : "会话列表不可得"}
          asOf={convAsOf || null}
        />
        <KpiCard label="投递成功" value="n/a" hint="无投递成功率口径（字典未登记）；逐条投递状态见下表" />
        <KpiCard label="平均延迟" value="n/a" hint="无延迟埋点，不编数字" />
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>频道消息流</h2>
            <p className={styles.sub}>时间 / 频道 / 发送方 / 接收方 / 类型 / 投递 · 最近 {rows.length || "n/a"} 条</p>
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
              当前账号没有查看消息的读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。
            </p>
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
            <b className={styles.stateTitle}>消息数据未就绪</b>
            <p className={styles.stateText}>{err || "消息库尚未就绪"} · 本页不展示示例数据，也不把不可得写成 0。</p>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.stateMini}>消息库已连通，但当前没有消息行（接口正常返回空集）。</div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>频道</th>
                  <th>发送方</th>
                  <th>接收方</th>
                  <th>类型</th>
                  <th>投递</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const d = deliveryOf(m.transport);
                  const to = receiverOf(m);
                  return (
                    <tr key={m.id}>
                      <td className={styles.monoCell}>{fmtShort(m.at)}</td>
                      <td>
                        <span className={styles.name}>{m.conversation || m.conversationId || "—"}</span>
                        <span className={styles.subCell}>{m.conversationId}</span>
                      </td>
                      <td className={styles.monoCell}>{m.from || "—"}</td>
                      <td>
                        {to ? (
                          to.self ? <span className={styles.naCell} title="会话参与方与发送方为同一智能体">{to.text}</span> : to.text
                        ) : (
                          <span className={styles.naCell} title="会话参与方里没有第二方">n/a</span>
                        )}
                      </td>
                      <td>{kindOf(m.type)}</td>
                      <td><span className={chipClass(d.tone)}>{d.text}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.foot}>
          <DataMoment items={[{ label: "消息库", at: statusAsOf }, { label: "会话列表", at: convAsOf }, { label: "24h 计数", at: measuredAt }]} />
          {" · 来源：通信服务消息库（只读）"}
        </p>
      </section>
    </main>
  );
}
