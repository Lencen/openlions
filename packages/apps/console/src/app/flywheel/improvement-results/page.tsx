"use client";
// 2026-09-24 [可见性缺口] todo_bdce470195d94307abff:
//   按来源(如 uos20-feedback)一屏看「某次反馈的需求改进到什么程度」——
//   待办状态 / 任务状态 / 验收结论 / 证据锚点。此前只能跨 4 张表人工拼。
//   ★ DONE 不等于验收通过: 两列并列展示, 不再混淆。
import { useState } from "react";
import LoadingBlock from "@/components/LoadingBlock";
import Link from "next/link";
import { Empty } from "@/components/primitives";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { useApi } from "@/lib/api";
import TableCopyButton from "@/components/TableCopyButton";
import KPICard from "@/components/KPICard";
import StuckTasksStrip from "./_components/StuckTasksStrip";
import ErrorAlert from "@/components/ErrorAlert";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

export default function ImprovementResultsPage() {
  // 2026-10-13 round 76-CE: 改用 useApi(path, { pollMs: 0 }) —— 自带序号守卫与非 2xx 错误通道,
  //   于是删掉 76-CC 手写的 seq 守卫。source 变化 -> path 变化 -> 自动重取。
  const f = useGlobalFilter();
  const [source, setSource] = useState("uos20-feedback");
  const [q, setQ] = useState("uos20-feedback");
  const { data: raw, error: fetchErr, mutate } = useApi<any>(
    "/api/improvement-results?source=" + encodeURIComponent(q) + "&limit=200&range=" + f.range + "&_n=" + f.nonce, { pollMs: 0 });
  // 上游也可能以 200 + {ok:false, error} 的形式报告失败(BFF 转发上游状态), 故仍按 ok 字段判定。
  const data = raw && raw.ok === false ? null : raw;
  const err = fetchErr ? String((fetchErr as Error)?.message || fetchErr) : (raw && raw.ok === false ? String(raw.error || "加载失败") : null);

  const badge = (st: string) => (
    <span className={"badge " + (st === "PASS" ? "badge-green" : st === "FAIL" ? "badge-red" : "")}
      style={st === "PENDING" ? { background: "var(--bg-surface2)" } : undefined}>
      {st === "PASS" ? "✅ 通过" : st === "FAIL" ? "❌ 未过" : "待判定"}
    </span>
  );

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>改进结果（按来源）</PageTitle>
        <div className="page-subtitle">某个来源的需求改进到什么程度：待办状态 · 任务状态 · 验收结论 · 证据锚点。DONE ≠ 验收通过。</div>
      </PageHeader>
      {/* 2026-10-19 B4(方案 L2-1): 修前这三个数字挤在筛选条里的一行 tiny 小字里 ✗,
          管理员第一眼看不到"到底过了几条"。提升为 ≤3 张 KPI 卡(带单位"项"与口径"近 7 天")。
          数据时刻: 本页**单源**(只有 /api/improvement-results), 按 DataMoment 自身纪律不在页内重复标注,
          由既有全局机制(顶栏「本页数据取自 …」)提供 ✓ —— 不借时刻、也不重复 ✗。 */}
      {data ? (
        <div className="kpi-grid" style={{ marginBottom: "var(--sp-3)" }}>
          {/* R4：一个视觉锚点——"通过率"（原页面三张卡同等重要，第一眼看不出好在哪） */}
          <KPICard
            label="验收通过率"
            size="hero"
            value={data.count ? Math.round(((data.summary?.PASS ?? 0) / data.count) * 100) + "%" : "暂无"}
            delta={"共 " + (data.count ?? 0) + " 项 · 待判定 " + (data.summary?.PENDING ?? 0)}
          />
          <KPICard
            label="验收通过（项）"
            value={data.summary?.PASS ?? 0}
            delta={data.count ? "占 " + Math.round(((data.summary?.PASS ?? 0) / data.count) * 100) + "%" : data.rangeLabel || ""}
            deltaDir="up"
          />
          <KPICard
            label="未通过（项）"
            value={data.summary?.FAIL ?? 0}
            delta={data.rangeLabel || ""}
            deltaDir="down"
          />
          <KPICard
            label="待判定（项）"
            value={data.summary?.PENDING ?? 0}
            delta={"来源 " + (data.source || q)}
          />
        </div>
      ) : null}
      <StuckTasksStrip />
      <div className="panel" style={{ marginBottom: "var(--sp-3)" }}>
        <span className="tiny" style={{ marginRight: "var(--sp-2)" }}>来源</span>
        <input className="input" value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 260 }}
          placeholder="如 uos20-feedback" onKeyDown={(e) => { if (e.key === "Enter") setQ(source.trim()); }} />
        <button className="btn" style={{ marginLeft: "var(--sp-2)" }} onClick={() => setQ(source.trim())}>查询</button>
        {data ? (
          <span className="tiny" style={{ marginLeft: "var(--sp-3)" }}>
            共 {data.count} 项 · <span style={{ color: "var(--status-ok)" }}>PASS {data.summary?.PASS ?? 0}</span> /{" "}
            <span style={{ color: "var(--status-crit)" }}>FAIL {data.summary?.FAIL ?? 0}</span> / 待判定 {data.summary?.PENDING ?? 0}
          </span>
        ) : null}
      </div>
      {err ? <ErrorAlert title="改进结果加载失败" message={err} onRetry={() => { mutate(); }} /> : !data ? <LoadingBlock lines={2} label="改进结果加载中" /> : (data.items || [] || []).length === 0 ? <div style={{padding: "var(--sp-5)"}}><Empty description={"来源「" + q + "」没有改进记录 —— 换个来源试试，或去 升级任务 里看全部"} /></div> : (
        <div className="panel"><TableCopyButton />
        <table className="tbl"><thead><tr>
          <th>整体验收</th><th>待办状态</th><th>来源待办</th><th>升级任务（状态 / 验收）</th><th>证据锚点</th>
        </tr></thead><tbody>
          {(data.items || []).map((it: any) => (
            <tr key={it.todoId}>
              <td>{badge(it.overallState)}</td>
              <td className="mono">{it.todoStatus}</td>
              <td>
                <div>{it.todoTitle}</div>
                <div className="tiny mono">{it.todoId}</div>
              </td>
              <td>
                {(it.tasks || []).length === 0 ? <span className="tiny">无</span> : (it.tasks || []).map((t: any) => (
                  <div key={t.id} className="tiny" style={{ marginBottom: "var(--sp-0-5)" }}>
                    {badge(t.acceptance?.state)} <span className="mono">{t.status}</span> {String(t.title || "").slice(0, 34)}
                    {t.acceptance?.fails?.length ? <span style={{ color: "var(--status-crit)" }}> · 未过: {t.acceptance.fails.join(",")}</span> : null}
                  </div>
                ))}
              </td>
              <td className="tiny mono" style={{ maxWidth: 320, whiteSpace: "pre-wrap" }}>
                {(it.evidenceAnchors || []).slice(0, 3).map((a: string, i: number) => <div key={i}>{a}</div>)}
              </td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/todo">来源待办 →</Link>
        <Link href="/flywheel/tasks">升级任务 →</Link>
      </div>
    </main>
  );
}