"use client";
import { bjToday, shiftDate } from "./shared";

/** 面包屑 + 页头 (日期选择器) */
export default function DailyHeader({ date, setDate }: { date: string; setDate: (v: string) => void }) {
  const isToday = date === bjToday();
  return (
    <>
      <div className="breadcrumb">
        <span style={{ color: "var(--text-dim)" }}>审计</span>
        <span className="sep">/</span>
        <span className="current">每日总结</span>
      </div>

      {/* 日期选择器 */}
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "var(--sp-3)" }}>
        <div>
          <div className="page-title">每日总结</div>
          <div className="page-subtitle">平台运行日报 · 按日历查看任意日期</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <button className="btn" onClick={() => setDate(shiftDate(date, -1))}>← 前一天</button>
          <button className="btn" onClick={() => setDate(bjToday())}>今天</button>
          <button className="btn" onClick={() => setDate(shiftDate(date, 1))} disabled={isToday}>后一天 →</button>
          <input
            type="date"
            aria-label="按日期查看"
            value={date}
            max={bjToday()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            style={{ padding: "var(--sp-1-5) var(--sp-2-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--bg-surface2)", color: "var(--text)", fontSize: "var(--fs-md)" }}
          />
        </div>
      </div>
    </>
  );
}
