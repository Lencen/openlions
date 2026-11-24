"use client";

// /system/health — 运维看板 · Q1 九槽位还原（2026-11-19 U-57）
// 设计规格：[internal-doc] 段）
//   4×s3 KPI（服务可用 / 发布版本 / 今日成本 / 今日审计）
//   + s6 服务健康(table) + s3 成本构成(chart) + s3 告警(list)
//   + s6 最近审计(table) + s6 数据库与发布窗口(kv)
// 数据（页面 hydrate 后取，只读）：/api/service-ping、/api/db-health、/api/client-releases、/api/version
// 无源槽位（今日成本、今日审计、成本构成、告警、最近审计、备份新鲜度、磁盘水位）：保留设计要求的**形态**
//   + n/a + 具体原因（缺什么 / 谁补），不写 0、不画示例 bars、不伪造审计记录。
// F6/B-01（2026-11-19 必须保持）：page.tsx 读 searchParams -> forcedState；SSR 首屏 data-phase 即强制态，
//   正常页 SSR 为 "loading"。强制态下不取数、不改态。
import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, States, Tone, Toolbar } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import styles from "./page.module.css";

interface Svc { name: string; code: number; ms: number; alive: boolean }
/** 表格行：端口/运行时长/错误率三项探活不下发，统一渲染 n/a（原因见表下 Note）。 */
interface SvcRow { name: string; code: number; alive: boolean; port: string; uptime: string; err: string }
interface Ping { services?: Svc[]; asOf?: string }
interface Db { ok?: boolean; driver?: string; pool?: string; failures?: number; queryFailureTotal?: number; asOf?: string }
interface Rel { latest?: { version?: string; sizeBytes?: number; signed?: boolean; publishedAt?: string } | null; items?: Array<{ version?: string; sizeBytes?: number; signed?: boolean; publishedAt?: string }> }
interface Ver { deployedPlatform?: string | null; platform?: string }

/** 探活端点：数据源写在一处，页头/工具条/状态卡共用（避免「页面说 A、实际请求 B」）。 */
const ENDPOINTS = "/api/service-ping · /api/db-health · /api/client-releases · /api/version";

const fmtTime = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");

