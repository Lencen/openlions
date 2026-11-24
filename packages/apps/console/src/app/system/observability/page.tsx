"use client";
// 0.5.1 B5-8 /system/observability · Bento P5 看板（2026-11-15）
// 数据：GET /api/observability/fail-grouping（totals/byType/byOwner/bySeverity/window/asOf）。
// 口径：FAIL 24h=0 是窗口内真空（7 日 547），必须标窗口；接口 status=unknown 时整块 unavailable + 原因（不写 0）。
import { useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, FilterBtn, KpiTile, Note, States, Toolbar, Tone, usePhaseOverride, useResource } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface Row { key: string; n: number }
interface Resp {
  status?: "ok" | "unknown"; reason?: string; asOf?: string; window?: string; sinceMs?: number;
  totals?: { fail7d: number | null; fail24h: number | null; pass7d: number | null; trio: number | null };
  byType?: Row[]; byOwner?: Row[]; bySeverity?: Row[];
}

const DIMENSIONS = [["owner", "按 owner"], ["type", "按类型"], ["severity", "按严重度"]] as const;
type Dim = typeof DIMENSIONS[number][0];

export default function ObservabilityPage() {
  const res = useResource<Resp>("/api/observability/fail-grouping", { pollMs: 60000 });
  const forced = usePhaseOverride();
  const base = forced && forced !== "ok" ? forced : res.phase;
  const d = res.data || {};
  const unknown = base === "ok" && d.status === "unknown";
  const phase = unknown ? "unavailable" : base;
  const t: Partial<NonNullable<Resp["totals"]>> = d.totals || {};
  const total = typeof t.fail7d === "number" ? t.fail7d : null;
  const [dim, setDim] = useState<Dim>("owner");
  const rowsByDim: Record<Dim, Row[]> = { owner: d.byOwner || [], type: d.byType || [], severity: d.bySeverity || [] };
  const rows: Row[] = rowsByDim[dim];

  const k = (v: number | null | undefined, hint: string, tone?: "info" | "ok" | "warn" | "crit"): Metric =>
    v == null ? { kind: "na", reason: "接口未返回该字段" } : { kind: "value", value: fmtNum(v), hint, tone: tone || "info" };

  const cols: DataColumn<Row>[] = [
    { key: "key", title: "分组", render: (r) => <b>{r.key || "n/a"}</b> },
    { key: "n", title: "FAIL", align: "right", width: 120, render: (r) => <span className={kit.num}>{fmtNum(r.n)}</span> },
    { key: "share", title: "占比（/FAIL 7 日）", align: "right", width: 180, render: (r) => <span className={kit.num}>{total && total > 0 ? ((r.n / total) * 100).toFixed(1) + "%" : "n/a"}</span> },
  ];

  return (
    <main className="page" data-slot="system-observability-page">
      <h1 className={kit.srOnly}>可观测性</h1>
      <PageHeader>
        <PageTitle>可观测性</PageTitle>
        <div className="page-subtitle">
          验收 FAIL 分组 · 窗口 {d.window || "7d"}（另含 24h 对照） · 数据时刻 {d.asOf ? fmtTime(d.asOf) : "n/a（接口未下发）"}
        </div>
        <Chips group="系统" page="可观测" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/observability/fail-grouping" error={res.error} status={res.status} onRetry={res.reload}
        emptyTitle="无失败组" emptyDetail="窗口内没有任何验收 FAIL 分组（空集，不是不可得）。"
        unavailableTitle="分组数据不可得" unavailableDetail={d.reason || "接口返回 status=unknown（原因未下发）：不写 0，不把不可得当无失败。"} />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label={"FAIL（" + (d.window || "7d") + "）"} metric={k(t.fail7d, "totals.fail7d")} />
          <KpiTile span={3} label="FAIL（24h）" metric={k(t.fail24h, "窗口 24h · 实测 0 属窗口内真空；7 日 " + fmtNum(t.fail7d ?? 0) + " 条", t.fail24h === 0 ? "warn" : "crit")} />
          <KpiTile span={3} label={"PASS（" + (d.window || "7d") + "）"} metric={k(t.pass7d, "totals.pass7d", "ok")} />
          <KpiTile span={3} label="evidence-length 三元组" metric={k(t.trio, "totals.trio（evidence-length 口径）")} />

          <BentoCard span={8} title="失败分组" sub={dim === "owner" ? "按 owner（无归属显示无待办归属/无负责人）" : dim === "type" ? "按验收类型" : "按严重度（P0–P3 / 无待办）"}>
            <Toolbar right={"分组 " + fmtNum(rows.length) + " 行 · 窗口 " + (d.window || "7d")}>
              {DIMENSIONS.map(([key, label]) => (
                <FilterBtn key={key} on={dim === key} onClick={() => setDim(key)}>{label}</FilterBtn>
              ))}
            </Toolbar>
            <DataTable<Row> columns={cols} rows={rows} rowKey={(r) => r.key}
              empty={{ title: "该维度无 FAIL", desc: "窗口内该维度没有分组（空集）。" }} />
          </BentoCard>

          <BentoCard span={4} title="窗口与口径" sub={"7 日窗口 · 起点 " + (d.sinceMs ? fmtTime(d.sinceMs) : "n/a")}>
            <ul className={kit.kv}>
              <li><span>窗口</span><b>{d.window || "7d"}（since {d.sinceMs ? fmtTime(d.sinceMs) : "n/a"}）</b></li>
              <li><span>24h 计数</span><b>{fmtNum(t.fail24h ?? 0)} —— 窗口内真空，不等于「无失败」（7 日 {fmtNum(t.fail7d ?? 0)}）</b></li>
              <li><span>占比分母</span><b>FAIL 7 日 {fmtNum(t.fail7d ?? 0)} 条</b></li>
              <li><span>无待办归属</span><b>非待办类验收（主题改进 / 遗留核验 / 代码变更 / 落地）无优先级，不能当严重度读</b></li>
            </ul>
            <Note>「无负责人」= 对应待办无人认领；状态 {d.status || "n/a"}。</Note>
          </BentoCard>

          <BentoCard span={12} title="口径与缺口">
            <ul className={kit.kv}>
              <li><span>24h=0 误读</span><b>FAIL 24h=0 是窗口内真空（7 日 547 条），页面已标窗口；不得写「无失败」。</b></li>
              <li><span>分组完整性</span><b>byType/byOwner/bySeverity 由 BFF 聚合；本页只展示，不自行重算总数。</b></li>
              <li><span>缺失数据</span><b>status=unknown 时整块 n/a + 原因（reason），不写 0。</b></li>
            </ul>
            <Note>相关视图：<a className={kit.link} href="/system/guards">守门规则</a> · <a className={kit.link} href="/audit/daily-summary">每日总结</a></Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}
