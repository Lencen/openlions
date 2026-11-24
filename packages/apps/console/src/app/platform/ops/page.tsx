"use client";

// /platform/ops — 0.5 批E · demo slot 还原（2026-11-13）
// 槽位：页头 + 4 chips → 写操作提示 → cfg-layout（左配置项 / 右详情 + 变更预览 + 写操作约束）→ s12 变更记录。
// 定位：demo 的 flywheel.coverage_threshold（飞轮覆盖率阈值）。当前没有通用配置读接口 → 当前值 n/a + 原因，不填示例值。
// 旁证：/api/ops 的运营数据（24h 调用/失败率/执行体/积压）写进页头 sub，不占槽。
// 四态：loading / empty / error / forbidden(401/403) / unavailable（配置源不可得）。
// 本页只读：写入口未在本批开放（需二次确认 + 审计）。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface OpsCapacity { backlog?: number; inProgress?: number }
interface OpsLlm { calls?: number; failRate?: number | null }
interface OpsPayload { asOf?: string; window?: string; capacity?: OpsCapacity; llm?: OpsLlm; agents?: Array<{ status?: string }>; error?: string }

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

const ANCHOR = { key: "flywheel.coverage_threshold", label: "覆盖率告警阈值", group: "飞轮", desc: "飞轮覆盖率巡检阈值（低于阈值判未达标）。当前无通用配置读接口，值不可得。" };

