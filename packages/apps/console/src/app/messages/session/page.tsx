"use client";
// 0.5.1 B3-2 /messages/session · Bento（2026-11-15，设计 设计 B3-BENTO-DESIGN f21608cf/4debd9d2d）
// SLOT-MAP：页头 s12 → KPI 4×s3 → s8 会话列表 + s4 状态/传输 → s12 本线未确认消息 → s12 相关视图。
// 只读：0.5.1 只验 GET 可读性；session/sync（POST 写接口）不渲染。
// 数据：overview（total/online/stale/pending_count）、conversations?limit（items/next_cursor）、
//   agent-level（count=返回条数）、session-inbox?limit（count/pendingDelivery/ackedTotal/seenTotal/asOf/wake）。
// 三坑：① stale=total 属阈值口径（非 bug）② next_cursor=null 才是到底 ③ pendingDelivery ≠ count 必须分名。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "empty" | "error" | "unavailable";
interface ErrSrc { endpoint: string; status?: number; text: string }
interface Snap { overview: any; conversations: any; inbox: any; agentLevel: any; errors: ErrSrc[] }

const SH = "Asia/Shanghai";
const bj = (v?: string | null, why = "接口未返回时间"): string =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false, timeZone: SH }) : "n/a（" + why + "）";
// 列表里用短时刻（s8 只有 784px，8 列要放得下；完整时刻放 title）
const bjShort = (v?: string | null): string =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false, timeZone: SH, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "n/a";
const num = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "";
const NA = (why: string) => "n/a（" + why + "）";

const TRANSPORT_LABEL: Record<string, string> = {
  queued: "排队", delivered: "已送达", read: "已读", failed: "未送达", expired: "已过期", pending: "传输中",
};
const PROCESS_LABEL: Record<string, string> = {
  pending: "未处理", delivered: "已送达", read: "已读未回", replied: "已回复",
  processing: "处理中", queued: "排队", brain_timeout: "处理超时", rate_limited: "限流等待",
};
const toneOf = (s?: string | null): "ok" | "warn" | "crit" | "mute" => {
  const v = String(s || "").toLowerCase();
  if (v === "read" || v === "delivered" || v === "replied" || v === "ok") return "ok";
  if (v === "failed" || v === "expired" || v === "brain_timeout") return "crit";
  if (!v) return "mute";
  return "warn";
};
const stateLabel = (delivery?: string | null, processing?: string | null): string => {
  const d = String(delivery || "").toLowerCase();
  const p = String(processing || "").toLowerCase();
  if (p === "processing") return "处理中";
  return TRANSPORT_LABEL[d] || PROCESS_LABEL[d] || d || "n/a";
};

function Kpi({ label, value, hint, naReason }: { label: string; value?: string; hint?: string; naReason?: string }) {
  return (
    <section className={styles.kpiCard + " " + styles.slotS3}>
      <div className={styles.kpiLabel}>{label}</div>
      {value ? <div className={styles.kpiValue}>{value}</div> : <div className={styles.kpiNa}>n/a</div>}
      <div className={styles.kpiHint}>{value ? hint : (naReason || "接口未返回该字段")}</div>
    </section>
  );
}

function Skel({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.skelBar} data-w={i === 0 ? "70" : i === 1 ? "45" : "88"} />
      ))}
    </>
  );
}

