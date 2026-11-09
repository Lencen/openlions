"use client";
// 可观测性 · 验收 FAIL 分组 /system/observability（2026-11-06 · 0.4.32-03/05）
// 口径：verification/2026-11-06-obs/FAIL-GROUPING-2026-11-06.md
//   - checkedAt 是 epoch ms；窗口 7 日，另给 24h 对照
//   - 未知不填 0：接口 status=unknown 时整块显示"取不到 + 原因"
import { useApi } from "@/lib/api";
import { DataTable, ErrorBlock, PageHeader, PageTitle, KpiCard, Pill, StateBlock, type DataColumn } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import styles from "./page.module.css";

type Row = { key: string; n: number; share: string };
type Resp = {
  status?: "ok" | "unknown";
  reason?: string;
  asOf?: string;
  window?: string;
  totals?: { fail7d: number | null; fail24h: number | null; pass7d: number | null; trio: number | null };
  byType?: { key: string; n: number }[];
  byOwner?: { key: string; n: number }[];
  bySeverity?: { key: string; n: number }[];
};

const COLS: DataColumn<Row>[] = [
  { key: "key", title: "分组", width: "52%" },
  { key: "n", title: "FAIL", align: "right", width: "24%" },
  { key: "share", title: "占比", align: "right", width: "24%" },
];

function withShare(rows: { key: string; n: number }[] | undefined, total: number | null): Row[] {
  const list = rows || [];
  return list.map((r) => ({
    key: r.key,
    n: r.n,
    share: total && total > 0 ? (Math.round((r.n / total) * 1000) / 10).toFixed(1) + "%" : "n/a",
  }));
}

export default function ObservabilityPage() {
  const { data, error, loading, mutate } = useApi<Resp>("/api/observability/fail-grouping", { pollMs: 60000 });
  const d = data || {};
  const t = (d.totals || {}) as { fail7d?: number | null; fail24h?: number | null; pass7d?: number | null; trio?: number | null };
  const total = typeof t.fail7d === "number" ? t.fail7d : null;

  if (error) return <main className="page"><ErrorBlock message={String((error as any)?.message || error)} onRetry={() => mutate()} /></main>;

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>可观测性 · 验收 FAIL 分组</PageTitle>
        <Pill tone="neutral">只读</Pill>
      </PageHeader>
      <p className={styles.meta}>
        窗口 7 日（另含 24h）· 按 owner / 类型 / 严重度分组 · <DataMoment items={[{ label: "验收 FAIL", at: d.asOf }]} />
      </p>

      {d.status === "unknown" ? (
        <StateBlock title="取不到分组数据" desc={d.reason || "接口返回 unknown"} />
      ) : (
        <>
          <section className={styles.kpis}>
            <KpiCard label="FAIL（7 日）" value={typeof t.fail7d === "number" ? String(t.fail7d) : "n/a"} />
            <KpiCard label="FAIL（24 小时）" value={typeof t.fail24h === "number" ? String(t.fail24h) : "n/a"} />
            <KpiCard label="PASS（7 日）" value={typeof t.pass7d === "number" ? String(t.pass7d) : "n/a"} />
            <KpiCard label="evidence-length 三元组" value={typeof t.trio === "number" ? String(t.trio) : "n/a"} />
          </section>

          <section className={styles.grid}>
            <div className={styles.card}>
              <h2 className={styles.h2}>按 owner</h2>
              <DataTable<Row> rowKey={(r: Row) => r.key} columns={COLS} rows={withShare(d.byOwner, total)} loading={loading} empty={{ title: "没有可归因的 FAIL" }} />
            </div>
            <div className={styles.card}>
              <h2 className={styles.h2}>按类型</h2>
              <DataTable<Row> rowKey={(r: Row) => r.key} columns={COLS} rows={withShare(d.byType, total)} loading={loading} empty={{ title: "没有 FAIL" }} />
            </div>
            <div className={styles.card}>
              <h2 className={styles.h2}>按严重度</h2>
              <DataTable<Row> rowKey={(r: Row) => r.key} columns={COLS} rows={withShare(d.bySeverity, total)} loading={loading} empty={{ title: "没有 FAIL" }} />
            </div>
          </section>

          <p className={styles.note}>
            表中「无待办归属」指非待办类验收（主题改进 / 遗留核验 / 代码变更 / 落地），没有优先级，不能当严重度读；
            「无负责人」指该验收对应的待办还没有人认领。
          </p>
        </>
      )}
    </main>
  );
}
