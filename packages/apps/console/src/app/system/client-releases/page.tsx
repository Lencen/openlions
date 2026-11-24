"use client";

// /system/client-releases — 0.5 批次C · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → 4 KPI（最新版本 / 车队规模 / 版本覆盖 / 强制最低版本）→ s12 提示
//   → s8 发布记录（表格）→ s4 通道与策略（键值）→ s12 客户端实例（表格）→ s12 安装包矩阵（表格）→ 数据时刻。
// 数据：/api/client-releases（发布记录 + 最新版本，真实）；实例（车队）清单、版本覆盖口径、强制最低版本均无源 → n/a + 原因。
// 四态：loading / empty（服务已接入但没有发布记录）/ error / forbidden(401/403) / unavailable（发布服务未接入）。
// 本页只读：发布/切流不在本页，无写按钮。

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, PageTitle, KpiCard } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface Release {
  id?: string;
  version?: string;
  platform?: string;
  arch?: string;
  filename?: string;
  sizeBytes?: number;
  signed?: boolean;
  state?: string;
  channel?: string;
  publishedAt?: string | null;
}
interface Payload {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  channel?: string;
  items?: Release[];
  latest?: Release | null;
  asOf?: string;
}

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

const CHANNEL_LABEL: Record<string, string> = { stable: "稳定通道", beta: "预览通道", archived: "已归档" };
const STATE_LABEL: Record<string, string> = { draft: "草稿", pending_sign: "待签名", signed: "已签名待发布", published: "已发布", deprecated: "已弃用", revoked: "已撤销" };

