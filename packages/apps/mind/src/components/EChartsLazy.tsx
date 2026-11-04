"use client";

import dynamic from "next/dynamic";

const ReactEChartsCore = dynamic(
  () => import("echarts-for-react/lib/core"),
  { ssr: false }
);

export default ReactEChartsCore;
