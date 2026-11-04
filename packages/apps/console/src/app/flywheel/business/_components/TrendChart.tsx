"use client";
import EChart from "@/components/EChart";

const C = {
  memory: "#0d9488", knowledge: "#7c3aed", practice: "#d97706", skill: "#2563eb",
  structured: "#dc2626", newTasks: "#94a3b8", claims: "#64748b", done: "#16a34a", agentDone: "#2563eb",
};

function markR3(series: any[]) {
  const start = series.find((x) => x.regime === "R3");
  if (!start) return undefined;
  return {
    silent: true,
    itemStyle: { color: "rgba(220,38,38,0.06)" },
    label: { show: true, position: "insideTop", color: "#dc2626", fontSize: 11, formatter: "R3 交付崩塌期" },
    data: [[{ xAxis: start.date.slice(5) }, { xAxis: series[series.length - 1].date.slice(5) }]],
  };
}

export function OutputTrend({ series }: { series: any[] }) {
  const dates = series.map((x) => String(x.date).slice(5));
  const option = {
    grid: { left: 48, right: 16, top: 36, bottom: 48 },
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, type: "scroll" },
    xAxis: { type: "category", data: dates },
    yAxis: { type: "value" },
    series: [
      { name: "记忆", type: "bar", stack: "out", data: series.map((x) => x.output.Memory), itemStyle: { color: C.memory }, markArea: markR3(series) },
      { name: "知识", type: "bar", stack: "out", data: series.map((x) => x.output.Knowledge), itemStyle: { color: C.knowledge } },
      { name: "实践", type: "bar", stack: "out", data: series.map((x) => x.output.Practice), itemStyle: { color: C.practice } },
      { name: "技能", type: "bar", stack: "out", data: series.map((x) => x.output.Skill), itemStyle: { color: C.skill } },
      { name: "结构化产物", type: "line", data: series.map((x) => x.structured), itemStyle: { color: C.structured }, lineStyle: { color: C.structured, width: 2 }, symbolSize: 4 },
    ],
  };
  return <EChart option={option} height={280} />;
}

export function FlowTrend({ series }: { series: any[] }) {
  const dates = series.map((x) => String(x.date).slice(5));
  const option = {
    grid: { left: 48, right: 16, top: 36, bottom: 48 },
    tooltip: { trigger: "axis" },
    legend: { bottom: 0, type: "scroll" },
    xAxis: { type: "category", data: dates },
    yAxis: { type: "value" },
    series: [
      { name: "新任务", type: "line", data: series.map((x) => x.newTasks), itemStyle: { color: C.newTasks }, lineStyle: { color: C.newTasks, width: 2 }, symbolSize: 3, markArea: markR3(series) },
      { name: "认领", type: "line", data: series.map((x) => x.claims), itemStyle: { color: C.claims }, lineStyle: { color: C.claims, width: 2 }, symbolSize: 3 },
      { name: "完成", type: "line", data: series.map((x) => x.done), itemStyle: { color: C.done }, lineStyle: { color: C.done, width: 2 }, symbolSize: 3 },
      { name: "智能体交付", type: "line", data: series.map((x) => x.agentDone), itemStyle: { color: C.agentDone }, lineStyle: { color: C.agentDone, width: 2, type: "dashed" }, symbolSize: 3 },
    ],
  };
  return <EChart option={option} height={280} />;
}
