"use client";

// /terminals — 0.5 批次C · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → s4 终端会话（表格）→ s8 回放 · 摘要 → 数据时刻。
// 数据：/api/agent-list（执行体清单，只读）；终端回放 / 受控执行没有数据源（数据卡 card-terminals G-03），
//   回放区显示 n/a + 原因，不展示示例回放、不提供执行入口。
// 四态：loading / empty（接口通但确实没有执行体）/ error / forbidden(401/403) / unavailable（无字段/无通道的格）。
// 本页只读：0 写请求、0 执行通道。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface AgentRow {
  agent_id?: string;
  display_name?: string;
  channel?: string;
  host?: string;
  status?: string;
  macsStatus?: string;
  last_seen_at?: string | null;
}
interface ListPayload { asOf?: string; items?: AgentRow[]; sources?: { mind?: number; macs?: number; merged?: number }; _error?: string }

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

function stateLabel(a: AgentRow): string {
  const s = String(a.macsStatus || a.status || "").toUpperCase();
  if (s === "ACTIVE" || s === "ONLINE") return "在线";
  if (s === "OFFLINE") return "离线";
  if (s === "INACTIVE") return "停用";
  return "未知";
}

export default function TerminalsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [items, setItems] = useState<AgentRow[] | null>(null);
  const [sources, setSources] = useState<ListPayload["sources"] | null>(null);
  const [asOf, setAsOf] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const r = await fetch("/api/agent-list", { cache: "no-store" });
      if (r.status === 401 || r.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!r.ok) {
        setErr("执行体清单接口返回状态码 " + r.status);
        setPhase("error");
        return;
      }
      const j = (await r.json()) as ListPayload | AgentRow[];
      const rows = Array.isArray(j) ? j : Array.isArray(j.items) ? j.items : null;
      if (!rows) {
        setErr("执行体清单响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setItems(rows);
      setSources(Array.isArray(j) ? null : j.sources || null);
      setAsOf(Array.isArray(j) ? "" : j.asOf || "");
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

  const rows = items || [];
  const loading = phase === "loading";
  const seen = useMemo(() => rows.filter((r) => !!r.last_seen_at).length, [rows]);
  const merged = sources ? Number(sources.merged) || rows.length : rows.length;
  const mind = sources && typeof sources.mind === "number" ? sources.mind : null;
  const macs = sources && typeof sources.macs === "number" ? sources.macs : null;

  return (
    <main className="page" data-slot="terminals-page">
      <PageHeader>
        <PageTitle>终端</PageTitle>
        <div className="page-subtitle">会话式终端只读回放；受控执行尚未接入（无执行通道），执行体入口按主机与运行状态列出。</div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>工具箱</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.grid} data-slot="terminals-grid">
        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>终端会话</h2>
              <p className={styles.sub}>执行体终端入口{phase === "ok" ? " · 共 " + fmtNum(rows.length) + " 条" : ""}</p>
            </div>
            <span className={styles.tagOk}>只读</span>
          </div>

          {loading ? (
            <div aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={styles.skelRow}>
                  <span className={styles.skel + " " + styles.skelW1} />
                  <span className={styles.skel + " " + styles.skelW2} />
                  <span className={styles.skel + " " + styles.skelW1} />
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
            <div className={styles.state}>
              <b className={styles.stateTitle}>执行体数据不可得</b>
              <p className={styles.stateText}>{err || "读取接口可用，但响应里没有可用数据行。"}</p>
              <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
            </div>
          ) : rows.length === 0 ? (
            <div className={styles.stateMini}>暂无可查看的执行体（接口正常返回空集）。</div>
          ) : (
            <div className={styles.tblWrap}>
              <table className={styles.tbl}>
                <thead>
                  <tr>
                    <th>会话</th>
                    <th>主机</th>
                    <th>状态</th>
                    <th>最近活跃</th>
                    <th>关联会话</th>
                    <th>时长</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.agent_id || i}>
                      <td>
                        <Link className={styles.nameLink} href={"/terminals/detail?agent_id=" + encodeURIComponent(String(r.agent_id || ""))}>
                          {r.display_name || r.agent_id || "n/a"}
                        </Link>
                        <span className={styles.subCell}>{r.agent_id || "n/a"}</span>
                      </td>
                      <td className={styles.monoCell}>{r.host || "n/a"}</td>
                      <td>{stateLabel(r)}</td>
                      <td className={styles.monoCell}>{r.last_seen_at ? fmtTime(r.last_seen_at) : <span className={styles.naCell}>n/a（该执行体未上报）</span>}</td>
                      <td><span className={styles.naCell} title="终端会话层未接入：无关联会话字段">n/a</span></td>
                      <td><span className={styles.naCell} title="无终端会话时长字段">n/a</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className={styles.foot}>执行体状态来自名册与通信服务两套值域，逐行标源、不汇总成「在线数」（G-01）。</p>
        </section>

        <section className={styles.card + " " + styles.s8}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>回放 · 摘要</h2>
              <p className={styles.sub}>只读回放与受控执行均未接入（G-03）；本卡先给可核的清单摘要</p>
            </div>
            <span className={styles.tagPlanned}>未接入</span>
          </div>

          <div className={styles.statGrid}>
            <div className={styles.statCell}>
              <span className={styles.statKey}>执行体数</span>
              <b className={styles.statVal}>{loading ? "…" : phase === "ok" ? fmtNum(rows.length) : "n/a"}</b>
              <span className={styles.statHint}>合并视图（去重后）</span>
            </div>
            <div className={styles.statCell}>
              <span className={styles.statKey}>来源分布</span>
              <b className={styles.statVal}>{loading ? "…" : mind !== null && macs !== null ? fmtNum(mind) + " / " + fmtNum(macs) : "n/a"}</b>
              <span className={styles.statHint}>名册 / 通信服务（可重复，去重后 {fmtNum(merged)}）</span>
            </div>
            <div className={styles.statCell}>
              <span className={styles.statKey}>最近活跃有值</span>
              <b className={styles.statVal}>{loading ? "…" : phase === "ok" ? fmtNum(seen) + " / " + fmtNum(rows.length) : "n/a"}</b>
              <span className={styles.statHint}>空值显示 n/a，不写 0</span>
            </div>
            <div className={styles.statCell}>
              <span className={styles.statKey}>回放片段</span>
              <b className={styles.statVal + " " + styles.naCell}>n/a</b>
              <span className={styles.statHint}>无执行通道 / 无回放数据源</span>
            </div>
          </div>

          <div className={styles.noteWarn}>
            回放与受控执行没有数据源（G-03）：本页不提供「执行命令 / 下发 / 重跑」入口，也不展示示例终端输出。
            终端执行若将来开放，须在配置页 + 独立数据卡签字后另立页面。
          </div>

          <p className={styles.foot}>
            <DataMoment items={[{ label: "执行体清单", at: asOf }]} />
            {" · 来源：智能体合并清单（只读）"}
          </p>
        </section>
      </div>
    </main>
  );
}
