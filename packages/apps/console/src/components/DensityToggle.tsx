"use client";
// 2026-10-25 R8：密度切换（舒适 / 紧凑）。默认跟随上次选择，未选则舒适。
import { useEffect, useState } from "react";
import { applyDensity, readDensity, type Density } from "@/lib/density";

export function DensityInit() {
  useEffect(() => { applyDensity(readDensity()); }, []);
  return null;
}

export default function DensityToggle() {
  const [d, setD] = useState<Density>("comfortable");
  useEffect(() => { setD(readDensity()); }, []);
  const pick = (v: Density) => { setD(v); applyDensity(v); };
  return (
    <div className="seg" role="group" aria-label="界面密度">
      <button type="button" aria-pressed={d === "comfortable"} onClick={() => pick("comfortable")}>舒适</button>
      <button type="button" aria-pressed={d === "compact"} onClick={() => pick("compact")}>紧凑</button>
    </div>
  );
}
