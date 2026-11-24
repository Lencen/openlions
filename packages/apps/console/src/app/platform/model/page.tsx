"use client";

// /platform/model — 0.5 批E · demo slot 还原（2026-11-13）
// 槽位：页头 + 4 chips → 写操作提示 → cfg-layout（左配置项 300px / 右详情 + 变更预览 + 写操作约束）→ s12 变更记录。
// 定位：demo 的 llm.default_model 在真实配置里对应「模型名」（ANTHROPIC_MODEL，默认模型入口）。
// 数据：/api/model-config（键清单 + 掩码当前值）；变更记录无配置审计读接口 → n/a + 原因。
// 四态：loading / empty（无配置键）/ error / forbidden(401/403) / unavailable（响应缺数据区）。
// 本页只读：写入口未在本批开放（需二次确认 + 审计；数据卡 G-03 记录当前写路径不可用）。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface ModelConfigPayload { ok?: boolean; masked?: Record<string, string>; configured?: string[]; keys?: string[]; error?: string }

type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

const KEY_META: Record<string, { label: string; group: string; desc: string }> = {
  ANTHROPIC_BASE_URL: { label: "Base URL", group: "模型服务", desc: "兼容 Anthropic 协议的服务地址；自部署/中转填这里" },
  ANTHROPIC_AUTH_TOKEN: { label: "访问密钥", group: "密钥", desc: "模型服务的访问密钥；只显示掩码，永不展示明文" },
  ANTHROPIC_MODEL: { label: "默认模型", group: "模型服务", desc: "默认模型入口；对应 demo 的 llm.default_model 定位" },
  MINIMAX_API_KEY: { label: "MiniMax Key", group: "密钥", desc: "走 MiniMax 原生 key 时填写" },
  REFLECT_MODEL: { label: "反思模型", group: "模型服务", desc: "反思链使用的模型；为空时跟随默认模型" },
  OPENAI_API_KEY: { label: "OpenAI Key", group: "密钥", desc: "OpenAI 兼容网关的访问密钥；只显示掩码" },
  OPENAI_BASE_URL: { label: "OpenAI Base URL", group: "模型服务", desc: "OpenAI 兼容网关地址" },
};
const FALLBACK_KEYS = Object.keys(KEY_META);
const DEFAULT_KEY = "ANTHROPIC_MODEL";

