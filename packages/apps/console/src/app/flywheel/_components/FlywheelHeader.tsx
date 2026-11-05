"use client";
// 2026-11-04（ord-20261104-032）：页头已由 page.tsx 直出（本件当前无引用），
//   保留是为了不删功能；同时把这里的 3 处内联样式换成本页 CSS Module 的类。
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "../page.module.css";

/** 加载骨架屏: 与原始页面加载态逐字一致 */
export function FlywheelLoading() {
  return (
    <div className="layout-with-sidebar">
      
      <main className="main">
        <PageHeader><PageTitle>飞轮总览</PageTitle></PageHeader>
        <div className="trend-grid">
          {[0,1,2].map(i => <div key={i} className="trend-card"><div className={"skeleton " + styles.skelTitle} /><div className={"skeleton " + styles.skelValue} /><div className={"skeleton " + styles.skelBar} /></div>)}
        </div>
        <div className="panel"><div className={"skeleton " + styles.skelBlock} /></div>
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
        <span className={styles.crumbDim}>飞轮引擎</span>
        <span className="sep">/</span>
        <span className="current">飞轮总览</span>
      </div>
      <PageHeader>
        <PageTitle>飞轮总览</PageTitle>
        {/* 2026-10-20 R10（B9-5 去重）：这行原来把 4 个数字又抄了一遍（活跃/1h/24h/错误），
            和下方 4 张 KPI 卡完全重复。改成一句话说明本页回答什么，数字只在卡片里出现一次。 */}
        <div className="page-subtitle">
          看飞轮转不转、产出多少、哪一环卡住 —— 关键数字见下方四张卡，细节看数据流动与趋势
        </div>
      </PageHeader>
    </>
  );
}
