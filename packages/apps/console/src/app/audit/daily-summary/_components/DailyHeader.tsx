"use client";
// 页头右侧的日期控件
// 2026-11-05 页头口径统一（UIUX PAGE-HEADER-31 §3 #16）：面包屑/标题/一句说明已上移到 page.tsx，
//   本组件只剩「前一天 / 今天 / 后一天 + 日期输入」。文件名沿用 DailyHeader（仅 page.tsx 引用），
//   不改名以免扩大改动面。
import { bjToday, shiftDate } from "./shared";
import styles from "../page.module.css";

/** 日期选择器（页头右侧动作区） */
export default function DailyHeader({ date, setDate }: { date: string; setDate: (v: string) => void }) {
  const isToday = date === bjToday();
  return (
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
  );
}