function fmtSize(n?: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function chipClass(s?: string): string {
  if (s === "published") return styles.chipOk;
  if (s === "revoked") return styles.chipCrit;
  if (s === "deprecated" || s === "pending_sign") return styles.chipWarn;
  return styles.chipIdle;
}

export default function ClientReleasesPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const r = await fetch("/api/client-releases", { cache: "no-store" });
      if (r.status === 401 || r.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!r.ok) {
        setErr("发布记录接口返回状态码 " + r.status);
        setPhase("error");
        return;
      }
      const j = (await r.json()) as Payload;
      setData(j);
      setLastOkAt(new Date().toISOString());
      setPhase(j.available === false ? "unavailable" : "ok");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const loading = phase === "loading";
  const items = data && Array.isArray(data.items) ? data.items : [];
  const sorted = useMemo(() => {
    return items.slice().sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
  }, [items]);
  const recent = sorted.slice(0, 10);
  const latest = (data && data.latest) || sorted[0] || null;
  const signedOk = items.filter((x) => x.signed === true).length;
  const signedUnknown = items.filter((x) => x.signed !== true).length;
  const matrix = useMemo(() => {
    const map: Record<string, { platform: string; arch: string; count: number; latestVersion: string; latestAt: string; state: string }> = {};
    for (const it of sorted) {
      const platform = String(it.platform || "n/a");
      const arch = String(it.arch || "n/a");
      const k = platform + "|" + arch;
      const cur = map[k];
      const at = it.publishedAt ? String(it.publishedAt) : "";
      if (!cur) map[k] = { platform, arch, count: 1, latestVersion: String(it.version || "n/a"), latestAt: at, state: String(it.state || "") };
      else {
        cur.count += 1;
        if (at > cur.latestAt) { cur.latestAt = at; cur.latestVersion = String(it.version || "n/a"); cur.state = String(it.state || ""); }
      }
    }
    return Object.values(map);
  }, [sorted]);

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>客户端管理</PageTitle>
        <div className="page-subtitle">发布记录与安装包矩阵；发布即签名，本页只读，发版与切流走发布单。</div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>平台</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.kpis}>
        <KpiCard
          label="最新版本"
          value={loading ? "…" : latest && latest.version ? latest.version : "n/a"}
          hint={loading ? "读取中" : latest && latest.version ? "通道 " + (CHANNEL_LABEL[String(latest.channel)] || String(latest.channel || "n/a")) + " · 发布 " + (latest.publishedAt ? fmtTime(latest.publishedAt) : "n/a") : "最新版本不可得"}
          asOf={data && data.asOf ? data.asOf : null}
        />
        <KpiCard label="车队规模" value="n/a" hint="实例（车队）清单尚未接入，不编造台数" />
        <KpiCard label="版本覆盖" value="n/a" hint="口径待补（最新版本覆盖按线/环境分布，数据卡 D-03）" />
        <KpiCard label="强制最低版本" value="n/a" hint="无该字段的读接口；不填示例版本号" />
      </div>

      <div className={styles.noteWarn}>
        版本上报与覆盖未全量：未上报只能标「未知」，不能当「旧版」；未签名的包也会出现在发布记录里——「未签名」与「没有这个版本」是两件事。
        {phase === "ok" ? " 当前记录 " + fmtNum(items.length) + " 条，其中已签名 " + fmtNum(signedOk) + " 条" + (signedUnknown ? "、非已签名 " + fmtNum(signedUnknown) + " 条" : "") + "。" : ""}
      </div>

      <div className={styles.grid}>
        <section className={styles.card + " " + styles.s8}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>发布记录</h2>
              <p className={styles.sub}>
                版本 / 通道 / 包格式 / 签名 / 大小 / 发布时间 / 下载
                {phase === "ok" ? " · 最近 " + fmtNum(recent.length) + " 条（共 " + fmtNum(items.length) + "）" : ""}
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
              <p className={styles.stateText}>当前账号缺少「客户端管理」读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
            </div>
          ) : phase === "error" ? (
            <div className={styles.state + " " + styles.stateErr}>
              <b className={styles.stateTitle}>加载失败</b>
              <p className={styles.stateText}>
                {err}。读数暂时取不到，这不代表没有版本；{lastOkAt ? "上次成功：" + fmtTime(lastOkAt) + "。" : "本次尚无成功记录。"}
              </p>
              <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
            </div>
          ) : phase === "unavailable" ? (
            <div className={styles.state}>
              <b className={styles.stateTitle}>发布服务未接入</b>
              <p className={styles.stateText}>{(data && data.reason) || "客户端版本管理服务尚未上线"}。此处不写「暂无数据」，那会被读成「没有发布过任何版本」。</p>
              <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
            </div>
          ) : recent.length === 0 ? (
            <div className={styles.stateMini}>还没有任何发布记录（服务已接入，但没有版本登记）。</div>
          ) : (
            <div className={styles.tblWrap}>
              <table className={styles.tbl}>
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>通道</th>
                    <th>包格式</th>
                    <th>签名</th>
                    <th className={styles.num}>大小</th>
                    <th>发布时间</th>
                    <th className={styles.num}>下载</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id || r.version}>
                      <td className={styles.monoCell}>{r.version || "n/a"}</td>
                      <td><span className={chipClass(r.state)}>{STATE_LABEL[String(r.state || "")] || r.state || "n/a"}</span></td>
                      <td>{[r.platform, r.arch].filter(Boolean).join(" / ") || "n/a"}</td>
                      <td>{r.signed === true ? <span className={styles.chipOk}>已签名</span> : r.signed === false ? <span className={styles.chipCrit}>未签名</span> : <span className={styles.chipIdle}>签名状态未知</span>}</td>
                      <td className={styles.num}>{fmtSize(r.sizeBytes)}</td>
                      <td className={styles.monoCell}>{r.publishedAt ? fmtTime(r.publishedAt) : "n/a"}</td>
                      <td className={styles.num}><span className={styles.naCell} title="无下载计数字段">n/a</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className={styles.foot}>
            <DataMoment items={[{ label: "发布记录", at: data && data.asOf ? data.asOf : null }]} />
          </p>
        </section>

        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>通道与策略</h2>
              <p className={styles.sub}>键值 · 只读</p>
            </div>
          </div>
          <dl className={styles.kv}>
            <dt>当前通道</dt><dd>{loading ? "…" : data && data.channel ? (CHANNEL_LABEL[data.channel] || data.channel) : "n/a"}</dd>
            <dt>通道说明</dt><dd>稳定通道为生产默认升级源；预览通道仅测试机订阅；已归档不再分发（策略说明，非实时数据）</dd>
            <dt>签名</dt><dd>{phase === "ok" ? "已签名 " + fmtNum(signedOk) + " / " + fmtNum(items.length) : "n/a"}（同一把签名钥匙）</dd>
            <dt>强制升级</dt><dd className={styles.naCell}>n/a（低于最低版本 24h 后降级策略无读接口，不写示例阈值）</dd>
            <dt>自更新覆盖</dt><dd className={styles.naCell}>n/a（无覆盖清单字段）</dd>
          </dl>
          <p className={styles.foot}>签名密钥持有者与轮换见运行手册；本页只展示记录。</p>
        </section>

        <section className={styles.card + " " + styles.s12}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>客户端实例</h2>
              <p className={styles.sub}>主机 / 系统 / 智能体 / 版本 / 通道 / 心跳 / 状态</p>
            </div>
            <span className={styles.tagNa}>未接入</span>
          </div>
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>主机</th>
                  <th>系统</th>
                  <th className={styles.num}>智能体</th>
                  <th>版本</th>
                  <th>通道</th>
                  <th>心跳</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={7} className={styles.naCell}>
                    n/a（原因：服务端尚未提供客户端实例清单——主机 / 系统 / 智能体 / 版本 / 心跳 / 状态无字段；不编造实例行。）
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.card + " " + styles.s12}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>安装包矩阵</h2>
              <p className={styles.sub}>平台 / 格式 / 架构 / 状态 / 说明 · 按发布记录聚合</p>
            </div>
          </div>
          {phase === "ok" && matrix.length ? (
            <div className={styles.tblWrap}>
              <table className={styles.tbl}>
                <thead>
                  <tr>
                    <th>平台</th>
                    <th>格式</th>
                    <th>架构</th>
                    <th>状态</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.map((m) => (
                    <tr key={m.platform + m.arch}>
                      <td className={styles.nameCell}>{m.platform}</td>
                      <td>{m.platform.includes("deb") ? "deb" : m.platform.includes("rpm") ? "rpm" : "n/a"}</td>
                      <td>{m.arch}</td>
                      <td><span className={chipClass(m.state)}>{STATE_LABEL[m.state] || m.state || "n/a"}</span></td>
                      <td className={styles.naCell}>
                        最近发布 {m.latestVersion} · {fmtNum(m.count)} 个包；未在发布记录中的平台（如 macOS / Windows）不列，避免示例值冒充
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : phase === "ok" ? (
            <div className={styles.stateMini}>无安装包记录（发布记录为空集）。</div>
          ) : (
            <div className={styles.stateMini}>数据不可得或加载中：{loading ? "读取中…" : "接口未返回发布记录，不列示例平台。"}</div>
          )}
        </section>
      </div>
    </main>
  );
}
