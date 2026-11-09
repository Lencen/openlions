"use client";
// 2026-11-04 · P1 试点页呈现层改造（ord-20261104-032）· 运维看板 /system/health（模板 C 看板）
// ---------------------------------------------------------------------------
// 只改呈现层：useApi 的端点/参数、字段口径、路由语义一律未动（取数代码 0 改动）。
// 四态落点（TEMPLATES §0/§3）：
//   · 加载：服务表 DataTable loading（骨架行 = 真实列数，不用居中转圈）
//   · 错误：看板按「单域降级」—— 哪个域失败标哪个域（服务 / 会话 / 飞轮各自 ErrorBlock + 重试），不整页报错
//   · 空  ：服务清单为空 / 会话无状态分布 / 飞轮健康度缺失，各自写清「什么条件下为空」
//   · 无权限：任一源 401/403 或文案含「无权限/未授权」-> 整页 StateBlock「无权限访问」（缺 system.health）
import Link from "next/link";
import BarChart from "@/components/BarChart";
import { useApi } from "@/lib/api";
import { useEffect, useState } from "react";
import { Alert, Button, Input } from "@/components/primitives";
import { serviceLabel, healthDimLabel, statusLabel } from "@/config/systemLabels";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import DataMoment from "@/components/DataMoment";
import { KpiCard, DataTable, StateChip, StateBlock, ErrorBlock, PageHeader, PageTitle, Pill } from "@/components/ui";
import styles from "./page.module.css";

interface S {
  /** 76-GB: BFF 顶层新增的"数据时刻" */
  asOf?: string; result?: { data?: { total: number; byStatus: Record<string,number> } } }
interface F {
  /** 77-P: BFF 顶层新增的"数据时刻" */
  asOf?: string; data?: { reflections?:{total:number;ok:number;failed:number}; structuredFindings?:{covered:number;total:number;rate:number}; coverage?:{avg:number;total:number}; findings?:{total:number;byCategory?:Record<string,number>;byStatus?:Record<string,number>}; tasks?:Record<string,number>; health?:{completion:number;runtime:number;logic:number;dataMath:number;structure:number;quality:number;overall:number} } }
/** 服务存活检查的一行（/api/service-ping 原样字段，不加工口径） */
interface PingRow { name: string; code: number; ms: number; alive: boolean }

/** 无权限的唯一判定口：HTTP 401/403，或后端文案含「无权限 / 未授权」。
 *  这只影响「渲染哪一个四态」，不改取数、不吞错误（原始错误仍渲染在 ErrorBlock 里）。 */
const FORBIDDEN_RE = /401|403|无权限|未授权|unauthori[sz]ed|forbidden/i;
const isForbidden = (e?: Error) => FORBIDDEN_RE.test(String(e?.message ?? ""));
const errText = (e?: Error) => String(e?.message ?? "") || "接口未返回错误详情";

// ===== 0.4.39-04 CLS 修复：首屏只渲染前 N 行（桌面 20 / 移动端 <=640px 10）=====
// 成因（2026-11-09 实测 /system/health@390）：DataTable 的 loading 骨架固定 5 行（223px），
//   数据到达后换成真实行（服务 4 行 230px / 健康度 7 行 360px），表下区块被推走；
//   页头「逐源数据时刻」行从「未知/加载中」变成具体时间后也会多折 1 行（45px -> 68px）。
// 对策：只把前 N 行交给 DataTable，超出给「显示全部 N 条」按钮；加载态用容器 min-height 占位；
//   页头副标题在移动端预留实测高度（见 page.module.css）。
const N_DESKTOP = 20;
const N_MOBILE = 10;

/** 移动端判定必须放在 effect 里（matchMedia）后再切。
 *  渲染期直接读 window 会与 SSR 输出不一致 -> hydration mismatch。
 *  断点 640px 与 page.module.css 的 @media (max-width: 640px) 必须同值。 */
function useMobileQuery() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => setMobile(mq.matches);
    apply();
    if (mq.addEventListener) {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
    // 老 Safari 只有 addListener / removeListener（类型里没有，按可选调用兜底）
    (mq as any).addListener?.(apply);
    return () => (mq as any).removeListener?.(apply);
  }, []);
  return mobile;
}

