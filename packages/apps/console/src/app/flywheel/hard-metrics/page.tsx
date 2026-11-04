"use client";
// 飞轮硬指标看板 (2026-09-21 Q6#2): 同类任务成功率/自主率/泛化 + 周环比 + 触底标记
import { useEffect, useState } from "react";
import BarChart from "@/components/BarChart";
import Link from "next/link";
import { Empty } from "@/components/primitives";
import { useGlobalNonce } from "@/components/GlobalFilter";
import TableCopyButton from "@/components/TableCopyButton";
import KPICard from "@/components/KPICard";
import { scopeLabelOfType } from "@/config/taskScopes";

export default function HardMetricsPage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  // 2026-10-13 round 76-DK: 本页**只挂载拉一次、无轮询**, 也不跟顶栏刷新 -> 接入 useGlobalNonce。
  const gf = useGlobalNonce();
  useEffect(() => {
    fetch(`/api/hard-metrics?_gf=${gf}`, { cache: "no-store" }).then((r) => r.json()).then((j) => j.ok ? setData(j) : setErr(j.error + " " + (j.hint || ""))).catch((e) => setErr(String(e)));
  }, [gf]);

  return (
    <main className="page">
      <div className="page-header"><div className="page-title">飞轮硬指标</div>
        <div className="page-subtitle">同类任务成功率 · 自主完成率 · 跨主题泛化 · 周环比底线（触底自动开改进任务）</div></div>
      {err ? <div className="tiny" style={{ color: "var(--status-warn)" }}>{err}</div> : !data ? <div className="tiny">加载中…</div> : (
        <>
          {/* 2026-10-19 B4(方案 L2-1): 修前本页一个 KPI 卡都没有 ✗ —— "触底了几个"要管理员自己数表格。补 ≤3 张 ✓ */}
          {(() => {
            const ms = data.metrics || [];
            const nSum = ms.reduce((a: number, m: any) => a + (Number(m.n7d) || 0), 0);
            const dSum = ms.reduce((a: number, m: any) => a + (Number(m.done7d) || 0), 0);
            const breached = ms.filter((m: any) => m.breached).length;
            return (
              <div className="kpi-grid" style={{ marginBottom: "var(--sp-3)" }}>
                <KPICard label="触底维度（个）" value={breached} delta={breached ? "需开改进任务" : "无触底"} deltaDir={breached ? "down" : "up"} />
                <KPICard label="7 天整体成功率" value={nSum ? (dSum / nSum * 100).toFixed(1) + "%" : "-"} delta={"完成 " + dSum + " / 样本 " + nSum} />
                <KPICard label="7 天样本（条）" value={nSum} delta={"任务类型 " + ms.length + " 类"} />
              </div>
            );
          })()}          {/* 2026-10-19 B7(方案 L4): 修前本页 0 个 svg(只有表格) ✗ —— 加"本周 vs 上周成功率"迷你对比条;
              数据全部来自同一份 /api/hard-metrics ✓, 复用既有 BarChart(不引图表库 ✗)。 */}
          {(data.metrics || []).length > 0 && (
            <div className="panel" style={{ marginBottom: "var(--sp-3)" }}>
              <div className="panel-header"><span className="panel-title">本周 vs 上周 成功率</span></div>
              <div style={{ padding: "var(--sp-3)" }}>
                <BarChart bars={(data.metrics || []).flatMap((m: any) => ([
                  { label: scopeLabelOfType(m.type) + " · 本周", value: Math.round((m.doneRate7d ?? 0) * 100), color: "var(--primary)" },
                  { label: scopeLabelOfType(m.type) + " · 上周", value: Math.round((m.prevDoneRate ?? 0) * 100), color: "var(--text-muted)" },
                ]))} />
              </div>
            </div>
          )}

          <div className="tiny" style={{ marginBottom: "var(--sp-2)" }}>统计时间 {data.at} · 触底阈值 -{(data.dropThreshold * 100).toFixed(0)}%（样本 ≥{data.minN}）</div>
          {(data.metrics || []).length > 0 ? <div className="panel"><TableCopyButton />
          <table className="tbl"><thead><tr>
            <th>任务类型</th><th>样本(n)</th><th>成功率</th><th>自主完成率</th><th>跨主题泛化</th><th>上周成功率</th><th>周环比</th><th>触底</th>
          </tr></thead><tbody>
            {(data.metrics || []).map((m: any) => (
              <tr key={m.type}>
                <td title={m.type}>{scopeLabelOfType(m.type)}</td>
                <td>{m.n7d}</td>
                <td>{m.doneRate7d != null ? (m.doneRate7d * 100).toFixed(1) + "%" : "-"}</td>
                <td>{m.autonomy7d != null ? (m.autonomy7d * 100).toFixed(1) + "%" : "-"}</td>
                <td>{m.themes7d}</td>
                <td>{m.prevDoneRate != null ? (m.prevDoneRate * 100).toFixed(1) + "%" : "-"}</td>
                <td style={{ color: m.delta != null ? (m.delta < 0 ? "var(--status-crit)" : "var(--status-ok)") : "inherit" }}>
                  {m.delta != null ? (m.delta >= 0 ? "+" : "") + (m.delta * 100).toFixed(1) + "%" : "-"}</td>
                <td>{m.breached ? <span className="badge badge-red">触底</span> : <span className="tiny">-</span>}</td>
              </tr>
            ))}
          </tbody></table></div> : <Empty description="暂无硬指标数据" />}
        </>
      )}
      {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/flywheel/tasks">触底开出的改进任务 →</Link>
        <Link href="/flywheel/coverage">覆盖率 →</Link>
      </div>
    </main>
  );
}