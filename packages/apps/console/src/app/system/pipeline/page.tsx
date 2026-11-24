"use client";

// /system/pipeline — 0.5 批次C · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → s4 prod / s4 test / s4 sales（环境卡）→ s8 流水线（表格）→ s4 发布窗口（键值）→ 逐源数据时刻。
// 数据：/api/version（部署树平台版本，真实）+ /api/pipeline-history（运行历史，真实）；test / sales 环境版本无对应接口 → n/a + 原因。
// 流水线列按数据卡 card-system-pipeline 的真实字段落（编号/模式/来源/同步/跳过/消息/状态/开始）；环境/版本两列无源不上。
// 四态：loading / empty（接口通但无运行记录）/ error / forbidden(401/403) / unavailable（响应缺数据区）。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import { runModeLabel, sourceTypeLabel, statusLabel } from "@/config/systemLabels";
import styles from "./page.module.css";

interface VersionInfo { deployedPlatform?: string | null; deployedSource?: string | null; readAt?: string; consistent?: boolean }
interface LogRow {
  id: string;
  sourceType: string;
  status: string;
  recordsSynced: number;
  recordsSkipped: number;
  messageCount: number;
  runMode: string;
  startedAt: string;
  completedAt?: string | null;
}
interface HistoryPayload { logs?: LogRow[]; summary?: { total?: number; completed?: number; failed?: number }; asOf?: string }

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

