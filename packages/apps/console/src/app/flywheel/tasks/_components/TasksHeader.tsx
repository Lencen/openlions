"use client";
import Link from "next/link";
import KPICard from "@/components/KPICard";
import { Button } from "@/components/primitives";
import { fmtNum } from "./shared";
import type { Counts } from "./shared";

/** 面包屑 + 页头 + 任务 KPI 行 */
export default function TasksHeader({
  loading,
  counts,
  itemCount,
}: {
  loading: boolean;
  counts: Counts;
  itemCount: number;
}) {
  const bs = counts.byStatus;
  return (
    <>
      <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>飞轮引擎</span><span className="sep">/</span><span className="current">改进任务看板</span></div>
      <div className="page-header">
        <div className="page-title">改进任务看板</div>
        <div className="page-subtitle">{loading ? "（加载中...）" : "全库 " + fmtNum(counts.total) + " 条 · 当前列表 " + itemCount + " 条"}</div>
        {/* 2026-10-13 round 76-BT: 手工建任务入口(从 selfimproving 的 /tasks/new 搬来) */}
        <div style={{ marginTop: "var(--sp-2)" }}><Link href="/flywheel/tasks/new"><Button type="primary">新建任务</Button></Link></div>
      </div>
      {/* 2026-10-13 round 76-DP: 4 个 KPI 里**只有"任务总数"有守卫**, 而且那个守卫写错了
          (`counts.total > 0 ? num : "..."` —— 真为 0 时也会显示"…", 加载中却可能显示数字)。
          另外 3 个**无条件显示 0** -> 首屏看起来"待做 0 / 完成 0 / 失败 0"(假计数)。
          改为统一用 loading 守卫。 */}
      <div className="kpi-grid">
        <KPICard label="任务总数" value={loading ? "..." : fmtNum(counts.total)} />
        <KPICard label="待做" value={loading ? "..." : fmtNum((bs.PENDING ?? 0) + (bs.PROCESSING ?? 0) + (bs.IN_PROGRESS ?? 0))} />
        <KPICard label="完成" value={loading ? "..." : fmtNum(bs.DONE ?? 0)} />
        <KPICard label="失败" value={loading ? "..." : fmtNum(bs.FAILED ?? 0)} />
      </div>
    </>
  );
}
