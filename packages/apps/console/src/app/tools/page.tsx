"use client";
/**
 * 工具注册表 /tools —— ord-20261104-032 试点第 12 页（模板 A 列表）
 *
 * 数据状态（2026-11-04，必须写在页面上，避免读者以为有数）：
 *   工具注册表接口尚未接入（数据卡 12 待补）。本页只做**结构与四态**：
 *   · 指标带 4 张显示「暂无」+ 原因，不写 0（0 会被当成实测值）；
 *   · 表格按模板列定义渲染，行数为 0，空态写清触发条件与补齐路径；
 *   · 四态由对 /api/mcp-proxy 的**可用性探测**驱动（现有端点，只读）：
 *     待返回 -> loading；401/403 -> forbidden；其它失败 -> error；200 -> 结构渲染 + 空态。
 *     探测结果不参与任何指标计算，页面里也不出现代理能力清单。
 *   · 不动任何取数口径：该页原本没有取数，本页也没有新增业务取数。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PageHeader,
  PageTitle,
  KpiCard,
  DataTable,
  FilterBar,
  StateBlock,
  ErrorBlock,
  Pill,
  type DataColumn,
} from "@/components/ui";
import styles from "./page.module.css";

interface ToolRow {
  id: string;
  name: string;
  kind: string;
  calls: number;
  successRate: number;
  p95Ms: number;
  state: "ok" | "warn" | "crit" | "idle";
}

const COLUMNS: DataColumn<ToolRow>[] = [
  { key: "name", title: "工具", width: "28%" },
  { key: "kind", title: "类型", width: "14%" },
  { key: "calls", title: "调用量", align: "right", width: "14%" },
  { key: "successRate", title: "成功率", align: "right", width: "14%" },
  { key: "p95", title: "P95 耗时", align: "right", width: "14%" },
  { key: "state", title: "状态", width: "16%" },
];

const FILTERS = [
  { key: "all", label: "全部", count: 0 },
  { key: "ok", label: "正常", count: 0 },
  { key: "degraded", label: "降级", count: 0 },
];

type Phase = "loading" | "ok" | "error" | "forbidden";

export default function ToolsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [probe, setProbe] = useState<string | null>(null);
  const [active, setActive] = useState("all");
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    setProbe(null);
    (async () => {
      try {
        const r = await fetch("/api/mcp-proxy", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) { setProbe("代理探测返回 " + r.status); setPhase("error"); return; }
        setPhase("ok");
      } catch {
        if (!alive) return;
        setProbe("代理探测请求失败");
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const rows = useMemo<ToolRow[]>(() => [], []);
  const shown = useMemo(() => (active === "all" ? rows : rows.filter((r) => r.state === active)), [rows, active]);

  const table = (
    <DataTable<ToolRow>
      columns={COLUMNS}
      rows={shown}
      rowKey={(r) => r.id}
      loading={phase === "loading"}
      error={phase === "error" ? probe : null}
      onRetry={reload}
      empty={{
        title: "工具注册表尚未接入",
        desc: "本页结构与四态已就绪；注册表接口（调用量 / 成功率 / P95）随数据卡 12 补齐后自动填充。当前显示为空不是「零调用」。",
      }}
    />
  );

  return (
    <main className={styles.page}>
      <PageHeader>
        <PageTitle>工具箱</PageTitle>
        <div className="page-subtitle">
          工具注册表：类型、调用量、成功率与 P95 耗时；数据未接入时如实显示「暂无」，不以 0 冒充。
        </div>
        <div className={styles.chips}>
          <Pill tone="mute">只读</Pill>
          <Pill tone="info">列表模板</Pill>
        </div>
      </PageHeader>

      {phase === "forbidden" ? (
        <StateBlock
          title="无权限访问"
          desc={
            <>
              当前账号缺少「工具箱」读权限 <code>tools.read</code>，请联系平台管理员开通后刷新本页。
            </>
          }
          action={<button type="button" className={styles.actionBtn} onClick={reload}>重新检测</button>}
        />
      ) : (
        <>
          <div className={styles.kpiBand}>
            <KpiCard label="工具数" value="暂无" hint="注册表接口未接入（数据卡 12）" />
            <KpiCard label="调用总量" value="暂无" hint="注册表接口未接入（数据卡 12）" />
            <KpiCard label="平均成功率" value="暂无" hint="注册表接口未接入（数据卡 12）" />
            <KpiCard label="P95 耗时" value="暂无" hint="注册表接口未接入（数据卡 12）" />
          </div>

          <FilterBar
            items={FILTERS}
            active={active}
            onSelect={setActive}
            right={<span>只读视图 · 数据未接入时不计入统计</span>}
          />

          {phase === "error" ? <ErrorBlock message={probe ?? undefined} onRetry={reload} /> : null}

          {table}

          <p className={styles.foot}>
            口径：调用量 / 成功率 / P95 以注册表接口返回为准，本页不做自算；接口未接入期间四列均显示「暂无」，
            与「零调用」区分。补齐后可筛「正常 / 降级」，默认按调用量降序。
          </p>
        </>
      )}
    </main>
  );
}
