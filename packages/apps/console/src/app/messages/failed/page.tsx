"use client";
// 0.5.1 B3-1 /messages/failed · Bento（2026-11-15，设计 设计 B3-BENTO-DESIGN f21608cf/4debd9d2d）
// SLOT-MAP：页头 s12 → KPI 4×s3 → s8 原因分组 + s4 不可投递说明 → s12 未送达明细 → s12 相关视图。
// 只读：0.5.1 只验 GET 可读性；retry / dlq-replay（POST 写接口）一律不渲染。
// 数据：GET /api/macs/failed?limit=50（summary.expired/failed/queue + messages[] + queue[]）；
//   缺字段一律 n/a+原因，不写 0；queue 是 DLQ **累计行数**（非待办），messages 长度=limit（非总量）。
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "empty" | "error" | "unavailable";

const SH = "Asia/Shanghai";
const bj = (v?: string | null, why = "接口未返回时间"): string =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false, timeZone: SH }) : "n/a（" + why + "）";
const num = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "";

interface FailedSummary { expired?: number; failed?: number; queue?: number }
interface FailedMsg {
  id?: string; conversationId?: string; conversation?: string; from?: string;
  text?: string; transport?: string; brain?: string | null; lastError?: string | null; at?: string | null;
}
interface QueueRow { id?: number; messageId?: string; target?: string; reason?: string | null; at?: string | null }
interface FailedResp { ok?: boolean; reason?: string; error?: string; summary?: FailedSummary | null; messages?: FailedMsg[]; queue?: QueueRow[] }

const transportLabel = (t?: string) => (t === "failed" ? "投递失败" : t === "expired" ? "已过期" : t || "n/a（接口未返回状态）");
const transportTone = (t?: string) => (t === "failed" ? "crit" : t === "expired" ? "warn" : "mute");
const isUndeliverable = (reason?: string | null) => /never delivered|offline\s*>\s*7d/i.test(String(reason || ""));

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

