"use client";
// cost 页 · 归因聚合 (按入口柱状 + 按模型饼图), 从 page.tsx 抽出 (2026-09-14 页面瘦身)
import ChartPanel from "@/components/common/ChartPanel";
import { useChartBase } from "@/components/EChart";
import { t } from "@/i18n";
import { fmtCompact, fmtNum, fmtTokens } from "@/lib/format";
import styles from "../page.module.css";

// 2026-11-09 轮 A2：模型色不再写 hex，改为按主题 token 取名。
//   取值与改动前一致（此前是 EChart HEX_TO_KEY 把同一批 hex 映射成这些 token），
//   但源码现在直接表达"这是哪一类色"，换主题/换品牌色时无需再维护一张映射表。
const modelColors = (base: any): string[] => [
  base.colors.primary,        // 原 #2563eb
  base.colors.tableKnowledge, // 原 #7c3aed
  base.colors.tableMemory,    // 原 #0d9488
  base.colors.statusWarn,     // 原 #d97706
  base.colors.tableReflection,// 原 #db2777
  base.colors.textDim,        // 原 #64748b
];

function entryChartOption(byEntry: any[], base: any) {
  return {
    ...base,
    grid: { left: 8, right: 60, top: 8, bottom: 8, containLabel: true },
    tooltip: { ...base.tooltip, axisPointer: { type: "shadow" } },
    xAxis: { ...base.xAxis, type: "value", axisLabel: { ...base.xAxis.axisLabel, fontSize: "var(--fs-xs)", formatter: (v: number) => (v >= 10000 ? v / 10000 + "万" : String(v)) } },
    yAxis: { ...base.yAxis, type: "category", data: byEntry.map((e: any) => e.entry).reverse(), splitLine: { show: false } },
    series: [
      {
        name: t("cost.byEntry.measured"), type: "bar", barMaxWidth: 18,
        itemStyle: { color: base.colors.primary, borderRadius: [0, 3, 3, 0] },
        label: { show: true, position: "right", fontSize: "var(--fs-xs)", color: base.textStyle.color, formatter: (p: any) => (p.value ? fmtCompact(p.value) : "") },
        data: byEntry.map((e: any) => e.tokens).reverse(),
      },
      // 估算单独一列 (只在有估算时出现)
      ...(byEntry.some((e: any) => e.estimatedTokens > 0)
        ? [{
            name: t("cost.byEntry.estimated"), type: "bar" as const, barMaxWidth: 12,
            itemStyle: { color: base.colors.bgSurface2, borderRadius: [0, 3, 3, 0] },
            data: byEntry.map((e: any) => e.estimatedTokens).reverse(),
          }]
        : []),
    ],
  };
}

function modelChartOption(byModel: any[], base: any) {
  return {
    ...base,
    tooltip: {
      ...base.tooltip, trigger: "item",
      formatter: (p: any) => {
        const row = byModel[p.dataIndex] || {};
        return t("cost.modelTooltip", { v: fmtTokens(p.value), p: p.percent }) +
          ((row.estimatedTokens || 0) > 0 ? t("cost.modelTooltip.estimated", { v: fmtTokens(row.estimatedTokens) }) : "");
      },
    },
    legend: { bottom: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: "var(--fs-sm)", color: base.textStyle.color } },
    series: [
      {
        type: "pie",
        radius: ["42%", "68%"],
        center: ["50%", "45%"],
        itemStyle: { borderColor: base.tooltip.backgroundColor, borderWidth: 2 },
        label: { fontSize: "var(--fs-sm)", color: base.textStyle.color, formatter: "{b}\n{d}%" },
        // 饼图只画实测 (估算单列展示, 不并入)
        data: byModel.map((m: any, i: number) => ({
          name: m.model, value: m.tokens,
          itemStyle: { color: modelColors(base)[i % 6] },
        })),
      },
    ],
  };
}

function modelTitle(data: any) {
  return data?.modelAttribution === "recorded"
    ? "按模型聚合（事件实测）"
    : data?.modelAttribution === "mixed"
      ? "按模型聚合（部分实测）"
      : "按模型聚合（推定）";
}

export default function CostAttributionPanels({
  data,
  byEntry,
  byModel,
  loadingAll,
}: {
  data: any;
  byEntry: any[];
  byModel: any[];
  loadingAll: boolean;
}) {
  const base = useChartBase();
  return (
    <div className="card-grid cols-2">
      <ChartPanel
        title="按调用入口聚合（平台侧）"
        extra={<span className="tiny">{t('biz.sourceType.costCaliber')}</span>}
        loading={loadingAll}
        empty={byEntry.length === 0}
        emptyTitle={t("cost.noCalls")}
        height={Math.max(180, byEntry.length * 42)}
        option={entryChartOption(byEntry, base)}
      />

      <ChartPanel
        title={modelTitle(data)}
        extra={
          <span className="tiny">
            {data?.modelAttribution === "recorded"
              ? "来自模型调用事件自带的模型标注"
              : data?.modelAttribution === "mixed"
                ? `部分事件带模型标注 (${fmtNum(data?.modelRecordedCalls)} 次实测), 其余按入口路由推定`
                : "事件未记录模型, 按认知服务侧入口路由规则归因"}
          </span>
        }
        loading={loadingAll}
        empty={byModel.length === 0}
        emptyTitle="窗口内没有调用记录"
        height={Math.max(180, byModel.length * 60)}
        option={modelChartOption(byModel, base)}
        footer={<ModelCaliberNote data={data} byModel={byModel} />}
      />
    </div>
  );
}

function ModelCaliberNote({ data, byModel }: { data: any; byModel: any[] }) {
  return (
    <div className={`tiny ${styles.attrNote}`}>
      {data?.modelAttribution === "recorded" ? (
        <>当前口径: <b>事件实测</b> —— 模型调用事件自带模型标注, 直接按事件里的模型聚合, 不再依赖推定。</>
      ) : data?.modelAttribution === "mixed" ? (
        <>
          当前口径: <b>混合</b> —— 窗口内 {fmtNum(data?.modelRecordedCalls)} 次调用带模型标注（实测优先），
          其余老事件没有该标注，按入口路由推定（反思 → 反思模型、结构化 → 结构化模型、其余 → 通用模型）。
        </>
      ) : (
        <>
          当前口径: <b>推定</b> —— 归因规则：反思 / 日结 → 反思模型或通用模型；主提炼 / 结构化 /
          改进任务 → 通用模型。取值来自认知服务侧配置 (当前 <code>{byModel[0]?.model || "-"}</code>)。
          {data?.modelAttribution === "mixed" ? ` 窗口内已有 ${fmtNum(data?.modelRecordedCalls)} 次调用带实测模型标注, 会优先生效。` : " 一旦事件带上模型标注, 本页会自动切换为实测口径。"}
        </>
      )}
    </div>
  );
}