export default function SessionPage() {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const [requestedAt, setRequestedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    setRequestedAt(new Date().toISOString());
    const errors: ErrSrc[] = [];
    const get = async (endpoint: string): Promise<any> => {
      try {
        const r = await fetch(endpoint, { cache: "no-store" });
        if (!r.ok) {
          errors.push({ endpoint, status: r.status, text: "状态码 " + r.status });
          return null;
        }
        const j = await r.json().catch(() => null);
        if (!j) {
          errors.push({ endpoint, text: "回包不是有效数据" });
          return null;
        }
        if (j.ok === false) {
          errors.push({ endpoint, text: "返回不可用" + (j.error ? "：" + j.error : j.reason ? "：" + j.reason : "") });
          return null;
        }
        return j;
      } catch {
        errors.push({ endpoint, text: "网络错误/请求被中断" });
        return null;
      }
    };
    const [overview, conversations, inbox, agentLevel] = await Promise.all([
      get("/api/macs/session/overview"),
      get("/api/macs/session/conversations?limit=20"),
      get("/api/macs/session-inbox?limit=20"),
      get("/api/macs/session/agent-level?limit=8"),
    ]);
    setSnap({ overview, conversations, inbox, agentLevel, errors });

    const hard = errors.find((e) => typeof e.status === "number" && e.status >= 400);
    if (hard) {
      setErr("接口 " + hard.endpoint + " 请求失败（HTTP " + hard.status + "）");
      setPhase("error");
      return;
    }
    if (!overview) {
      setErr(errors.length
        ? errors.map((e) => "接口 " + e.endpoint + " " + e.text).join("；")
        : "接口 /api/macs/session/overview 未返回数据");
      setPhase("unavailable");
      return;
    }
    const convs = conversations?.conversations || [];
    const sessions = overview?.sessions || [];
    const hasAny = sessions.length > 0 || convs.length > 0 || Number(overview?.total || 0) > 0;
    setPhase(hasAny ? "ok" : "empty");
  }, []);

  useEffect(() => { void load(); }, [load, tick]);

  const overview = snap?.overview || null;
  const conversations = snap?.conversations || null;
  const inbox = snap?.inbox || null;
  const agentLevel = snap?.agentLevel || null;
  const convs: any[] = conversations?.conversations || [];
  const inboxItems: any[] = inbox?.items || [];
  const sourceErrs = snap?.errors || [];

  const errOf = (endpoint: string) => sourceErrs.find((e) => e.endpoint === endpoint);
  const overviewErr = errOf("/api/macs/session/overview");
  const conversationsErr = errOf("/api/macs/session/conversations?limit=20");
  const inboxErr = errOf("/api/macs/session-inbox?limit=20");
  const agentLevelErr = errOf("/api/macs/session/agent-level?limit=8");

  const total = overview?.total;
  const online = overview?.online;
  const stale = overview?.stale;
  const pendingCount = overview?.pending_count;

  const moment = phase === "loading"
    ? "数据时刻：读取中…"
    : overview
      ? "数据时刻：取数请求时刻 " + bj(requestedAt, "n/a") + " · overview n/a（接口未下发 asOf）· watcher 镜像 " + bj(inbox?.asOf, "接口未下发 asOf")
      : "数据时刻：n/a（overview 接口不可用）";

  return (
    <div className="layout-with-sidebar">
      <main className={"main " + styles.b2main}>
        <h1 className={styles.srOnly}>会话详情</h1>
        <div className="breadcrumb">
          <span className={styles.crumbDim}>服务</span><span className="sep">/</span>
          <span className={styles.crumbDim}>消息</span><span className="sep">/</span>
          <span className="current">会话</span>
        </div>
        <PageHeader>
          <PageTitle>会话详情</PageTitle>
          <div className="page-subtitle">单会话的消息流与投递状态</div>
          <div className={styles.chips} aria-label="页面层级">
            <span>#</span><span>服务</span><span>消息</span><span className={styles.crumbOn}>只读</span>
          </div>
        </PageHeader>
        <div className={styles.momentRow}>{moment}</div>
        <div className={styles.toolbar}>
          <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>刷新</button>
          <span className={styles.toolbarNote}>只读视图：0.5.1 不提供同步（sync）入口；写接口为 POST，不在本版本验收范围。</span>
        </div>

        {phase === "loading" && (
          <div className={styles.b2grid} aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <section key={i} className={styles.kpiCard + " " + styles.slotS3}>
                <div className={styles.kpiLabel}>读取中…</div>
                <div className={styles.skelBar} data-w="60" />
                <div className={styles.skelBar} data-w="40" />
              </section>
            ))}
            <section className={styles.panelCard + " " + styles.slotS8}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>会话列表</div></div>
              <Skel rows={5} />
            </section>
            <section className={styles.panelCard + " " + styles.slotS4}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>状态与传输</div></div>
              <Skel rows={4} />
            </section>
          </div>
        )}

        {phase === "error" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle} data-tone="warn">会话数据加载失败</div>
              <p className={styles.stateText}>{err}。请确认通信服务与只读库可用后重试。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "unavailable" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle} data-tone="warn">会话数据不可用</div>
              <p className={styles.stateText}>{err}。这不等于「0 个会话」，属数据不可得（分块 n/a）。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "empty" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle}>暂无会话</div>
              <p className={styles.stateText}>跨线聚合与按线会话列表均返回空集；不写 0 当结论，可稍后刷新。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "ok" && (
          <div className={styles.b2grid}>
            <Kpi
              label="会话总量"
              value={typeof total === "number" ? num(total) : ""}
              hint="overview.total（跨线聚合）"
              naReason={overviewErr ? "overview：" + overviewErr.text : "接口未返回 overview.total"}
            />
            <Kpi
              label="在线"
              value={typeof online === "number" ? num(online) : ""}
              hint="online ≠ running；stale 另计"
              naReason={overviewErr ? "overview：" + overviewErr.text : "接口未返回 overview.online"}
            />
            <Kpi
              label="陈旧"
              value={typeof stale === "number" ? num(stale) : ""}
              hint={"stale=total 属阈值口径（" + (typeof total === "number" ? num(total) : "n/a") + " 条全部在 stale 阈值外），非 bug"}
              naReason={overviewErr ? "overview：" + overviewErr.text : "接口未返回 overview.stale"}
            />
            <Kpi
              label="待处理"
              value={typeof pendingCount === "number" ? num(pendingCount) : ""}
              hint="overview.pending_count（跨线待处理）"
              naReason={overviewErr ? "overview：" + overviewErr.text : "接口未返回 overview.pending_count"}
            />

            <section className={styles.panelCard + " " + styles.slotS8}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.panelTitle}>会话列表</div>
                  <div className={styles.panelSub}>
                    按最近消息降序 · 返回 {num(convs.length)} 条 ·{" "}
                    {conversations ? (conversations.next_cursor === null ? "已到底（next_cursor=null）" : "未到底（next_cursor 非空；0.5.1 只读不翻页）") : "n/a（接口不可用）"}
                  </div>
                </div>
              </div>
              {!conversations ? (
                <p className={styles.stateText}>{NA("会话列表接口不可用" + (conversationsErr ? "：" + conversationsErr.text : ""))}</p>
              ) : convs.length ? (
                <>
                  <div className={styles.tableScroll}>
                    <table className={"tbl " + styles.compact}>
                      <thead>
                        <tr>
                          <th>会话</th><th>参与者</th><th>最后消息</th><th>两态</th><th>未读/提及</th><th>待处理</th><th>认领</th><th>时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {convs.map((c, i) => {
                          const lm = c.last_message || null;
                          return (
                            <tr key={c.conversation_id || "row-" + i}>
                              <td><span className={"mono " + styles.clipXs} title={c.conversation_id || ""}>{c.conversation_id || NA("接口未返回会话编号")}</span></td>
                              <td><span className={styles.clipPart} title={(c.participant_display || []).join(" ↔ ")}>{(c.participant_display || []).length ? (c.participant_display || []).join(" ↔ ") : NA("接口未返回参与者")}</span></td>
                              <td><span className={styles.clipSm} title={lm?.text || ""}>{lm?.text ? String(lm.text).slice(0, 80) : NA("该会话无最后消息")}</span></td>
                              <td>
                                <span className={styles.pill} data-tone={toneOf(lm?.transport_status)}>{TRANSPORT_LABEL[String(lm?.transport_status || "")] || lm?.transport_status || "n/a"}</span>{" "}
                                <span className={styles.pill}>{PROCESS_LABEL[String(lm?.processing_state || "")] || lm?.processing_state || "n/a"}</span>
                              </td>
                              <td className="num">{num(c.unread_count)} / {num(c.mention_count)}</td>
                              <td className="num">{typeof c.pending_count === "number" ? num(c.pending_count) : NA("接口未返回")}</td>
                              <td><span className={"mono " + styles.clipXs} title={c.claim?.session_id || ""}>{c.claim?.session_id || "—"}</span></td>
                              <td><span className={"mono " + styles.nowrapCell} title={bj(c.last_event_at || lm?.created_at)}>{bjShort(c.last_event_at || lm?.created_at)}</span></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className={styles.stateFoot}>游标口径：next_cursor=null 才是到底（不按数组长度判断）；「—」= 该字段接口未返回。</p>
                </>
              ) : (
                <p className={styles.stateText}>无会话（接口正常返回，conversations 为空集）</p>
              )}
            </section>

            <section className={styles.panelCard + " " + styles.slotS4}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>状态与传输</div></div>
              <div className={styles.kvGroup}>
                <div className={styles.kvTitle}>watcher 镜像（本线未确认）</div>
                {inbox ? (
                  <ul className={styles.kv}>
                    <li><span>镜像时刻</span><b>{bj(inbox.asOf, "接口未下发 asOf")}</b></li>
                    <li><span>本线未确认</span><b>{num(inbox.count)} 条</b></li>
                    <li><span>传输层待投递</span><b>{num(inbox.pendingDelivery)}</b></li>
                    <li><span>已确认读取</span><b>{typeof inbox.ackedTotal === "number" ? num(inbox.ackedTotal) : NA("接口未返回 ackedTotal")}</b></li>
                    <li><span>已见累计</span><b>{typeof inbox.seenTotal === "number" ? num(inbox.seenTotal) : NA("接口未返回 seenTotal")}</b></li>
                  </ul>
                ) : <p className={styles.stateText}>{NA("watcher 镜像不可用" + (inboxErr ? "：" + inboxErr.text : ""))}</p>}
              </div>
              <div className={styles.kvGroup}>
                <div className={styles.kvTitle}>实时通道</div>
                {inbox?.wake ? (
                  <ul className={styles.kv}>
                    <li><span>通道</span><b>{inbox.wake.ok === false ? "异常" : inbox.wake.mode === "wake" ? "长轮询" : String(inbox.wake.mode || "n/a")}</b></li>
                    <li><span>最新序号</span><b className="mono">{typeof inbox.wake.latest_seq === "number" ? num(inbox.wake.latest_seq) : NA("接口未返回")}</b></li>
                    <li><span>唤醒时刻</span><b>{bj(inbox.wake.last_wake_at, "接口未返回唤醒时刻")}</b></li>
                    <li><span>未读</span><b>{typeof inbox.wake.unread_count === "number" ? num(inbox.wake.unread_count) : NA("接口未返回")}</b></li>
                    {inbox.wake.error ? <li><span>最近异常</span><b>上游拉取失败（详见控制台）</b></li> : null}
                  </ul>
                ) : <p className={styles.stateText}>{NA("实时通道状态不可用")}</p>}
              </div>
              <div className={styles.kvGroup}>
                <div className={styles.kvTitle}>同智能体最近消息</div>
                <ul className={styles.kv}>
                  <li><span>返回条数</span><b>{agentLevel && typeof agentLevel.count === "number" ? num(agentLevel.count) + " 条" : NA("接口未返回 count")}</b></li>
                  <li><span>口径</span><b>count=返回条数，非会话总消息数</b></li>
                </ul>
                {agentLevelErr ? <p className={styles.stateFoot}>接口不可用：{agentLevelErr.text}</p> : null}
              </div>
              <p className={styles.stateFoot}>
                分名说明：<b>pendingDelivery</b>=传输层待投递（SLO 口径），<b>count</b>=本次返回条数；两者可能不等，本页分名展示，任一缺失写 n/a 不写 0。
              </p>
            </section>

            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.panelTitle}>本线未确认消息</div>
                  <div className={styles.panelSub}>watcher 镜像 · 只读 · 共 {num(inboxItems.length)} 条（摘要+状态）</div>
                </div>
              </div>
              {!inbox ? (
                <p className={styles.stateText}>{NA("本线未确认消息接口不可用" + (inboxErr ? "：" + inboxErr.text : ""))}</p>
              ) : inboxItems.length ? (
                <ul className={styles.itemList}>
                  {inboxItems.map((m, i) => (
                    <li key={m.message_id || "item-" + i} className={styles.itemRow}>
                      <span className={styles.pill} data-tone={toneOf(m.delivery_status || m.transport_status)}>{stateLabel(m.delivery_status, m.processing_state)}</span>
                      <span className={"mono " + styles.itemId}>{m.message_id || NA("接口未返回消息编号")}</span>
                      <span className={styles.itemTime}>{bj(m.created_at)}</span>
                      <span className={styles.itemText}>{m.text ? String(m.text).replace(/\s+/g, " ").slice(0, 160) : NA("接口未返回摘要")}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.stateText}>无未确认（接口正常返回，items 为空集）</p>
              )}
            </section>

            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>相关视图</div></div>
              <div className={styles.related}>
                <Link href="/messages/failed">失败消息 →</Link>
                <Link href="/messages/manage">消息管理 →</Link>
              </div>
              <p className={styles.stateFoot}>{moment} · 来源：跨线聚合 / 会话列表 / 本线镜像 / 同智能体最近消息（只读）</p>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}