export default function ModelConfigPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [data, setData] = useState<ModelConfigPayload | null>(null);
  const [requestedAt, setRequestedAt] = useState("");
  const [sel, setSel] = useState<string>(DEFAULT_KEY);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const r = await fetch("/api/model-config", { cache: "no-store" });
      setRequestedAt(new Date().toISOString());
      if (r.status === 401 || r.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!r.ok) {
        setErr("模型配置读接口返回状态码 " + r.status);
        setPhase("error");
        return;
      }
      const j = (await r.json()) as ModelConfigPayload;
      if (!j || (!j.masked && !j.keys)) {
        setErr("模型配置响应里没有可用的数据区");
        setPhase("unavailable");
        return;
      }
      setData(j);
      const keys = Array.isArray(j.keys) && j.keys.length ? j.keys : FALLBACK_KEYS;
      setSel(keys.indexOf(DEFAULT_KEY) >= 0 ? DEFAULT_KEY : keys[0]);
      setLastOkAt(new Date().toISOString());
      setPhase(keys.length ? "ok" : "empty");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const keys = useMemo(() => {
    const fromApi = data && Array.isArray(data.keys) && data.keys.length ? data.keys : null;
    return fromApi || FALLBACK_KEYS;
  }, [data]);
  const groups = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const k of keys) {
      const g = (KEY_META[k] && KEY_META[k].group) || "其他";
      (m[g] = m[g] || []).push(k);
    }
    return m;
  }, [keys]);
  const masked = (data && data.masked) || {};
  const configuredCount = Object.keys(masked).length;
  const loading = phase === "loading";
  const meta = KEY_META[sel] || { label: sel, group: "其他", desc: "n/a（该键没有页面元信息）" };
  const cur = masked[sel];

  return (
    <main className="page" data-slot="platform-model-page">
      <PageHeader>
        <PageTitle>模型配置</PageTitle>
        <div className="page-subtitle">
          平台配置 · 模型服务键（{loading ? "…" : configuredCount + " / " + keys.length} 已配置）· 左侧切换配置项，右侧看当前值与写约束
        </div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级" data-slot="platform-model-breadcrumb">
        <span className={styles.crumbOn}>#</span>
        <span>平台</span>
        <span>配置</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.noteWarn}>
        平台配置是全站仅两处可写页之一：每次写操作必须 ①变更前后对比 ②二次确认 ③写一条审计（who / when / what / before / after）。
        本页当前只读：写入口未开放（写闸门需二次确认与审计），仅展示当前值、变更预览口径与写操作约束。
      </div>

      {loading ? (
        <div className={styles.state}>加载中…</div>
      ) : phase === "forbidden" ? (
        <div className={styles.state}>
          <b className={styles.stateTitle}>无权限</b>
          <p className={styles.stateText}>当前账号缺少「平台配置」读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
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
          <b className={styles.stateTitle}>模型配置不可得</b>
          <p className={styles.stateText}>{err || "接口可用，但响应里没有配置键。"}</p>
          <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
        </div>
      ) : phase === "empty" ? (
        <div className={styles.stateMini}>模型配置里没有任何键（接口正常返回空集）。</div>
      ) : (
        <>
          <div className={styles.cfgLayout}>
            <aside className={styles.cfgAside}>
              {Object.keys(groups).map((g) => (
                <div key={g}>
                  <div className={styles.cfgGroup}>{g}</div>
                  {groups[g].map((k) => {
                    const m = KEY_META[k] || { label: k };
                    const on = sel === k;
                    return (
                      <button key={k} type="button" className={on ? styles.cfgItemOn : styles.cfgItem} onClick={() => setSel(k)}>
                        <span className={styles.cfgK}>{m.label}</span>
                        <span className={styles.cfgV}>{masked[k] ? masked[k] : "未配置"}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </aside>

            <div className={styles.cfgMain}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h2 className={styles.cardTitle}>{meta.label}</h2>
                    <p className={styles.sub}><span className={styles.mono}>{sel}</span> · {meta.group}</p>
                  </div>
                  <span className={styles.tagNa}>只读</span>
                </div>
                <dl className={styles.meta}>
                  <dt>当前值</dt>
                  <dd>{cur ? <span className={styles.mono}>{cur}</span> : <span className={styles.naCell}>未配置（接口 masked 无该键）</span>}</dd>
                  <dt>说明</dt><dd>{meta.desc}</dd>
                  <dt>风险等级</dt><dd><span className={styles.naCell} title="配置键无风险等级字段">n/a（无该字段）</span></dd>
                  <dt>最后修改</dt><dd><span className={styles.naCell} title="无配置审计读接口">n/a（无修改记录源）</span></dd>
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
                  <div className={styles.diffOld}><span className={styles.diffK}>变更前</span><span className={styles.mono}>{cur || "未配置"}</span></div>
                  <div className={styles.diffNew}><span className={styles.diffK}>变更后</span><span className={styles.naCell}>n/a（本页只读，写入口未开放）</span></div>
                </div>
                <div className={styles.auditLine}>
                  审计：who=n/a（未提交） · when=n/a · what=n/a · before={cur || "未配置"} · after=n/a（写入口未开放）
                </div>
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
                    <td colSpan={6} className={styles.naCell}>n/a（原因：无配置审计读接口；写操作全量落审计表，但本页没有读回入口，数据卡 G-06/G-02。不编造记录。）</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className={styles.foot}>
              请求时刻：{requestedAt ? fmtTime(requestedAt) : "n/a"} · 来源：模型配置读接口（只读）
              {" · 相关视图："}<Link className={styles.inlineLink} href="/system/api">服务与接口</Link>
              <Link className={styles.inlineLink} href="/system/health">健康检查</Link>
            </p>
          </section>
        </>
      )}
    </main>
  );
}