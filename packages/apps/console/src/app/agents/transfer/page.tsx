"use client";

// /agents/transfer — 0.5 批E · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → s12 说明（迁移移交是写操作）→ s12 移交记录（表格）→ 请求时刻。
// 数据：/api/agent-list（执行体规模）+ /api/todos（可转派任务量）为真实旁证；
//   移交记录表未上线（数据卡 8 §8）→ 整表 n/a + 原因，不写 0、不留空。
// 四态：loading / empty（接口通且空集）/ error / forbidden(401/403) / unavailable（响应缺数据）。
// 本页只读：转派执行不在本页（迁移移交需审批与审计，写操作不在本批）。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface TodosPayload { ok?: boolean; counts?: Array<{ status: string; c: number }>; humanOpen?: number }
interface AgentRow { agent_id: string }

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

export default function TransferPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [todos, setTodos] = useState<TodosPayload | null>(null);
  const [agentsAsOf, setAgentsAsOf] = useState("");
  const [requestedAt, setRequestedAt] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const [ar, tr] = await Promise.all([
        fetch("/api/agent-list", { cache: "no-store" }),
        fetch("/api/todos?limit=1", { cache: "no-store" }).catch(() => null),
      ]);
      setRequestedAt(new Date().toISOString());
      if (ar.status === 401 || ar.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!ar.ok) {
        setErr("执行体清单接口返回状态码 " + ar.status);
        setPhase("error");
        return;
      }
      const aj = await ar.json();
      const list = Array.isArray(aj) ? aj : Array.isArray(aj.items) ? aj.items : null;
      if (!Array.isArray(list)) {
        setErr("执行体清单响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setAgents(list);
      setAgentsAsOf((aj && aj.asOf) || "");
      if (tr && tr.ok) {
        setTodos((await tr.json()) as TodosPayload);
      } else {
        setTodos(null);
      }
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
  const openCount = (() => {
    const c = (todos && todos.counts) || [];
    return c.find((x) => x.status === "OPEN")?.c;
  })();
  const doingCount = (() => {
    const c = (todos && todos.counts) || [];
    return c.find((x) => x.status === "DOING")?.c;
  })();

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>执行体转派</PageTitle>
        <div className="page-subtitle">
          执行体 {loading ? "…" : agents ? fmtNum(agents.length) : "n/a"} 个 · 可转派任务 待处理 {loading ? "…" : typeof openCount === "number" ? fmtNum(openCount) : "n/a"} / 进行中 {loading ? "…" : typeof doingCount === "number" ? fmtNum(doingCount) : "n/a"} · 移交记录表未上线
        </div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>成员</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            
            <p className={styles.sub}>迁移移交是写操作</p>
          </div>
        </div>
        <p className={styles.noteText}>
          迁移移交会改变会话归属与钥匙作用域，属于写操作，需要审批与审计。本页只展示流程与记录，不提供执行入口。
          可转派任务量按待办状态统计（待处理 / 进行中），execution 转派本身不在页面开放。
        </p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>移交记录</h2>
            <p className={styles.sub}>编号 / 执行体 / 从 / 到 / 状态 / 时间</p>
          </div>
          <span className={styles.tagOk}>只读</span>
        </div>

        {loading ? (
          <div aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={styles.skelRow}>
                <span className={styles.skel + " " + styles.skelW1} />
                <span className={styles.skel + " " + styles.skelW2} />
                <span className={styles.skel + " " + styles.skelW3} />
              </div>
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
            <b className={styles.stateTitle}>转派数据不可得</b>
            <p className={styles.stateText}>{err || "接口可用，但响应里没有可用的数据区。"}</p>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>执行体</th>
                  <th>从</th>
                  <th>到</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={6} className={styles.naCell}>
                    n/a（原因：转派批次记录表未上线，数据卡 8 §8；页面上方「可转派任务」来自待办状态统计，不是移交记录。不写 0、不留空、不用「—」代替。）
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.foot}>
          <DataMoment items={[{ label: "执行体清单", at: agentsAsOf }]} />
          {" · 请求时刻 " + (requestedAt ? fmtTime(requestedAt) : "n/a") + " · 移交记录表无数据源"}
          {" · 相关视图："}
          <Link className={styles.inlineLink} href="/todo">待办看板</Link>
          <Link className={styles.inlineLink} href="/agents">智能体</Link>
        </p>
      </section>
    </main>
  );
}