export default function OpsPage({ forcedState = null }: { forcedState?: string | null }) {
  // F6/B-01：服务端传入 ?state= 强制态（page.tsx 解析 searchParams）；非法值忽略。
  const FORCED = forcedState === "empty" || forcedState === "error" || forcedState === "unavailable" || forcedState === "forbidden" ? forcedState : null;
  const [ping, setPing] = useState<Ping | null>(null);
  const [db, setDb] = useState<Db | null>(null);
  const [rel, setRel] = useState<Rel | null>(null);
  const [ver, setVer] = useState<Ver | null>(null);
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "forbidden" | "unavailable" | "empty">(FORCED ?? "loading");
  const [err, setErr] = useState(FORCED ? "（复现模式：?state=" + FORCED + "）" : "");
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    // 强制态下不取数、不改态（保证「看到的 = URL 要求的」，也避免 hydrate 后闪回真实态）。
    if (FORCED) return;
    let alive = true; setPhase("loading"); setErr(""); setHttpStatus(null);
    (async () => {
      try {
        const [pr, dr, rr, vr] = await Promise.all([
          fetch("/api/service-ping", { cache: "no-store" }),
          fetch("/api/db-health", { cache: "no-store" }).catch(() => null),
          fetch("/api/client-releases", { cache: "no-store" }).catch(() => null),
          fetch("/api/version", { cache: "no-store" }).catch(() => null),
        ]);
        if (!alive) return;
        setHttpStatus(pr.status);
        if (pr.status === 401 || pr.status === 403) { setPhase("forbidden"); return; }
        if (!pr.ok) { setErr("探活接口 " + pr.status); setPhase("error"); return; }
        const pj = await pr.json();
        if (pj && Array.isArray(pj.services) && pj.services.length === 0) { setErr("探活接口未返回任何服务（不可得）"); setPhase("unavailable"); return; }
        setPing(pj);
        if (vr && vr.ok) setVer(await vr.json().catch(() => null));
        if (dr && dr.ok) setDb(await dr.json().catch(() => null));
        if (rr && rr.ok) setRel(await rr.json().catch(() => null));
        setPhase("ok");
      } catch { if (alive) { setErr("探活请求失败"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [nonce, FORCED]);

  const svcs = Array.isArray(ping?.services) ? ping.services : [];
  const total = svcs.length;
  const aliveN = svcs.filter((s) => s.alive).length;
  const bad = svcs.filter((s) => !s.alive || s.code >= 400);
  const latest = rel?.latest || (rel?.items ? rel.items[0] : null);
  const verText = ver?.deployedPlatform || ver?.platform || null;

  // ── KPI 四个（设计页 221-224 行）：有源给值，无源 n/a + 原因（不写 0） ──────────
  // 口径（与「服务健康」表同源）：alive = 探活通过；code>=400 计「在线但不健康」，不算不可用。
  const dead = svcs.filter((s) => !s.alive);
  const unhealthy = svcs.filter((s) => s.alive && s.code >= 400);
  const kpiServices: Metric = total === 0
    ? { kind: "na", reason: "探活接口未返回服务条目（≠ 0 个服务；空集走 empty 态）" }
    : {
        kind: "value", value: aliveN + " / " + total,
        tone: dead.length ? "crit" : unhealthy.length ? "warn" : "ok",
        hint: dead.length
          ? "不可用 " + dead.length + "：" + dead.map((s) => s.name).join("、")
          : unhealthy.length
            ? "可用 " + aliveN + " · 在线但不健康 " + unhealthy.length + "：" + unhealthy.map((s) => s.name + "(" + s.code + ")").join("、")
            : "全部探活通过（" + total + " 项）",
      };
  const kpiRelease: Metric = verText
    ? { kind: "value", value: verText, hint: "部署树平台版本 · 客户端 latest " + (latest?.version || "n/a") }
    : { kind: "na", reason: "/api/version 未返回部署版本；不猜版本、不写 0" };
  const kpiCost: Metric = {
    kind: "na",
    reason: "无成本/单价口径：只有 token 计量（/api/token-usage、/api/llm-usage），没有金额字段（G-4）；不写 0",
  };
  const kpiAudit: Metric = {
    kind: "na",
    reason: "无审计只读接口：写操作审计只落服务端 AuditLog，没有查询 API（G-4）；不写 0",
  };

  // ── 服务健康表（设计 229-236 行：服务/端口/状态/运行时长/错误率） ─────────────
  const svcCols: DataColumn<SvcRow>[] = [
    { key: "name", title: "服务", width: 160, render: (s) => <b>{s.name}</b> },
    { key: "port", title: "端口", width: 90, render: () => <span className={kit.muted}>n/a</span> },
    { key: "state", title: "状态", width: 130, render: (s) => (
      <Tone tone={!s.alive ? "crit" : s.code >= 400 ? "warn" : "ok"}>{!s.alive ? "异常" : s.code >= 400 ? "在线但不健康" : "正常"}</Tone>
    ) },
    { key: "uptime", title: "运行时长", width: 110, render: () => <span className={kit.muted}>n/a</span> },
    { key: "err", title: "错误率", render: () => <span className={kit.muted}>n/a</span> },
  ];
  // 表内 n/a 是同一个原因时（U-56b 裁定）：允许表下一行统一说明，不允许只有 n/a 没有解释。
  const svcRows: SvcRow[] = svcs.map((s) => ({ name: s.name, code: s.code, alive: s.alive, port: "n/a", uptime: "n/a", err: "n/a" }));

  return (
    <main className="page" data-phase={phase}>
      <h1 className={kit.srOnly}>运维看板</h1>
      <PageHeader>
        <PageTitle>运维看板</PageTitle>
        <div className="page-subtitle">
          服务 / 数据库 / 发布只读视图（{fmtTime(ping?.asOf)}） · 成本 / 审计 / 告警 / 备份 / 磁盘无数据源处按 n/a + 原因展示，不写 0、不伪造示例
        </div>
        <Chips group="系统" page="看板" />
      </PageHeader>

      {/* 工具条：设计页（pages.js:218-289）本页无筛选/搜索/分页交互（9 个槽位都是全局视图，
          没有「按条筛」的语义），故只放「刷新 + 端点 + 只读」三件事，不摆装饰性筛选项。 */}
      <Toolbar right={"只读 · " + ENDPOINTS + (httpStatus ? " · HTTP " + httpStatus : "")}>
        <button type="button" className={kit.pbtn} onClick={reload}>刷新</button>
        <span className={kit.pageInfo}>无筛选 / 搜索（本页无「按条筛」语义）</span>
      </Toolbar>

      <States
        phase={phase}
        endpoint="/api/service-ping"
        error={err}
        status={httpStatus}
        onRetry={reload}
        forbiddenDetail="当前账号没有查看运维看板的权限（端点返回 401/403）；本页只读，请联系平台管理员开通。"
        unavailableTitle="运维数据不可得"
        unavailableDetail={(err || "探活接口未返回任何服务") + " —— 与 empty（正常返回但空集）区分开：这里是探活本身不可用，需先修接口。"}
        emptyTitle="暂无运维数据"
        emptyDetail={"探活 / 库 / 发布接口正常返回，但当前没有可展示的服务或发行记录（empty：不是不可得、也不是加载中）。" + (err ? " · " + err : "")}
      />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="服务可用" metric={kpiServices} />
          <KpiTile span={3} label="发布版本" metric={kpiRelease} />
          <KpiTile span={3} label="今日成本" metric={kpiCost} />
          <KpiTile span={3} label="今日审计" metric={kpiAudit} />

          <BentoCard span={6} title="服务健康" sub={"systemd / 端口 / 版本 · 探活 " + total + " 项"}>
            <div className={styles.tblWrap}>
              <DataTable<SvcRow> columns={svcCols} rows={svcRows} rowKey={(s) => s.name}
                empty={{ title: "探活没有返回服务", desc: "接口正常但 services 为空 —— 空集按 empty 态处理，不写 0。" }} />
            </div>
            <Note>表内 n/a 统一原因：端口 / 运行时长 / 错误率三项探活接口不下发（不写 0、不猜值）。</Note>
          </BentoCard>

          {/* 成本构成：设计要 bars，本页只有 token 计量、无金额口径（G-4）——
              保留图表位 + n/a 原因，不画 bars（画了就是伪造 0 值 / 示例占比）。 */}
          <BentoCard span={3} title="成本构成" sub="本月 · 图表位（bars）" actions={<Tone tone="mute">n/a</Tone>}>
            <div className={styles.chartFrame} role="img" aria-label="成本构成图表位：无金额口径，n/a" data-na-reason="cost-bars">
              <span className={styles.chartSlot}>图表位 · 模型调用 / 存储 / 带宽 / 第三方 / 其他</span>
              <p className={styles.chartNa}>
                n/a —— 原因：平台只有用量计量，没有计价与单价口径。补料方：数据线提供成本分层口径。本卡不画图、不写 0。
              </p>
            </div>
          </BentoCard>

          {/* 告警：设计要 list。告警系统未接入 ≠ 0 条告警（U-56b 假 0 裁定）——
              列表形态保留，条目写「未接入 + 缺什么」，不把探活正常伪装成「无告警」。 */}
          <BentoCard span={3} title="告警" sub="未关闭 · 无告警源" actions={<Tone tone="mute">n/a</Tone>}>
            <ul className={styles.alertList} data-metric-value="na" data-false-zero-guard="alert">
              <li className={styles.alertItem}>
                <span className={styles.dotWarn} aria-hidden="true" />
                <span>
                  <b>未接入告警源</b>
                  <span className={styles.alertMeta}>
                    n/a —— 原因：无告警系统 / 未关闭告警查询接口；「探活正常」不等于「0 条告警」，不写 0。探活异常见「服务健康」表。
                  </span>
                </span>
              </li>
            </ul>
          </BentoCard>

          {/* 最近审计：设计要 table（写操作全量落表）。无审计只读接口 -> 表头照设计保留，
              表体只有一条 colspan 的 n/a 说明行（不是一条审计记录），不伪造时间/操作者/动作。 */}
          <BentoCard span={6} title="最近审计" sub="写操作全量落表 · 未接入" actions={<Tone tone="mute">n/a</Tone>}>
            <div className={styles.tblWrap}>
              <table className={styles.auditTbl} data-block="audit-recent">
                <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>结果</th></tr></thead>
                <tbody>
                  <tr>
                    <td colSpan={4} className={styles.naCell} data-na-reason="audit-recent">
                      n/a —— 未接入审计查询出口（审计只写入服务端，没有只读查询能力）。补料方：审计补只读查询后接入。
                      本行是缺口说明，不是审计记录；不伪造记录、不写 0。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </BentoCard>

          <BentoCard span={6} title="数据库与发布窗口" sub="只读" actions={<Tone tone="info">kv</Tone>}>
            <dl className={styles.kvList}>
              <div><dt>数据库连接</dt><dd>{db ? (db.pool || "?") + " · 查询失败 " + (db.queryFailureTotal ?? db.failures ?? "n/a") : "n/a（/api/db-health 未返回）"}</dd></div>
              <div><dt>数据库延迟</dt><dd>n/a —— 原因：健康接口不下发延迟字段</dd></div>
              <div><dt>备份新鲜度</dt><dd>n/a —— 原因：无备份状态接口（判据在 scripts/backup-freshness-check.cjs，未下发页面）</dd></div>
              <div><dt>磁盘水位</dt><dd>n/a —— 原因：无磁盘水位接口（水位在 scripts/disk-guard.sh 的 run/disk-guard.state）</dd></div>
              <div><dt>发布窗口</dt><dd>{latest ? latest.version + " · " + fmtTime(latest.publishedAt) : "n/a（/api/client-releases 未返回发行记录）"}</dd></div>
            </dl>
            <Note>看板只读：本页不提供提交 / 保存 / 删除控件。</Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}
