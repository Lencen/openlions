"use client";

// /agents/onboard — 0.5 批E · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → s8 接入向导（4 步，当前步骤与可选业务服务数）→ s4 当前填写（键值）→ 请求时刻。
// 数据：/api/services-list（可选业务服务，真实）；当前填写字段没有可展示的输入值（本页只读，写入口未开放）→ n/a + 原因。
// 四态：loading / empty（服务清单返回空集）/ error / forbidden(401/403) / unavailable（响应缺数据区）。
// 本页只读：注册提交在当前写闸门下需要二次确认（数据卡 G-2），本批不提供提交入口。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface Service { id?: string; name: string; display_name?: string | null; status?: string | null }

type Phase = "loading" | "ok" | "empty" | "error" | "forbidden" | "unavailable";

const STEPS = [
  { title: "① 选择宿主与运行时", note: "宿主与运行时由接入方提供" },
  { title: "② 填写执行体元信息", note: "名称 / 类型 / 宿主 / 负责人" },
  { title: "③ 绑定能力与钥匙", note: "选择可选业务服务并签发凭证" },
  { title: "④ 试运行与接入审批", note: "试运行通过后进入接入审批" },
];

export default function OnboardPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [services, setServices] = useState<Service[] | null>(null);
  const [requestedAt, setRequestedAt] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const r = await fetch("/api/services-list", { cache: "no-store" });
      setRequestedAt(new Date().toISOString());
      if (r.status === 401 || r.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!r.ok) {
        setErr("服务清单接口返回状态码 " + r.status);
        setPhase("error");
        return;
      }
      const j = await r.json();
      const list = Array.isArray(j) ? j : Array.isArray(j.services) ? j.services : null;
      if (!Array.isArray(list)) {
        setErr("服务清单响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setServices(list);
      setLastOkAt(new Date().toISOString());
      setPhase(list.length ? "ok" : "empty");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const loading = phase === "loading";
  const rows = services || [];
  const active = rows.filter((s) => String(s.status || "").toUpperCase() === "ACTIVE").length;

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>接入向导</PageTitle>
        <div className="page-subtitle">
          4 步接入流程；可选业务服务 {loading ? "…" : fmtNum(active)} 项（清单 {loading ? "…" : fmtNum(rows.length)} 项）
        </div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>成员</span>
        <span>向导</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.grid}>
        <section className={styles.card + " " + styles.s8}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>接入向导</h2>
              <p className={styles.sub}>4 步 · 当前只读视图（提交入口未开放）</p>
            </div>
            <span className={styles.tagOk}>只读</span>
          </div>

          {loading ? (
            <div aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={styles.skelRow}><span className={styles.skel + " " + styles.skelW1} /><span className={styles.skel + " " + styles.skelW2} /></div>
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
              <b className={styles.stateTitle}>服务数据不可得</b>
              <p className={styles.stateText}>{err || "接口可用，但响应里没有服务数据区。"}</p>
              <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
            </div>
          ) : (
            <>
              <div className={styles.stepList}>
                {STEPS.map((s, i) => (
                  <div key={s.title} className={i === 0 ? styles.stepOn : styles.step}>
                    <span className={i === 0 ? styles.stepTagOn : styles.stepTag}>{i === 0 ? "当前" : "待办"}</span>
                    <span className={styles.stepMain}>
                      <span className={styles.stepTitle}>{s.title}</span>
                      <span className={styles.stepNote}>{s.note}</span>
                    </span>
                  </div>
                ))}
              </div>
              <p className={styles.noteText}>
                可选业务服务 {phase === "empty" ? "0 项（清单返回空集，请到工具服务页排查）" : fmtNum(active) + " 项"}：
                {rows.length ? rows.map((s) => s.display_name || s.name).join("、") : "n/a"}
              </p>
              <p className={styles.foot}>
                <DataMoment items={[{ label: "服务清单", at: null }]} />
                {" · 请求时刻 " + (requestedAt ? fmtTime(requestedAt) : "n/a") + " · 清单接口无数据时刻，显示「未知」不借其它源"}
              </p>
            </>
          )}
        </section>

        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>当前填写</h2>
              <p className={styles.sub}>键值 · 本页只读</p>
            </div>
          </div>
          <dl className={styles.kv}>
            <dt>名称</dt><dd className={styles.naCell}>n/a（未开始填写）</dd>
            <dt>类型</dt><dd className={styles.naCell}>n/a（未开始填写）</dd>
            <dt>宿主</dt><dd className={styles.naCell}>n/a（未开始填写）</dd>
            <dt>负责人</dt><dd className={styles.naCell}>n/a（未开始填写）</dd>
            <dt>下一步</dt><dd className={styles.naCell}>n/a（提交入口未开放：注册写操作需二次确认与审计，见数据卡 G-2）</dd>
          </dl>
          <p className={styles.foot}>
            相关信息：<Link className={styles.inlineLink} href="/agents">接入管理</Link>
            <Link className={styles.inlineLink} href="/agents/approvals">审批进度</Link>
          </p>
        </section>
      </div>
    </main>
  );
}