export default function FailedMessagesPage() {
  const [data, setData] = useState<FailedResp | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const r = await fetch("/api/macs/failed?limit=50", { cache: "no-store" });
      if (!r.ok) {
        setErr("接口 /api/macs/failed 请求失败（HTTP " + r.status + "）");
        setPhase("error");
        return;
      }
      const j: FailedResp = await r.json();
      if (j?.ok === false) {
        setErr("接口 /api/macs/failed 返回不可用：" + (j.reason || j.error || "上游未就绪"));
        setPhase("unavailable");
        return;
      }
      setData(j);
      const nMsg = (j.messages || []).length;
      const nQueue = (j.queue || []).length;
      setPhase(nMsg || nQueue ? "ok" : "empty");
    } catch {
      setErr("接口 /api/macs/failed 请求失败（网络错误/请求被中断）");
      setPhase("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load, tick]);

  const summary = data?.summary || null;
  const messages = data?.messages || [];
  const queue = data?.queue || [];

  // queue[] 仅最近 20 条：按 reason 分组，并在组内汇总 target（去重）
  const groups = useMemo(() => {
    const map = new Map<string, { reason: string; count: number; targets: string[]; undeliverable: boolean }>();
    for (const q of queue) {
      const reason = String(q.reason || "");
      const key = reason || "n/a（接口未返回原因）";
      const g = map.get(key) || { reason: key, count: 0, targets: [], undeliverable: false };
      g.count += 1;
      const t = String(q.target || "");
      if (t && !g.targets.includes(t)) g.targets.push(t);
      if (isUndeliverable(reason)) g.undeliverable = true;
      map.set(key, g);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [queue]);

  const moment = "数据时刻：n/a（接口未下发 asOf，取数为请求时刻）· 来源：GET /api/macs/failed（只读）";

  return (
    <div className="layout-with-sidebar">
      <main className={"main " + styles.b2main} data-slot="messages-failed-page">
        <h1 className={styles.srOnly}>失败消息</h1>
        <div className="breadcrumb">
          <span className={styles.crumbDim}>服务</span><span className="sep">/</span>
          <span className={styles.crumbDim}>消息</span><span className="sep">/</span>
          <span className="current">失败</span>
        </div>
        <PageHeader>
          <PageTitle>失败消息</PageTitle>
          <div className="page-subtitle">发送失败与重试记录，按时间倒序</div>
          <div className={styles.chips} aria-label="页面层级">
            <span>#</span><span>服务</span><span>消息</span><span className={styles.crumbOn}>只读</span>
          </div>
        </PageHeader>
        <div className={styles.momentRow}>{moment}</div>
        <div className={styles.toolbar} data-slot="messages-failed-toolbar">
          <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>刷新</button>
          <span className={styles.toolbarNote}>只读视图：0.5.1 不提供重试/重放入口（写接口为 POST，不在本版本验收范围）。</span>
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
            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>未送达明细</div></div>
              <Skel rows={5} />
            </section>
          </div>
        )}

        {phase === "error" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle} data-tone="warn">失败消息加载失败</div>
              <p className={styles.stateText}>{err}。请确认通信服务与只读库可用后重试。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "unavailable" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle} data-tone="warn">失败消息接口不可用</div>
              <p className={styles.stateText}>{err}。这不等于「0 条失败消息」，属数据不可得（分块 n/a）。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "empty" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle}>窗口内无失败消息</div>
              <p className={styles.stateText}>接口正常返回，但 messages 与 queue 均为空；可放宽 limit 或换时间窗再看。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "ok" && (
          <div className={styles.b2grid}>
            <Kpi
              label="投递失败"
              value={summary && typeof summary.failed === "number" ? num(summary.failed) : ""}
              hint="delivery_status=failed 计数（接口 summary.failed）"
              naReason="接口未返回 summary.failed"
            />
            <Kpi
              label="投递过期"
              value={summary && typeof summary.expired === "number" ? num(summary.expired) : ""}
              hint="expired 累计（不含未送达队列）"
              naReason="接口未返回 summary.expired"
            />
            <Kpi
              label="未送达队列"
              value={summary && typeof summary.queue === "number" ? num(summary.queue) : ""}
              hint="DLQ 累计行数，不是待办"
              naReason="接口未返回 summary.queue"
            />
            <Kpi
              label="明细条数"
              value={num(messages.length)}
              hint="接口固定返回 50 条（limit 无效），非总量"
              naReason="接口未返回 messages"
            />

            <section className={styles.panelCard + " " + styles.slotS8}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.panelTitle}>未送达队列原因分组</div>
                  <div className={styles.panelSub}>queue[] 最近 20 条按原因分组；全量累计见上方 KPI（累计行数，非待办）</div>
                </div>
              </div>
              {!summary ? (
                <p className={styles.stateText}>n/a（接口未返回 summary，分块不可得；不写 0）</p>
              ) : groups.length ? (
                <div className={styles.tableScroll}>
                  <table className={"tbl " + styles.tblMin}>
                    <thead>
                      <tr><th>原因</th><th>条数</th><th>目标（去重）</th><th>判定</th></tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.reason}>
                          <td><span className={styles.clip} title={g.reason}>{g.reason}</span></td>
                          <td className="num">{num(g.count)}</td>
                          <td><span className={styles.clip} title={g.targets.join("、")}>{g.targets.length ? g.targets.join("、") : "n/a（接口未返回目标）"}</span></td>
                          <td>
                            <span className={styles.pill} data-tone={g.undeliverable ? "crit" : "warn"}>
                              {g.undeliverable ? "不可投递" : "投递失败"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.stateText}>无分组（接口返回的 queue 为空集）</p>
              )}
              <p className={styles.stateFoot}>注：queue[] 只返回最近 20 条；「offline &gt; 7d never delivered」标记为不可投递——目标长期离线，重投也不会送达。</p>
            </section>

            <section className={styles.panelCard + " " + styles.slotS4}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>过期与不可投递口径</div></div>
              <ul className={styles.noteList}>
                <li><b>过期 expired</b>：超过投递窗口仍未送达，不再自动投递（累计 {summary && typeof summary.expired === "number" ? num(summary.expired) : "n/a（接口未返回）"} 条）。</li>
                <li><b>不可投递</b>：目标离线超过 7 天且从未送达；重试也不会成功，属终态信号。</li>
                <li><b>未送达队列</b>：死信队列累计行数 {summary && typeof summary.queue === "number" ? num(summary.queue) : "n/a（接口未返回）"}，不等于待办/待处理数。</li>
                <li><b>0.5.1 只读</b>：本页不提供重放/重试入口（retry、dlq-replay 为 POST 写接口，未纳入本版本）。</li>
              </ul>
              <p className={styles.stateFoot}>看用途：判断是否需要人工处理；写操作请到通信服务管理端执行。</p>
            </section>

            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.panelTitle}>未送达明细</div>
                  <div className={styles.panelSub}>
                    按时间倒序 · 返回 {num(messages.length)} 条（接口固定返回 50 条（limit 无效），非总量）· 操作列 0.5.1 只读
                  </div>
                </div>
              </div>
              {messages.length ? (
                <div className={styles.tableScroll}>
                  <table className={"tbl " + styles.tblWide}>
                    <thead>
                      <tr>
                        <th>时间</th><th>会话</th><th>发送方</th><th>摘要</th><th>状态</th><th>最后错误</th><th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {messages.map((m, i) => (
                        <tr key={m.id || "row-" + i}>
                          <td><span className={"mono " + styles.nowrapCell}>{bj(m.at)}</span></td>
                          <td><span className={styles.clipConv} title={m.conversation || ""}>{m.conversation || "n/a（接口未返回会话）"}</span></td>
                          <td className={styles.nowrapCell}><span className="mono">{m.from || "n/a（接口未返回发送方）"}</span></td>
                          <td><span className={styles.clipMsg} title={m.text || ""}>{m.text || "n/a（接口未返回摘要）"}</span></td>
                          <td><span className={styles.pill} data-tone={transportTone(m.transport)}>{transportLabel(m.transport)}</span></td>
                          <td><span className={styles.clip} title={m.lastError || ""}>{m.lastError || "—"}</span></td>
                          <td><span className={styles.roCell} title="0.5.1 只读：不提供重试">—</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.stateText}>无失败消息（接口正常返回，messages 为空集）</p>
              )}
              <p className={styles.stateFoot}>「—」= 接口该条未返回最后错误（expired 消息通常无错误码）；本页只读，不渲染重试按钮。</p>
            </section>

            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>相关视图</div></div>
              <div className={styles.related}>
                <Link href="/messages/session">消息工作区 →</Link>
                <Link href="/messages/manage">投递监控 →</Link>
              </div>
              <p className={styles.stateFoot}>{moment}</p>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}