export default function OpsConfigPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [ops, setOps] = useState<OpsPayload | null>(null);
  const [requestedAt, setRequestedAt] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const r = await fetch("/api/ops", { cache: "no-store" });
      setRequestedAt(new Date().toISOString());
      if (r.status === 401 || r.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!r.ok) {
        setErr("运营数据接口返回状态码 " + r.status);
        setPhase("error");
        return;
      }
      const j = (await r.json()) as OpsPayload;
      if (!j || (!j.capacity && !j.llm)) {
        setErr("运营数据响应里没有可用的数据区");
        setPhase("unavailable");
        return;
      }
      setOps(j);
      setLastOkAt(new Date().toISOString());
      setPhase("ok");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [reloadKey]);

  const loading = phase === "loading";
  const c = (ops && ops.capacity) || {};
  const l = (ops && ops.llm) || {};
  const agentCount = ops && Array.isArray(ops.agents) ? ops.agents.length : undefined;
  const failRate = typeof l.failRate === "number" ? Math.round(l.failRate * 100) : null;

  return (
    <main className="page" data-slot="platform-ops-page">
      <PageHeader>
        <PageTitle>运营配置</PageTitle>
        <div className="page-subtitle">
          平台配置 · {ANCHOR.label}（{ANCHOR.key}）·
          {loading ? " 运营旁证读取中…" : " 运营旁证：24h 模型调用 " + (typeof l.calls === "number" ? fmtNum(l.calls) : "n/a") + (failRate !== null ? " · 失败率 " + failRate + "%" : "") + " · 执行体 " + (typeof agentCount === "number" ? fmtNum(agentCount) : "n/a") + " · 积压 " + (typeof c.backlog === "number" ? fmtNum(c.backlog) : "n/a")}
        </div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级" data-slot="platform-ops-breadcrumb">
        <span className={styles.crumbOn}>#</span>
        <span>平台</span>
        <span>配置</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.noteWarn}>
        平台配置是全站仅两处可写页之一：每次写操作必须 ①变更前后对比 ②二次确认 ③写一条审计（who / when / what / before / after）。
        本页当前只读：写入口未开放；且该配置项目前无读接口，当前值按 n/a 显示，不用示例阈值顶替。
      </div>

      {loading ? (
        <div className={styles.state}>加载中…</div>
      ) : phase === "forbidden" ? (
        <div className={styles.state}>
          <b className={styles.stateTitle}>无权限</b>
          <p className={styles.stateText}>当前账号缺少「平台配置」读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
        </div>
      ) : phase === "error" || phase === "unavailable" ? (
        <div className={styles.state + " " + (phase === "error" ? styles.stateErr : "")}>
          <b className={styles.stateTitle}>{phase === "error" ? "加载失败" : "运营数据不可得"}</b>
          <p className={styles.stateText}>
            {err}。{lastOkAt ? "上次成功：" + fmtTime(lastOkAt) + "。" : "本次尚无成功记录。"}
          </p>
          <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
        </div>
      ) : (
        <>
          <div className={styles.cfgLayout}>
            <aside className={styles.cfgAside}>
              <div className={styles.cfgGroup}>{ANCHOR.group}</div>
              <button type="button" className={styles.cfgItemOn}>
                <span className={styles.cfgK}>{ANCHOR.label}</span>
                <span className={styles.cfgV}>未接入读接口</span>
              </button>
            </aside>

            <div className={styles.cfgMain}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>{ANCHOR.label}</h2>
                    <p className={styles.sub}><span className={styles.mono}>{ANCHOR.key}</span>{ops && ops.window ? " · 运营窗口 " + ops.window : ""}</p>
                  </div>
                  <span className={styles.tagNa}>只读</span>
                </div>
                <dl className={styles.meta}>
                  <dt>当前值</dt><dd><span className={styles.naCell} title="无通用配置读接口">n/a（原因：没有可读该键的配置接口；不填示例阈值）</span></dd>
                  <dt>说明</dt><dd>{ANCHOR.desc}</dd>
                  <dt>风险等级</dt><dd><span className={styles.naCell}>n/a（无该字段）</span></dd>
                  <dt>最后修改</dt><dd><span className={styles.naCell}>n/a（无配置审计读接口）</span></dd>
                </dl>
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>变更预览</h2>
                    <p className={styles.sub}>提交前必须核对 before / after</p>
                  </div>
                  <span className={styles.tagNa}>未提交</span>
                </div>
                <div className={styles.diff}>
                  <div className={styles.diffOld}><span className={styles.diffK}>变更前</span><span className={styles.naCell}>n/a（当前值不可得）</span></div>
                  <div className={styles.diffNew}><span className={styles.diffK}>变更后</span><span className={styles.naCell}>n/a（本页只读，写入口未开放）</span></div>
                </div>
                <div className={styles.auditLine}>审计：who=n/a（未提交） · when=n/a · what=n/a · before=n/a · after=n/a（写入口未开放）</div>
              </section>

              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>写操作约束</h2>
                    <p className={styles.sub}>三道闸门，缺一不可</p>
                  </div>
                  <span className={styles.tagNa}>写入口未开放</span>
                </div>
                <div className={styles.constraintList}>
                  <div className={styles.constraintRow}>① 变更前后对比：提交前必须看到 before / after 两行</div>
                  <div className={styles.constraintRow}>② 二次确认：弹窗复核 + 勾选「我已知晓影响」</div>
                  <div className={styles.constraintRow}>③ 审计：who / when / what / before / after 全量落表，保留 180 天</div>
                </div>
              </section>
            </div>
          </div>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div>
                <h2 className={styles.cardTitle}>变更记录</h2>
                <p className={styles.sub}>时间 / 操作者 / 配置项 / before / after / 结果</p>
              </div>
            </div>
            <div className={styles.tblWrap}>
              <table className={styles.tbl}>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>操作者</th>
                    <th>配置项</th>
                    <th>before</th>
                    <th>after</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={6} className={styles.naCell}>n/a（原因：无配置审计读接口；不给示例记录。）</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className={styles.foot}>
              请求时刻：{requestedAt ? fmtTime(requestedAt) : "n/a"} · 来源：运营数据旁证（只读）· 相关视图：
              <Link className={styles.inlineLink} href="/flywheel">飞轮看板</Link>
              <Link className={styles.inlineLink} href="/system/health">健康检查</Link>
            </p>
          </section>
        </>
      )}
    </main>
  );
}