"use client";
// 2026-11-05 商业线裁决：301 -> /market，目录保留 60 天
import { useParams } from "next/navigation";
import ErrorAlert from "@/components/ErrorAlert";
import { useBusinessSnapshot } from "../_components/useBusiness";
import BusinessShell from "../_components/BusinessShell";
import { KpiCard } from "@/components/ui";
import { businessKpiProps } from "../_components/businessKpi";
import DimensionBody from "../_components/DimensionBody";
import ActionList from "../_components/ActionList";
import { DIMENSIONS, dimensionMetrics, dimensionActions } from "../_components/caliber";

export default function FlywheelBusinessDimensionPage() {
  const params = useParams<{ dim: string }>();
  const id = String((params && params.dim) || "");
  const spec = DIMENSIONS.find((d) => d.id === id);
  const { data, error, loading, refreshing, refresh } = useBusinessSnapshot();

  if (loading && !data) {
    return <div className="layout-with-sidebar"><main className="main"><div className="panel" style={{ padding: "var(--sp-5)" }}>正在读取飞轮业务快照…</div></main></div>;
  }
  if (error || !data || !data.ok || !data.data) {
    return <div className="layout-with-sidebar"><main className="main"><ErrorAlert title="飞轮业务看板加载失败" message={String((error as Error)?.message || (data && data.error) || "未知错误")} onRetry={() => { refresh(); }} /></main></div>;
  }
  if (!spec) {
    return (
      <div className="layout-with-sidebar"><main className="main">
        <div className="panel" style={{ padding: "var(--sp-5)" }}>
          未知维度：{id || "（空）"}。可用维度：{DIMENSIONS.map((d) => d.id).join(" / ")}。
        </div>
      </main></div>
    );
  }

  const s = data.data;
  const metrics = dimensionMetrics(spec.id, s);
  const actions = dimensionActions(spec.id, s);

  return (
    <BusinessShell data={data} active={spec.id} title={spec.code + " " + spec.title} subtitle={spec.question + " · 责任人：" + spec.owner}
      onRefresh={refresh} refreshing={refreshing}>
      <div className="card-grid cols-4" data-testid="dimension-cards">
        {metrics.map((m) => <KpiCard key={m.key} {...businessKpiProps(m, s)} />)}
      </div>
      <DimensionBody id={spec.id} s={s} />
      {spec.id !== "d8" ? <ActionList actions={actions} s={s} /> : null}
    </BusinessShell>
  );
}
