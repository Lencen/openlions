"use client";
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useState, useEffect, useCallback } from "react";
import DailyHeader from "./_components/DailyHeader";
import DailyKpis from "./_components/DailyKpis";
import DailyServices from "./_components/DailyServices";
import DailyProductionTable from "./_components/DailyProductionTable";
import DailyQualityPanels from "./_components/DailyQualityPanels";
import DailyHighlights from "./_components/DailyHighlights";
import DailyVerdict from "./_components/DailyVerdict";
import { bjToday } from "./_components/shared";
import type { DailyReport } from "./_components/shared";
import { useGlobalNonce } from "@/components/GlobalFilter";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

export default function DailySummaryPage() {
  const [date, setDate] = useState(bjToday());
  const router = useRouter();

  // 2026-10-19 B3(方案 L3-3): **日期进 URL** —— 修前实测：点「前一天」后地址栏仍是空的 ✗,
  //   管理员看到某天的日报**没法把链接发给同事**, 也没法用浏览器后退回到上一天。
  //   做法照抄仓库既有惯例(/system/guards): 用 window.location 读、router 写，
  //   **不引 useSearchParams** —— 该页是静态预渲染(○ Static)，引了会要求 Suspense 边界 ✗。
  useEffect(() => {
    try {
      const d = new URLSearchParams(window.location.search).get("date");
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
    } catch {}
    // 浏览器前进/后退时同步回状态（可回退 ✓）
    const onPop = () => {
      try {
        // 关键: URL 里没有 date 时也要回到"今天", 否则从 ?date=... 后退到无参时状态不跟随 (实测踩到)
        const d = new URLSearchParams(window.location.search).get("date");
        setDate(d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : bjToday());
      } catch {}
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 日期变化 -> 写进 URL（用 push 而非 replace：日期是"一次导航"，用户期望后退能回到上一天 ✓）
  const changeDate = useCallback((d: string) => {
    setDate(d);
    try { router.push("/audit/daily-summary?date=" + d, { scroll: false }); } catch {}
  }, [router]);
  const [data, setData] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 2026-10-13 round 76-DL: 接入全局刷新(本页只挂载拉一次)。
  const gf = useGlobalNonce();

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/daily-report?date=${d}&_gf=${gf}`);
      // 2026-10-13 round 76-AE: 原来只 await res.json() 而**不检查 res.ok** —— 接口 500 时
      //   错误体 {"error":...} 被当成日结数据, 渲染 d.summary.totalNew 直接抛异常(整页崩)。
      if (!res.ok) throw new Error("请求失败（状态码 " + res.status + "）");
      const json = await res.json();
      setData(json);
    } catch (e) {
      // 2026-10-26：错误文案人话化 —— 不再把「请求失败（状态码 502）」这类技术串打到界面（设计门 C6）。
      //   原始错误进控制台，界面只说要紧的。
      const raw = String((e as Error)?.message || e);
      // eslint-disable-next-line no-console
      console.warn("[daily-summary] 取数失败:", raw);
      setError("今天的日报暂时取不到（数据服务响应异常），可以稍后刷新重试；其余页面不受影响。");
    } finally {
      setLoading(false);
    }
  }, [gf]);

  useEffect(() => { load(date); }, [date, load, gf]);

  const d = data;

  return (
    <div className="layout-with-sidebar">
      
      <main className="main">
        <DailyHeader date={date} setDate={changeDate} />

        {loading && <div className={styles.loading}>加载中...</div>}
        {error && <div className={"data-health " + styles.errorBox} data-state="warn"><span className="dh-text">{error}</span></div>}

        {!loading && !error && !d && (
          <div className={"panel " + styles.emptyPanel}>当日无日结数据。</div>
        )}

        {!loading && !error && d && (
          <>
            {/* 2026-10-26 重整日报维度：结论 → 产出 → 质量 → 需要你做的事 → 人 → 亮点。
                旧顺序是「KPI → 服务状态 → 产出 → 质量 → 亮点」，把运维信息（服务状态）放在第二位，
                读者先看到端口状态才看到业务产出。现在服务状态降级到最后（运维视角），业务在前。 */}
            <DailyVerdict d={d} />
            <DailyProductionTable production={d.production} />
            <DailyQualityPanels d={d} />
            <DailyHighlights d={d} />
            <DailyServices services={d.services} />
          </>
        )}
      </main>
    </div>
  );
}