function statusTone(s: string): "ok" | "warn" | "crit" | "idle" {
  if (s === "COMPLETED") return "ok";
  if (s === "FAILED") return "crit";
  if (s === "RUNNING" || s === "PROCESSING") return "warn";
  return "idle";
}
function chipClass(tone: "ok" | "warn" | "crit" | "idle"): string {
  if (tone === "ok") return styles.chipOk;
  if (tone === "warn") return styles.chipWarn;
  if (tone === "crit") return styles.chipCrit;
  return styles.chipIdle;
}
function durOf(l: LogRow): string | null {
  if (!l.startedAt || !l.completedAt) return null;
  const a = new Date(l.startedAt).getTime();
  const b = new Date(l.completedAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const sec = Math.round((b - a) / 1000);
  if (sec < 60) return sec + " 秒";
  return Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒";
}
const when = (v?: string | null) => (v ? fmtTime(v) : "n/a");

export default function PipelinePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [ver, setVer] = useState<VersionInfo | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const [vr, hr] = await Promise.all([
        fetch("/api/version", { cache: "no-store" }).catch(() => null),
        fetch("/api/pipeline-history", { cache: "no-store" }).catch(() => null),
      ]);
      const statuses = [vr, hr].filter((x): x is Response => x !== null).map((x) => x.status);
      if (statuses.some((s) => s === 401 || s === 403)) {
        setPhase("forbidden");
        return;
      }
      if (!hr || !hr.ok) {
        setErr("运行历史接口" + (hr ? "返回状态码 " + hr.status : "请求失败"));
        setPhase("error");
        return;
      }
      if (vr && vr.ok) {
        setVer((await vr.json()) as VersionInfo);
      } else {
        setVer(null);
      }
      const hj = (await hr.json()) as HistoryPayload;
      if (!hj || !Array.isArray(hj.logs)) {
        setErr("运行历史响应里没有数据行");
        setPhase("unavailable");
        return;
      }
      setHistory(hj);
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

  const loading = phase === "loading";
  const logs = history && Array.isArray(history.logs) ? history.logs : [];
  const summary = history && history.summary ? history.summary : null;
  const pageSize = 20;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(logs.length / pageSize));
  const shown = logs.slice(page * pageSize, (page + 1) * pageSize);
  const completed = typeof summary?.completed === "number" ? summary.completed : null;
  const failed = typeof summary?.failed === "number" ? summary.failed : null;

  return (
    <main className="page" data-slot="system-pipeline-page">
      <PageHeader>
        <PageTitle>流水线监控</PageTitle>
        <div className="page-subtitle">开发环境的运行历史与环境版本；只读，重跑与切流不在本页。</div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>服务</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.grid} data-slot="system-pipeline-grid">
        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>prod</h2>
              <p className={styles.sub}>生产 · 部署树版本</p>
            </div>
            <span className={styles.tagOk}>{loading ? "…" : ver && ver.deployedPlatform ? "可读" : "n/a"}</span>
          </div>
          <b className={styles.envValue}>{loading ? "…" : ver && ver.deployedPlatform ? ver.deployedPlatform : "n/a"}</b>
          <p className={styles.envHint}>
            {ver && ver.deployedPlatform ? "来源 " + (ver.deployedSource || "n/a") : "版本接口不可得（不写 0、不借其它环境的值）"}
          </p>
        </section>

        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>test</h2>
              <p className={styles.sub}>测试环境版本</p>
            </div>
            <span className={styles.tagNa}>n/a</span>
          </div>
          <b className={styles.envValue + " " + styles.naCell}>n/a</b>
          <p className={styles.envHint}>无对应接口：环境对齐脚本读 ~ 受目录权限限制，页面不臆测版本号</p>
        </section>

        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>sales</h2>
              <p className={styles.sub}>销售环境版本</p>
            </div>
            <span className={styles.tagNa}>n/a</span>
          </div>
          <b className={styles.envValue + " " + styles.naCell}>n/a</b>
          <p className={styles.envHint}>无对应接口；sales 允许滞后，但本页没有可核的读数字段，故不填值</p>
        </section>

        <section className={styles.card + " " + styles.s8}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>流水线</h2>
              <p className={styles.sub}>
                编号 / 模式 / 来源 / 同步 / 跳过 / 消息 / 状态 / 开始
                {phase === "ok" ? " · 第 " + (page + 1) + "/" + pages + " 页 · 共 " + fmtNum(logs.length) + " 条" : ""}
              </p>
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
              <p className={styles.stateText}>当前账号缺少「开发管理」读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
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
              <b className={styles.stateTitle}>流水线数据不可得</b>
              <p className={styles.stateText}>{err || "接口可用，但响应里没有运行记录数据区。"}</p>
              <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
            </div>
          ) : shown.length === 0 ? (
            <div className={styles.stateMini}>暂无运行记录（接口正常返回空集）。</div>
          ) : (
            <>
              <div className={styles.summaryLine}>
                批次内 成功 {completed !== null ? fmtNum(completed) : "n/a"} · 失败 {failed !== null ? fmtNum(failed) : "n/a"}
                {typeof summary?.total === "number" ? " · 合计 " + fmtNum(summary.total) : ""}
              </div>
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr>
                      <th>编号</th>
                      <th>模式</th>
                      <th>来源</th>
                      <th className={styles.num}>同步</th>
                      <th className={styles.num}>跳过</th>
                      <th className={styles.num}>消息</th>
                      <th>状态</th>
                      <th>耗时</th>
                      <th>开始</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => (
                      <tr key={l.id}>
                        <td className={styles.monoCell}>{String(l.id).slice(0, 12)}</td>
                        <td>{runModeLabel(l.runMode)}</td>
                        <td>{sourceTypeLabel(l.sourceType)}</td>
                        <td className={styles.num}>{fmtNum(l.recordsSynced)}</td>
                        <td className={styles.num}>{fmtNum(l.recordsSkipped)}</td>
                        <td className={styles.num}>{fmtNum(l.messageCount)}</td>
                        <td><span className={chipClass(statusTone(l.status))}>{statusLabel(l.status)}</span></td>
                        <td>{durOf(l) || <span className={styles.naCell}>n/a</span>}</td>
                        <td className={styles.monoCell}>{when(l.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className={styles.pager}>
            <button type="button" className={styles.btn} disabled={page <= 0} onClick={() => setPage((x) => Math.max(0, x - 1))}>上一页</button>
            <span>第 {page + 1}/{pages} 页 · 共 {fmtNum(logs.length)} 条 · 每页 {pageSize} 条</span>
            <button type="button" className={styles.btn} disabled={page >= pages - 1} onClick={() => setPage((x) => Math.min(pages - 1, x + 1))}>下一页</button>
          </div>
          <p className={styles.foot}>
            <DataMoment items={[{ label: "版本", at: ver && ver.readAt ? ver.readAt : null }, { label: "运行历史", at: history && history.asOf ? history.asOf : null }]} />
          </p>
        </section>

        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>发布窗口</h2>
              <p className={styles.sub}>键值 · 无实时数据源</p>
            </div>
          </div>
          <dl className={styles.kv}>
            <dt>下次窗口</dt><dd className={styles.naCell}>n/a（无窗口接口）</dd>
            <dt>预约版本</dt><dd className={styles.naCell}>n/a（无预约记录源）</dd>
            <dt>审批人</dt><dd className={styles.naCell}>n/a（无审批记录源）</dd>
            <dt>变更单</dt><dd className={styles.naCell}>n/a（无变更单源）</dd>
          </dl>
          <p className={styles.foot}>切流需发布单 + 人工确认（流程约定，不是本页实时数据）。相关视图：
            <Link className={styles.inlineLink} href="/system/access-log">访问日志</Link>
            <Link className={styles.inlineLink} href="/system/automation">自动化执行</Link>
            <Link className={styles.inlineLink} href="/system/rotation">轮转记录</Link>
          </p>
        </section>
      </div>
    </main>
  );
}