export default function HealthPage() {
  const { data: sess, error: sessErr, mutate: sessMutate } = useApi<S>("/api/session-stats");
  const { data: fw, error: fwErr, mutate: fwMutate } = useApi<F>("/api/flywheel-stats");
  const st = sess?.result?.data;
  const fwd = fw?.data;
  // 2026-10-13 round 76-V: 原来在浏览器直连 http://localhost:3000/ 等服务 -> 被 CORS 拦(12 条 console error),
  //   于是「服务存活检查」恒显示离线。改用服务端 /api/service-ping(已有, server 端 ping, 避开 CORS)。
  const { data: pingData, loading: pingLoading, error: pingErr, mutate: pingMutate } = useApi<{ services: { name: string; code: number; ms: number; alive: boolean }[]; /** 77-K/P: BFF 顶层新增的"数据时刻" */ asOf?: string }>("/api/service-ping");
  const pings: Record<string, { code: number; ms: number; alive: boolean }> = {};
  for (const pg of pingData?.services ?? []) pings[pg.name] = { code: pg.code, ms: pg.ms, alive: pg.alive };
  const pingRows: PingRow[] = Object.entries(pings).map(([name, info]) => ({ name, ...info }));

  // 2026-10-13 round 76-BU: 卡死任务清理(从 selfimproving /health 搬来的**写操作**; 支持先预演)
  //   注：这是本页唯一的写动作（既有功能，P1 不删不改语义），看板其余部分只读。
  const [stuckMin, setStuckMin] = useState(30);
  const [stuckBusy, setStuckBusy] = useState<null | "dry" | "run">(null);
  const [stuckMsg, setStuckMsg] = useState<string | null>(null);
  async function cleanupStuck(dryRun: boolean) {
    setStuckBusy(dryRun ? "dry" : "run"); setStuckMsg(null);
    try {
      const r = await fetch("/api/cleanup-stuck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thresholdMin: stuckMin, dryRun }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(String(j?.error || ("请求失败（状态码 " + r.status + "）")));
      const d: any = j?.data ?? {};
      if (dryRun) {
        const sample = Array.isArray(d.sample) && d.sample.length ? "；示例：" + d.sample.slice(0, 3).map((s: any) => s.taskId + "（" + s.stuckMin + "分）").join("、") : "";
        setStuckMsg("预演：" + (d.count ?? 0) + " 个卡死执行（阈值 " + (d.thresholdMin ?? stuckMin) + " 分钟）" + sample);
      } else {
        setStuckMsg("已清理 " + (d.cleaned ?? 0) + " 个（阈值 " + (d.thresholdMin ?? stuckMin) + " 分钟）" + (d.message ? " · " + d.message : ""));
      }
    } catch (e) { setStuckMsg("失败：" + String((e as Error)?.message || e)); }
    finally { setStuckBusy(null); }
  }

  const tasksByStatus = fwd?.tasks ?? {};
  const byStatus = Object.entries(st?.byStatus ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, label: statusLabel(k), value: v }));
  const healthRows = Object.entries(fwd?.health ?? {}).map(([k, v]) => ({ key: k, label: healthDimLabel(k), score: Math.round(Number(v) || 0) }));
  const covRate = fwd?.structuredFindings?.rate;
  const forbidden = isForbidden(sessErr) || isForbidden(fwErr) || isForbidden(pingErr);

  // 0.4.39-04 CLS：首屏渲染窗口（桌面 N_DESKTOP / 移动端 N_MOBILE）+「显示全部」开关。
  // 取数、字段口径、列一律不变，只是先渲染前 N 行（点按钮才全渲染）。
  const isMobile = useMobileQuery();
  const pageSize = isMobile ? N_MOBILE : N_DESKTOP;
  const [showAllSvc, setShowAllSvc] = useState(false);
  const [showAllSess, setShowAllSess] = useState(false);
  const [showAllHealth, setShowAllHealth] = useState(false);
  const visiblePings = showAllSvc ? pingRows : pingRows.slice(0, pageSize);
  const visibleByStatus = showAllSess ? byStatus : byStatus.slice(0, pageSize);
  const visibleHealthRows = showAllHealth ? healthRows : healthRows.slice(0, pageSize);
  // 「无异常」提示是 ping 结果到达后才出现的；空槽时也占住它的高度，避免把服务表推下去。
  const allPingsAlive = pingRows.length > 0 && pingRows.every((r) => r.alive);

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>业务与系统</span><span className="sep">/</span><span className="current">健康检查</span></div>
    <PageHeader>
      <PageTitle>健康检查</PageTitle>
      <div className={"page-subtitle " + styles.subtitleStable}>服务存活 · 飞轮健康度 · 会话档案 · 数据库完整性<DataMoment items={[{ label: "会话", at: sess?.asOf }, { label: "飞轮", at: fw?.asOf }, { label: "服务", at: pingData?.asOf, loading: pingLoading }]} /></div>
      <div className={styles.headerTags}><Pill tone="mute">只读</Pill><Pill tone="info">看板 · 5min 聚合</Pill></div>
    </PageHeader>

    {forbidden ? (
      // 四态 · 无权限：整页替换（看板只读，但仍需读权限）
      <StateBlock
        title="无权限访问"
        desc={<>
          缺少本页的只读权限点 <code>system.health</code>（口径见 <code>config/submodules.ts</code> 的 <code>system.health</code> 条目）。<br />
          找平台管理员 / devops 值班开通；也可在「权限管理」页发起授权申请。
        </>}
        action={<Button size="small" href="/system/permissions">申请授权</Button>}
      />
    ) : (<>
      <div className="kpi-grid">
        <KpiCard label="会话档案" value={st?.total != null ? st.total.toLocaleString() : "—"} hint="来源 /api/session-stats" />
        <KpiCard label="飞轮反思" value={fwd?.reflections?.total != null ? fwd.reflections.total.toLocaleString() : "—"} hint="来源 /api/flywheel-stats" />
        <KpiCard label="覆盖率" value={covRate != null ? (covRate * 100).toFixed(1) + "%" : "—"} hint="结构化发现覆盖率（飞轮口径）；字段缺失显示 —，不写 0" />
        <KpiCard label="健康分" value={fwd?.health?.overall != null ? String(fwd.health.overall) : "—"} hint="六维健康度加权（含 overall）" />
      </div>

      {/* 2026-10-19 B5(方案 L3-2): 修前本页**正文 0 条出链** ✗ —— 看到"失败/覆盖"却点不进去。
          这里补三条**真实下钻**: 失败任务(飞轮任务支持 status 过滤 ✓)、反思明细、覆盖率明细。 */}
      <div className={styles.drillRow + " tiny"}>
        <span>下钻：</span>
        <Link href="/flywheel/executions">看失败的执行记录 →</Link>
        <Link href="/cognitive/reflection">看反思明细 →</Link>
        <Link href="/flywheel/coverage">看覆盖率构成 →</Link>
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">服务存活检查</span><span className={styles.panelNote}>在线 / 离线用状态片，不只靠颜色</span></div>
        {/* PILOT-10 §3「服务全绿时也说明无异常」：全在线不是"没内容"，要显式说一句，否则会被读成数据没回来。
            0.4.39-04 CLS：这句是 ping 结果到达后才出现的；空槽时用 min-height 占住实测高度（@390 39px / @1440 20px），
            避免它出现时把下面的服务表与表下内容整体推下去。 */}
        <div className={styles.panelNote + " " + styles.svcNoteSlot} data-empty={allPingsAlive ? undefined : "1"}>
          {allPingsAlive ? <>无异常：{pingRows.length} 个服务全部在线（ping 返回即当前值，逐源时刻见页头）。</> : null}
        </div>
        <TableCopyButton />
        <div className={styles.healthTableBox} data-loading={pingLoading && pingRows.length === 0 ? "1" : undefined}>
          <DataTable
            rows={visiblePings}
            rowKey={(r) => r.name}
            loading={pingLoading && pingRows.length === 0}
            error={pingErr ? errText(pingErr) : null}
            onRetry={() => { pingMutate(); }}
            empty={{
              title: "没有可 ping 的服务",
              desc: "触发条件：/api/service-ping 返回空数组（服务清单未配置或 BFF 未接入）。这不等于「服务全绿」。",
            }}
            columns={[
              { key: "name", title: "服务", render: (r) => <span className="nowrap">{serviceLabel(r.name)}</span> },
              { key: "code", title: t("field.httpCode"), align: "right", width: "96px", render: (r) => r.code || "—" },
              { key: "ms", title: "延迟", align: "right", width: "96px", render: (r) => (r.ms != null ? r.ms + "ms" : "—") },
              {
                key: "alive", title: "状态", width: "96px",
                render: (r) => <StateChip state={r.alive ? "ok" : "crit"} text={r.alive ? "在线" : "离线"} />,
              },
            ]}
          />
        </div>
        {pingRows.length > pageSize && !showAllSvc ? (
          <div className={styles.showAllBar}>
            <button type="button" className="btn" onClick={() => setShowAllSvc(true)}>
              {t("list.showAllRows", { n: pingRows.length })}
            </button>
            <span className={styles.showAllHint}>{t("list.firstNHint", { n: pageSize })}</span>
          </div>
        ) : showAllSvc && pingRows.length > pageSize ? (
          <div className={styles.showAllBar}>
            <button type="button" className="btn" onClick={() => setShowAllSvc(false)}>
              {t("list.collapseRows", { n: pageSize })}
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-header"><span className="panel-title">会话档案状态分布</span></div>
          <TableCopyButton />
          <div className={styles.healthTableBox} data-loading={!st && !sessErr ? "1" : undefined}>
            <DataTable
              rows={visibleByStatus}
              rowKey={(r) => r.key}
              loading={!st && !sessErr}
              error={sessErr ? errText(sessErr) : null}
              onRetry={() => { sessMutate(); }}
              empty={{ title: "本时段没有会话档案", desc: "触发条件：/api/session-stats 的 byStatus 为空对象（该时间窗内没有会话记录）。" }}
              columns={[
                {
                  key: "label", title: "状态",
                  render: (r) => (
                    <StateChip
                      state={r.key === "FAILED" ? "crit" : r.key === "PENDING" ? "warn" : "ok"}
                      text={r.label}
                    />
                  ),
                },
                { key: "value", title: "数量", align: "right", width: "120px", render: (r) => r.value.toLocaleString() },
              ]}
            />
          </div>
          {byStatus.length > pageSize && !showAllSess ? (
            <div className={styles.showAllBar}>
              <button type="button" className="btn" onClick={() => setShowAllSess(true)}>
                {t("list.showAllRows", { n: byStatus.length })}
              </button>
              <span className={styles.showAllHint}>{t("list.firstNHint", { n: pageSize })}</span>
            </div>
          ) : showAllSess && byStatus.length > pageSize ? (
            <div className={styles.showAllBar}>
              <button type="button" className="btn" onClick={() => setShowAllSess(false)}>
                {t("list.collapseRows", { n: pageSize })}
              </button>
            </div>
          ) : null}
        </div>
        {Object.keys(tasksByStatus).length > 0 && <div className="panel"><div className="panel-header"><span className="panel-title">飞轮任务状态</span></div>
          <BarChart bars={Object.entries(tasksByStatus).map(([k,v]:[string,any])=>({label:statusLabel(k),value:Number(v),color:k==="DONE"?"var(--status-ok)":k==="FAILED"?"var(--status-crit)":k==="IN_PROGRESS"?"var(--status-warn)":"var(--text-muted)"}))} /></div>}
      </div>

      {/* 2026-10-19 B7: 修前本页 main 内 0 个 svg ✗ —— 健康度只有表格, 没有"哪一维拖后腿"的直观对比。补一组条 ✓ */}
      <div className="panel">
        <div className="panel-header"><span className="panel-title">健康度维度分布</span><span className={styles.panelNote}>低于 60 分转红</span></div>
        {fwd?.health ? (
          <div className={styles.chartPad}>
            <BarChart bars={Object.entries(fwd.health).map(([k, v]: [string, any]) => ({
              label: healthDimLabel(k),
              value: Math.round(Number(v) || 0),
              color: k === "overall" ? "var(--primary)" : (Number(v) < 60 ? "var(--status-crit)" : "var(--status-ok)"),
            }))} />
          </div>
        ) : fwErr ? (
          <ErrorBlock message={errText(fwErr)} onRetry={() => { fwMutate(); }} />
        ) : (
          <StateBlock loading rows={3} />
        )}
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">飞轮健康度评估</span></div>
        <TableCopyButton />
        <div className={styles.healthTableBoxTall} data-loading={!fwd?.health && !fwErr ? "1" : undefined}>
          <DataTable
            rows={visibleHealthRows}
            rowKey={(r) => r.key}
            loading={!fwd?.health && !fwErr}
            error={fwErr ? errText(fwErr) : null}
            onRetry={() => { fwMutate(); }}
            empty={{ title: "健康度还没算出来", desc: "触发条件：/api/flywheel-stats 的 data.health 缺失（飞轮尚未产出评估）。" }}
            columns={[
              { key: "label", title: "维度", render: (r) => (r.key === "overall" ? <b>{r.label}（总分）</b> : r.label) },
              { key: "score", title: "分数", align: "right", width: "120px", render: (r) => (r.key === "overall" ? <b>{r.score}</b> : r.score) },
            ]}
          />
        </div>
        {healthRows.length > pageSize && !showAllHealth ? (
          <div className={styles.showAllBar}>
            <button type="button" className="btn" onClick={() => setShowAllHealth(true)}>
              {t("list.showAllRows", { n: healthRows.length })}
            </button>
            <span className={styles.showAllHint}>{t("list.firstNHint", { n: pageSize })}</span>
          </div>
        ) : showAllHealth && healthRows.length > pageSize ? (
          <div className={styles.showAllBar}>
            <button type="button" className="btn" onClick={() => setShowAllHealth(false)}>
              {t("list.collapseRows", { n: pageSize })}
            </button>
          </div>
        ) : null}
      </div>

      {/* PILOT-10 §3「成本：单值 -> 成本构成 + 预算进度」。
          本页当前没有任何成本字段（数据卡 3「数据缺口」：成本分层由数据线 2026-11-10 前补），
          按字典「缺失一律 n/a + 原因，不写 0」——这里**只占位并写清缺什么**，不编造数字。 */}
      <div className="panel">
        <div className="panel-header"><span className="panel-title">成本构成与预算进度</span><span className={styles.panelNote}>数据卡 3 · 待补</span></div>
        <StateBlock
          title="成本分层未接入"
          desc={<>
            触发条件：BFF 未下发成本构成与预算字段（数据卡 3「数据缺口」，数据线 2026-11-10 前补）。<br />
            成本构成（按环境 / 主机 / 域分层）与本月预算使用进度待补齐；补齐前显示「暂无」并说明原因。
          </>}
        />
      </div>

      {/* PILOT-10 §3「审计：混在表格 -> 独立区块，最近 5 条」。
          本页无审计接口（取数不动），故独立成区块 + 给出真正的落点（审计模块），条数待数据卡补。 */}
      <div className="panel">
        <div className="panel-header"><span className="panel-title">审计（最近 5 条）</span><span className={styles.panelNote}>只读 · 全量在审计模块</span></div>
        <StateBlock
          title="本页尚无审计数据源"
          desc={<>
            触发条件：/system/health 未接审计接口（本批不改取数）。<br />
            最近 5 条审计（谁 / 何时 / 对哪个配置做了什么）待接入。
          </>}
          action={<Button size="small" href="/audit/daily-summary">去审计模块看</Button>}
        />
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">卡死任务清理</span>
          <span className={styles.panelNote}>把长时间无进展的执行标记为失败，并让任务重新排队</span></div>
        <div className={styles.stuckForm}>
          <label className={styles.stuckField}>超时阈值（分钟）
            <Input type="number" className={styles.stuckInput} value={stuckMin} onChange={(e: any) => setStuckMin(Math.min(1440, Math.max(5, Number(e.target.value) || 30)))} /></label>
          <Button disabled={stuckBusy !== null} onClick={() => cleanupStuck(true)}>{stuckBusy === "dry" ? "预演中…" : "先预演"}</Button>
          <Button type="primary" disabled={stuckBusy !== null} onClick={() => cleanupStuck(false)}>{stuckBusy === "run" ? "清理中…" : "执行清理"}</Button>
        </div>
        {stuckMsg && <div className={styles.stuckMsg}><Alert type={stuckMsg.startsWith("失败") ? "error" : "success"} message={stuckMsg} /></div>}
      </div>

      {/* 看板 §3「页脚口径」：写清聚合节奏与可复跑的异常判据（数据卡 3 原文，不自创）。 */}
      <div className="panel">
        <div className="panel-header"><span className="panel-title">口径与异常判据</span></div>
        <div className={styles.footNote}>
          本页只读；5min 聚合，页头逐源标「数据时刻」。处置动作跳 devops 控制台，不在本页做写操作（卡死任务清理除外，见上方区块）。<br />
          异常判据（可复跑）：<code>node scripts/cutover-status.cjs</code> 末行非「0 项红」即异常 ·
          <code>node scripts/check-schema-gap.cjs</code> 多表 &gt; 0 即异常 ·
          <code>node scripts/check-client-process-version.cjs</code> 陈旧进程 &gt; 0 即异常。
        </div>
      </div>
    </>)}
  </main></div>);
}
