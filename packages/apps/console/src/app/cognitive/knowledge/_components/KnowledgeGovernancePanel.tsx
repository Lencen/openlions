"use client";
// 2026-09-24 IA 整改 (todo_c73421c8e82c424e97e7): 原独立页面 /cognitive/knowledge/governance
// 属 /cognitive/knowledge 的子页却单占菜单位, 违反 2026-09-21 IA 重构
// 「看板不占菜单; 列表/子页走 Tab + 嵌套路由, 均可深链」。
// 本组件抽出治理概览正文, 由知识库页内 Tab 承载; 旧路由 /cognitive/knowledge/governance
// 保留为重定向到 ?tab=governance, 避免既有链接(含 lib/todos.ts 的 source href)404。
//   - 指标来自 console 本地 /api/knowledge-governance(读 mind 库, 口径与 portal 旧接口一致)
//   - 人工审核: 按人类决定(todo_land_jp7xab44pb6g)「审核项=待办」, 统一在 console 待办中心 /todo 处理,
//     本组件不再承载审核 UI (专属 /governance/dedupe 页面已删除)。
//   - 自动治理(cron) vs 人工审核的分工见 docs/platform-logic/knowledge-base-reorg-2026-09-22.md §七
import { useEffect, useState } from "react";
import Link from "next/link";
import KPICard from "@/components/KPICard";
import { useGlobalNonce } from "@/components/GlobalFilter";

export default function KnowledgeGovernancePanel() {
  const [gov, setGov] = useState<any>(null);
  const [dedupe, setDedupe] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // 2026-10-13 round 76-DL: 接入全局刷新(本面板只挂载拉一次)。
  const gf = useGlobalNonce();
  useEffect(() => {
    Promise.all([
      fetch(`/api/knowledge-governance?_gf=${gf}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch(`/api/knowledge-dedupe?_gf=${gf}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ])
      .then(([g, d]) => {
        if (g?.ok) setGov(g);
        if (d?.ok) setDedupe(d);
      })
      .finally(() => setLoading(false));
  }, [gf]);

  const domainFill =
    gov && gov.total ? Math.round((100 * (gov.total - (gov.byDomain?.["(null)"] || 0))) / gov.total) : null;
  const clusterCount = dedupe?.summary?.clusterCount ?? 0;
  const totalDrops = dedupe?.summary?.totalDrops ?? 0;

  return (
    <>
      <div className="page-subtitle" style={{ marginBottom: "var(--sp-3)" }}>
        知识库结构化整理与长期维护。自动治理由定时任务（每周）执行；涉及取代链改动或数据删除的操作需人工审核。
      </div>

      <div className="kpi-grid">
        {loading ? (
          <div className="panel" style={{ padding: "var(--sp-4)" }}>加载中…</div>
        ) : gov ? (
          <>
            <KPICard label="知识总量" value={(gov.total || 0).toLocaleString()} />
            <KPICard label="domain 填充率" value={domainFill !== null ? domainFill + "%" : "-"} />
            <KPICard label="tags 词表命中" value={(gov.tagsVocabHit ?? "-") + "%"} />
            <KPICard label="一句话知识 (<80字)" value={(gov.oneLiners || 0).toLocaleString()} />
            <KPICard label="无元数据" value={(gov.noMeta || 0).toLocaleString()} />
            <KPICard label="低质量 (score<0.4)" value={(gov.quality?.low || 0).toLocaleString()} />
            <KPICard label="已被取代" value={(gov.superseded || 0).toLocaleString()} />
            <KPICard label="待合并 cluster" value={clusterCount.toLocaleString()} />
          </>
        ) : (
          <div className="panel" style={{ padding: "var(--sp-4)", color: "var(--status-crit)" }}>治理接口不可用</div>
        )}
      </div>

      {gov?.byDomain && (
        <div className="panel" style={{ marginBottom: "var(--sp-5)" }}>
          <div className="panel-header"><span className="panel-title">领域分布</span></div>
          <div style={{ padding: "var(--sp-3) var(--sp-4)" }}>
            {Object.entries(gov.byDomain)
              .sort((a: any, b: any) => b[1] - a[1])
              .map(([d, c]: any) => {
                const pct = gov.total ? Math.round((100 * c) / gov.total) : 0;
                return (
                  <div key={d} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2-5)", marginBottom: "var(--sp-1-5)", fontSize: "var(--fs-base)" }}>
                    <span style={{ width: 90, color: d === "(null)" ? "var(--status-warn)" : "var(--text)" }}>{d}</span>
                    <div style={{ flex: 1, height: 6, background: "var(--bg-surface)", borderRadius: "var(--radius-xs)", overflow: "hidden" }}>
                      <div style={{ width: pct + "%", height: "100%", background: d === "(null)" ? "var(--status-warn)" : "var(--primary)" }} />
                    </div>
                    <span style={{ width: 90, textAlign: "right", color: "var(--text-dim)" }}>
                      {c.toLocaleString()} ({pct}%)
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header"><span className="panel-title">人工审核</span></div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2-5)", padding: "var(--sp-3) var(--sp-4)" }}>
          {/* 2026-09-23 审核项=待办 (todo_land_jp7xab44pb6g): 不再做专属审核页, 审核项统一进待办中心 /todo */}
          <Link href="/todo" style={{ textDecoration: "none", color: "inherit" }}>
            <div style={{ padding: "var(--sp-3) var(--sp-3-5)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", display: "flex", alignItems: "center", gap: "var(--sp-3)", cursor: "pointer" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: "var(--fs-md)", marginBottom: "var(--sp-1)" }}>近似重复合并审核（在待办中心处理）</div>
                <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>
                  检出 {clusterCount} 个待合并分组（将影响 {totalDrops} 条取代链）。审核项已按「审核项=待办」统一落到待办中心，
                  点「通过并执行」即自动执行合并并结单；点「提交我的决定」可写驳回意见。
                </div>
              </div>
              <span className="badge" style={{ background: clusterCount > 0 ? "var(--status-warn)" : "var(--bg-surface)", color: clusterCount > 0 ? "var(--on-accent)" : "var(--text-dim)" }}>
                {clusterCount > 0 ? "去待办中心" : "无待办"}
              </span>
            </div>
          </Link>

          <div style={{ padding: "var(--sp-3) var(--sp-3-5)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", opacity: 0.7 }}>
            <div style={{ fontWeight: 600, fontSize: "var(--fs-md)", marginBottom: "var(--sp-1)" }}>自动治理（每周日 03:00 定时任务）</div>
            <div style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>
              domain/tags 启发式回填 · 孤儿链清理 · pending 词评审入词表 · 治理报告。这些操作幂等且仅追加，无需人工确认。
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
