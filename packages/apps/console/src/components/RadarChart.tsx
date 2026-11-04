"use client";
import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface Props {
  data: { completion: number; runtime: number; logic: number; dataMath: number; structure: number; quality: number };
  color?: string;
}

export default function RadarChart({ data, color = "#a78bfa" }: Props) {
  const option = {
    radar: {
      indicator: [
        { name: "完成度", max: 100 },
        { name: "运行", max: 100 },
        { name: "逻辑", max: 100 },
        { name: "数理", max: 100 },
        { name: "结构化", max: 100 },
        { name: "质量", max: 100 },
      ],
      axisName: { color: "#94a3b8", fontSize: "var(--fs-sm)" },
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
      splitArea: { areaStyle: { color: ["rgba(255,255,255,0.02)", "rgba(255,255,255,0.04)"] } },
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.08)" } },
    },
    series: [{
      type: "radar",
      data: [{
        value: [data.completion, data.runtime, data.logic, data.dataMath, data.structure, data.quality],
        name: "飞轮健康度",
        areaStyle: { color: color + "33" },
        lineStyle: { color, width: 2 },
        itemStyle: { color },
      }],
    }],
  };
  return <ReactECharts option={option} style={{ height: 280 }} />;
}
