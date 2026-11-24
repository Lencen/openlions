"use client";
// 0.5.1 B3-3 /terminals/detail · Bento（2026-11-15，设计 设计 B3-BENTO-DESIGN f21608cf/4debd9d2d）
// SLOT-MAP：页头 s12 → s12 终端摘要（s8 产物/来源 + s4 警告）→ s12 块内容 → s12 相关视图。
// 只读：0.5.1 只验 GET 可读性；本页没有任何写入口。
// 数据：GET /api/terminal-detail?agent_id=<id>（asOf/build_id/provenance_count/provenance[]/blocks/warnings[]）。
// 三坑：① 缺 agent_id 接口返回 400（不是 200 空态）→ 单独 no-id 态；② blocks/provenance 是大对象，页面截断须标「已截断」；
//   ③ warnings 非空必须显式提示（不静默）。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

type Phase = "loading" | "no-id" | "ok" | "empty" | "error" | "unavailable";

interface Block { status?: string; reason?: string; [k: string]: unknown }
interface Resp {
  ok?: boolean; error?: string; asOf?: string; build_id?: string; provenance_count?: number;
  provenance?: Record<string, string>; agent_id?: string; blocks?: Record<string, Block>;
  warnings?: string[]; pending?: unknown[];
}

const SH = "Asia/Shanghai";
const bj = (v?: string | null, why = "接口未下发 asOf"): string =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false, timeZone: SH }) : "n/a（" + why + "）";
const NA = (why: string) => "n/a（" + why + "）";

const blockStatus = (b?: Block): { label: string; tone: "ok" | "warn" | "mute" } => {
  const s = String(b?.status || "unknown");
  if (s === "ok") return { label: "已接入", tone: "ok" };
  if (s === "partial") return { label: "部分", tone: "warn" };
  return { label: "未知", tone: "mute" };
};

function Skel({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.skelBar} data-w={i === 0 ? "70" : i === 1 ? "45" : "88"} />
      ))}
    </>
  );
}

