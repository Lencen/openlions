"use client";
import { fmt } from "./shared";

/** 加载骨架屏: 与原始页面加载态逐字一致 */
export function FlywheelLoading() {
  return (
    <div className="layout-with-sidebar">
      
      <main className="main">
        <div className="page-header"><div className="page-title">飞轮总览</div></div>
        <div className="trend-grid">
          {[0,1,2].map(i => <div key={i} className="trend-card"><div className="skeleton" style={{width:"60%",height:12,marginBottom: "var(--sp-2-5)"}} /><div className="skeleton" style={{width:"40%",height:22,marginBottom: "var(--sp-2-5)"}} /><div className="skeleton" style={{height:40}} /></div>)}
        </div>
        <div className="panel"><div className="skeleton" style={{height:120}} /></div>
      </main>
    </div>
  );
}

/** 面包屑 + 页头 (活跃数据摘要) */
export default function FlywheelHeader({
  totalActive,
  totalH1,
  totalH24,
  totalErrors,
}: {
  totalActive: number;
  totalH1: number;
  totalH24: number;
  totalErrors: number;
}) {
  return (
    <>
      <div className="breadcrumb">
        <span style={{ color: "var(--text-dim)" }}>飞轮引擎</span>
        <span className="sep">/</span>
        <span className="current">飞轮总览</span>
      </div>
      <div className="page-header">
        <div className="page-title">飞轮总览</div>
        {/* 2026-10-20 R10（B9-5 去重）：这行原来把 4 个数字又抄了一遍（活跃/1h/24h/错误），
            和下方 4 张 KPI 卡完全重复。改成一句话说明本页回答什么，数字只在卡片里出现一次。 */}
        <div className="page-subtitle">
          看飞轮转不转、产出多少、哪一环卡住 —— 关键数字见下方四张卡，细节看数据流动与趋势
        </div>
      </div>
    </>
  );
}
