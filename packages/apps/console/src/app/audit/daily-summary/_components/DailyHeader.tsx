"use client";
import { bjToday, shiftDate } from "./shared";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "../page.module.css";

/** 面包屑 + 页头 (日期选择器) */
export default function DailyHeader({ date, setDate }: { date: string; setDate: (v: string) => void }) {
  const isToday = date === bjToday();
  return (
    <>
      <div className="breadcrumb">
        <span className={styles.bcDim}>审计</span>
        <span className="sep">/</span>
        <span className="current">每日总结</span>
      </div>

      {/* 日期选择器 */}
      <PageHeader className={styles.headerRow}>
        <div>
          <PageTitle>每日总结</PageTitle>
          <div className="page-subtitle">平台运行日报 · 按日历查看任意日期</div>
        </div>
        <div className={styles.dateRow}>
          <button className="btn" onClick={() => setDate(shiftDate(date, -1))}>← 前一天</button>
          <button className="btn" onClick={() => setDate(bjToday())}>今天</button>
          <button className="btn" onClick={() => setDate(shiftDate(date, 1))} disabled={isToday}>后一天 →</button>
          <input
            type="date"
            aria-label="按日期查看"
            value={date}
            max={bjToday()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className={styles.dateInput}
          />
        </div>
      </PageHeader>
    </>
  );
}