export default function TerminalDetailPage() {
  // 本页是客户端组件：App Router 的 client page 拿不到 searchParams prop，必须从 location 读
  const [agentId, setAgentId] = useState<string | null>(null);
  const [data, setData] = useState<Resp | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    try {
      const id = (new URLSearchParams(window.location.search).get("agent_id") || "").trim();
      setAgentId(id);
    } catch {
      setAgentId("");
    }
  }, []);

  const load = useCallback(async (id: string) => {
    setPhase("loading");
    setErr("");
    try {
      const r = await fetch("/api/terminal-detail?agent_id=" + encodeURIComponent(id), { cache: "no-store" });
      if (r.status === 404) {
        setErr("接口 /api/terminal-detail 未找到该智能体终端（HTTP 404）");
        setPhase("empty");
        return;
      }
      if (!r.ok) {
        setErr("接口 /api/terminal-detail 请求失败（HTTP " + r.status + "）");
        setPhase("error");
        return;
      }
      const j: Resp = await r.json();
      if (j?.ok === false) {
        setErr("接口 /api/terminal-detail 返回不可用：" + (j.error || "上游未就绪"));
        setPhase("unavailable");
        return;
      }
      setData(j);
      setPhase(Object.keys(j.blocks || {}).length ? "ok" : "empty");
    } catch {
      setErr("接口 /api/terminal-detail 请求失败（网络错误/请求被中断）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (agentId === null) return;
    if (!agentId) { setPhase("no-id"); return; }
    void load(agentId);
  }, [agentId, tick, load]);

  const blocks = data?.blocks || {};
  const blockRows = Object.entries(blocks);
  const provenanceRows = Object.entries(data?.provenance || {});
  const warnings: string[] = Array.isArray(data?.warnings) ? (data.warnings as string[]) : [];
  const buildId = data?.build_id && data.build_id !== "unknown" ? data.build_id : "";
  const provenanceCount = typeof data?.provenance_count === "number" ? data.provenance_count : provenanceRows.length;
  const moment = "编号：" + (agentId || "n/a（未提供）") + " · 数据时刻：" +
    (phase === "loading" ? "读取中…" : bj(data?.asOf, "接口未下发 asOf"));

  return (
    <div className="layout-with-sidebar">
      <main className={"main " + styles.b2main}>
        <h1 className={styles.srOnly}>终端详情</h1>
        <div className="breadcrumb">
          <span className={styles.crumbDim}>工具</span><span className="sep">/</span>
          <span className={styles.crumbDim}>终端</span><span className="sep">/</span>
          <span className="current">详情</span>
        </div>
        <PageHeader>
          <PageTitle>终端详情</PageTitle>
          <div className="page-subtitle">单智能体终端的产物、来源与块内容（只读）</div>
          <div className={styles.chips} aria-label="页面层级">
            <span>#</span><span>终端</span><span>详情</span><span className={styles.crumbOn}>只读</span>
          </div>
        </PageHeader>
        <div className={styles.momentRow}>{moment}</div>
        <div className={styles.toolbar}>
          <button type="button" className="btn" onClick={() => setTick((n) => n + 1)} disabled={phase === "no-id" || agentId === null}>刷新</button>
          <span className={styles.toolbarNote}>只读视图：本页没有写入口；数据来自终端详情聚合接口。</span>
        </div>

        {phase === "no-id" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle} data-tone="warn">缺少终端标识</div>
              <p className={styles.stateText}>
                本页必须带 agent_id 参数；接口缺参返回 400（不是 200 空态）。请从终端列表点进详情。
              </p>
              <Link className="btn" href="/terminals">返回终端列表</Link>
            </div>
          </section>
        )}

        {phase === "loading" && (
          <div className={styles.b2grid} aria-busy="true">
            <section className={styles.panelCard + " " + styles.slotS8}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>终端摘要</div></div>
              <Skel rows={4} />
            </section>
            <section className={styles.panelCard + " " + styles.slotS4}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>警告</div></div>
              <Skel rows={3} />
            </section>
            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>块内容</div></div>
              <Skel rows={6} />
            </section>
          </div>
        )}

        {phase === "error" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle} data-tone="warn">终端详情加载失败</div>
              <p className={styles.stateText}>{err}。请确认只读库与终端详情接口可用后重试。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "unavailable" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle} data-tone="warn">终端详情接口不可用</div>
              <p className={styles.stateText}>{err}。这不等于「该终端没有数据」，属数据不可得（分块 n/a）。</p>
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>重试</button>
            </div>
          </section>
        )}

        {phase === "empty" && (
          <section className={styles.panelCard}>
            <div className={styles.stateBody}>
              <div className={styles.stateTitle}>{err.includes("404") ? "该智能体无终端记录" : "无块内容"}</div>
              <p className={styles.stateText}>
                {err.includes("404")
                  ? err + "。可返回终端列表确认编号。"
                  : "接口正常返回，但 blocks 为空集；不写 0 当结论。"}
              </p>
              <Link className="btn" href="/terminals">返回终端列表</Link>
            </div>
          </section>
        )}

        {phase === "ok" && (
          <div className={styles.b2grid}>
            <section className={styles.panelCard + " " + styles.slotS8}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.panelTitle}>终端摘要（产物与来源）</div>
                  <div className={styles.panelSub}>产物标识用于回溯「这份读数来自哪次构建」；来源声明为摘要</div>
                </div>
              </div>
              <ul className={styles.kv}>
                <li><span>智能体标识</span><b className="mono">{data?.agent_id || agentId || NA("接口未返回 agent_id")}</b></li>
                <li>
                  <span>产物标识</span>
                  {/* build_id = console 构建号（3004 形如 WMQZGj-_…，随 hotpatch 变），不是终端产物 id。
                      3107 dev 环境该值为 unknown（dev 未注入 console 构建号）——按运营团队 2026-11-15 口径：
                      有值 -> 显示并标「console 构建」；unknown/缺失 -> n/a + 原因；不得直渲 unknown、不得当终端产物。 */}
                  <b className="mono">{buildId ? buildId + "（console 构建）" : NA("dev 未注入 console 构建号")}</b>
                </li>
                <li>
                  <span>来源声明条数</span>
                  <b>{typeof data?.provenance_count === "number" ? data.provenance_count.toLocaleString("zh-CN") + " 项" : provenanceRows.length + " 项（按 provenance 计数）"}</b>
                </li>
              </ul>
              <div className={styles.subBlock}>
                <div className={styles.kvTitle}>来源摘要（每块一条，已截断）</div>
                {provenanceRows.length ? (
                  <ul className={styles.provList}>
                    {provenanceRows.slice(0, 6).map(([k, v]) => (
                      <li key={k}><span className={styles.provKey}>{k}</span><span className={styles.provVal} title={String(v)}>{String(v)}</span></li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.stateText}>{NA("接口未返回 provenance")}</p>
                )}
                <p className={styles.stateFoot}>
                  已截断：来源共 {provenanceCount} 项，仅展示前 {Math.min(6, provenanceRows.length)} 项；完整来源对象不在页面展开。
                </p>
              </div>
            </section>

            <section className={styles.panelCard + " " + styles.slotS4}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.panelTitle}>警告</div>
                  <div className={styles.panelSub}>非空必须显式提示（不静默）</div>
                </div>
              </div>
              {!Array.isArray(data?.warnings) ? (
                <p className={styles.stateText}>{NA("接口未下发 warnings 字段")}</p>
              ) : warnings.length ? (
                <>
                  <p className={styles.stateText}>
                    共 {warnings.length} 条警告，本页显式列出：
                  </p>
                  <ul className={styles.warnList}>
                    {warnings.map((w, i) => (<li key={i}>{w}</li>))}
                  </ul>
                </>
              ) : (
                <p className={styles.stateText}><span className={styles.pill} data-tone="ok">无警告</span> 接口回包 warnings 为空数组。</p>
              )}
              <p className={styles.stateFoot}>警告条数取自接口 warnings[]；缺失时写 n/a，不当作 0。</p>
            </section>

            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.panelTitle}>块内容</div>
                  <div className={styles.panelSub}>
                    共 {blockRows.length} 块（每块仅摘要状态/原因/字段数）· 已截断：完整块内容不在页面展开
                  </div>
                </div>
              </div>
              {blockRows.length ? (
                <div className={styles.tableScroll}>
                  <table className={"tbl " + styles.tblWide}>
                    <thead>
                      <tr><th>块</th><th>状态</th><th>字段数</th><th>原因</th></tr>
                    </thead>
                    <tbody>
                      {blockRows.map(([name, b]) => {
                        const st = blockStatus(b);
                        const fields = Object.keys(b || {}).filter((k) => k !== "status" && k !== "reason").length;
                        return (
                          <tr key={name}>
                            <td><span className="mono">{name}</span></td>
                            <td><span className={styles.pill} data-tone={st.tone}>{st.label}</span></td>
                            <td className="num">{fields}</td>
                            <td><span className={styles.clip} title={b?.reason || ""}>{b?.reason ? String(b.reason) : "—"}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.stateText}>无块内容（接口正常返回，blocks 为空集）</p>
              )}
              <p className={styles.stateFoot}>
                截断口径：blocks 为大对象，本页只展示块名、接入状态、字段数与原因；块内字段值不在页面展开。
              </p>
            </section>

            <section className={styles.panelCard + " " + styles.slotS12}>
              <div className={styles.panelHead}><div className={styles.panelTitle}>相关视图</div></div>
              <div className={styles.related}>
                <Link href="/terminals">终端列表 →</Link>
                <Link href="/audit">审计 →</Link>
              </div>
              <p className={styles.stateFoot}>{moment} · 来源：GET /api/terminal-detail（只读）</p>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
