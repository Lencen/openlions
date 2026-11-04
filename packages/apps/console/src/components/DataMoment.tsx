"use client";
// 2026-10-16（round 77-L）**共享件: 逐源"数据时刻"** —— 把"多源页面必须逐源标注"变成**约定 + 一件复用**。
//
// 为什么有它（开工须知 §7: 同一个错误被纠正第 2 次, 就不许再用提醒解决, 必须变成机制）:
//   "借时刻"这个错已经出现 ≥2 次 —— /cognitive（记忆/知识来自 /api/stats, 却标了飞轮看板的时刻 ✗）、
//   /system（服务状态来自 /api/service-ping, 却标了 stats-overview 的时刻 ✗）。
//   而且实测两源刷新节奏**不同**（同一时刻采样, 服务 19:42:00 / 概览 19:41:55, 差 5 秒）——
//   所以"单一页面级时刻"在**多源页面**上必然有一个是错的 ✗。
//
// 用法(把每个数据源各写一条; 取不到的那一侧写 null, 会显式显示「未知」而不是借用别人的时刻 ✓):
//   <DataMoment items={[{ label: "服务", at: pingData?.asOf }, { label: "概览", at: data?.asOf }]} />
//
// 纪律: ①**只在多源页面用**（单源页面写一条没意义, 页面级那行已经够了 ✓）;
//      ②`at` 只填"该组数字真正的来源"提供的时刻 ✓ —— 宁可显示「未知」, **不许借** ✗;
//      ③样式走令牌(间距/字号/颜色) ✓, 与顶栏「本页数据取自 …」是两件事(那是取数时刻, 这里是数据源时刻) ✓。
import { fmtTime, UNKNOWN } from "@/lib/format";

/** 四态里的"加载中"(口径: 与「未知」区分 —— 见 globals 规范铁律 2); 不用"-"以免与空值混淆 */
const LOADING = "加载中";

// 2026-10-16 round 77-AE（由 77-AE 探针发现）: 加**可选** loading 态 —— 铁律 2 要求四态区分
//   「加载中/0/—/未知」✗, 而此前 DataMoment 只会渲染「未知」: 一个要 20 秒才回来的慢接口
//   (如 /api/service-ping) 在加载中会显示「未知」✗, 与"真的取不到"混为一谈。
//   可选 + 默认 undefined = **对既有调用点零影响** ✓(12 个调用点不传就照旧)。
export type DataMomentItem = { label: string; at?: string | number | null; loading?: boolean };

// showPrefix: 某些页面自带的文案已经以「…数据时间」结尾（例如首页 t(overview.source)）——
//   此时再叠一个「数据时刻: 」会出现「数据时间 数据时刻:」的重复 ✗, 故允许关掉前缀 ✓。
export default function DataMoment({ items, style, showPrefix = true }: { items: DataMomentItem[]; style?: React.CSSProperties; showPrefix?: boolean }) {
  const shown = (items || []).filter((x) => x && x.label);
  if (!shown.length) return null;
  return (
    <span className="tiny" style={{ marginLeft: "var(--sp-2)", color: "var(--text-dim)", ...(style || {}) }}>
      {/* 2026-10-16（round 77-L）注意 JSX 空白: 只写 "数据时刻: " 而把 {map} 放下一行, 行尾空格会被吞掉 ✗
          —— 实测渲染成「数据时刻:服务 …」, 与改前的「数据时刻: 服务 …」差一个空格。用 {" "} 显式补上 ✓。 */}
      {showPrefix ? <>数据时刻:{" "}</> : null}
      {shown.map((x, i) => (
        <span key={x.label}>
          {i > 0 ? " · " : ""}
          {x.label} {x.loading && !x.at ? LOADING : (x.at ? fmtTime(x.at) : UNKNOWN)}
        </span>
      ))}
    </span>
  );
}
