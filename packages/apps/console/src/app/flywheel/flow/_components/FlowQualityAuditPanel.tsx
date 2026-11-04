"use client";
// flywheel/flow 页 · 产出质量不变量自检面板 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import type { FlowData } from "./types";
import { t } from "@/i18n";
import { fmtAge } from "./format";

export default function FlowQualityAuditPanel({ d }: { d: FlowData | null }) {
  return (
    // 2026-10-13 round 76-DS: d 还是 null(加载中)时, 原来走的是**绿色**分支(看起来[全部通过]) -> 改成中性灰。
    <div className="panel" style={{ marginBottom: "var(--sp-4)", borderLeft: !d ? "4px solid var(--border)" : d.qualityAudit && d.qualityAudit.violations > 0 ? "4px solid var(--status-crit)" : "4px solid var(--status-ok)" }}>
      <div className="panel-header">
        <span className="panel-title">产出质量不变量自检（每日 00:20 · 任务产出行）</span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>
          {d?.qualityAudit ? "最近 " + fmtAge(Math.round((d.qualityAudit.ageHours || 0) * 3600)) + " 前 · " + (d.qualityAudit.violations === 0 ? "全部通过" : "违约 " + d.qualityAudit.violations + " 项") : d ? "暂无审计记录（可手动 GET /api/v1/flywheel/quality-audit）" : "…"}
        </span>
      </div>
      {d?.qualityAudit ? (
        <div style={{ fontSize: "var(--fs-base)", lineHeight: 1.7 }}>
          <div>不变量: 无空内容 / 有打分 / 有 contentHash / 无重复 / 可追溯 / 时间统一 —— {d.qualityAudit.violations === 0 ? "6/6 通过" : "未通过: " + (d.qualityAudit.failed || []).join(", ")}</div>
          <div style={{ color: "var(--text-dim)", marginTop: "var(--sp-1)" }}>
            {t('biz.finding.pendingReview')} <b>{d.qualityAudit.observations?.needsReviewFindings ?? 0}</b> · 低置信入队(24h) <b>{d.qualityAudit.observations?.lowConfidenceQueued24h ?? 0}</b> · 未支持 actionType(24h) <b>{d.qualityAudit.observations?.unsupportedActionType24h ?? 0}</b> · 历史知识重复组 <b>{d.qualityAudit.observations?.legacyKnowledgeDupGroups ?? 0}</b> · 文档漂移 <b>{d.qualityAudit.observations?.docDriftDocs ?? 0}</b> 篇
          </div>
          {d.qualityAudit.scorecard && (
            <div style={{ marginTop: "var(--sp-1-5)", paddingTop: "var(--sp-1-5)", borderTop: "1px dashed var(--border,#2a3a4a)" }}>
              <b>组合指标</b>（{t('biz.coverage.col')} 单指标波动大, 需与落地率/质量分/吞吐一起看）：
              {t('biz.coverage.col')} 24h <b>{(d.qualityAudit.scorecard.cov * 100).toFixed(1) + "%"}</b>
              {d.qualityAudit.scorecard.covTrend != null && <span style={{ color: (d.qualityAudit.scorecard.covTrend ?? 0) >= 0 ? "var(--status-ok)" : "var(--status-crit)" }}> ({(d.qualityAudit.scorecard.covTrend ?? 0) >= 0 ? "+" : ""}{(d.qualityAudit.scorecard.covTrend * 100).toFixed(1) + "%"})</span>}
              {" · "}发现落地率 <b>{d.qualityAudit.scorecard.landedRate == null ? "—" : (d.qualityAudit.scorecard.landedRate * 100).toFixed(1) + "%"}</b>
              {" · "}待复核 <b>{d.qualityAudit.scorecard.needsReview ?? 0}</b>
              {" · "}任务成功率 <b>{d.qualityAudit.scorecard.taskDoneRate == null ? "—" : (d.qualityAudit.scorecard.taskDoneRate * 100).toFixed(0) + "%"}</b>（待做 {d.qualityAudit.scorecard.pendingNow ?? 0}）
              {" · "}24h 产物质量 {d.qualityAudit.scorecard.prod.join(" / ")}
            </div>
          )}
        </div>
      ) : <div style={{ fontSize: "var(--fs-base)", color: "var(--text-muted)" }}>—</div>}
    </div>
  );
}
