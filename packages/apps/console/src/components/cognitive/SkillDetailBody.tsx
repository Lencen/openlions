"use client";
import { humanError } from "@/lib/humanError";
import { fmtStamp as fmtTs } from "@/lib/format";
// 2026-09-14 UI-3: 技能详情正文抽成可复用组件 (详情页 + 列表侧边抽屉共用)。
import type { ReactNode } from "react";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import DiscussionPanel from "@/components/DiscussionPanel";
import { StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { DetailFields, DetailProse } from "@/components/detail";


export default function SkillDetailBody({
  id,
  renderHeader,
}: {
  id: string;
  renderHeader?: (s: any, loading: boolean) => ReactNode;
}) {
  const { data, loading, error } = useApi<any>(`/api/skill-detail?id=${encodeURIComponent(id)}`);
  const s = data?.result?.data ?? data ?? {};
  const hasSteps = s.content && String(s.content).trim().length > 0;
  if (loading && !s.id) {
    return (<div>{renderHeader ? renderHeader(s, true) : null}<StateBlock loading rows={4} /></div>);
  }
  if (error) {
    return (<div>{renderHeader ? renderHeader(s, false) : null}<div className="panel" style={{ padding: "var(--sp-5)" }}><Alert type="error" message="技能详情加载失败" description={humanError(error, "这条详情")} /></div></div>);
  }
  return (
    <div>
      {renderHeader ? renderHeader(s, loading) : null}
      {!s.id && <div className="panel"><div style={{ padding: "var(--sp-5)", color: "var(--text-muted)" }}>未找到这条技能（id: <span className="mono">{id || "-"}</span>）。点列表项查看真实数据。</div></div>}
      {s.id && <><div className="dt-stack">
        <div className="dt-grid-2">
          {/* 2026-10-26：统一详情解剖（与记忆/知识详情同一套组件） */}
          <DetailFields title="基础信息" cols={1} items={[
            { label: "编号", value: s.id, kind: "mono" },
            { label: "业务名", value: s.businessName || s.name },
            { label: "技术名", value: s.technicalName, kind: "mono" },
            { label: "分类", value: s.category },
            { label: "等级", value: s.level },
            { label: "来源", value: s.source },
            { label: "使用次数", value: String(s.totalUsageCount ?? 0) },
            { label: "质量分", value: s.qualityScore != null ? Number(s.qualityScore).toFixed(2) : "" },
            { label: "版本", value: String(s.version ?? 1) + (s.legacy ? "（存量）" : "") },
            { label: "步骤", value: hasSteps ? "有可执行步骤" : "无步骤" },
            { label: t('field.parentSkill'), value: s.parentSkillId, kind: "mono" },
            { label: "平台", value: s.platforms },
            { label: "创建时间", value: fmtTs(s.createdAt) },
            { label: "更新时间", value: fmtTs(s.updatedAt) },
          ]} />
          <DetailFields title="匹配规则" cols={1} items={[
            { label: t('field.autoMatch'), value: s.autoMatchRules },
            { label: t('field.usageMethod'), value: s.usageMethod },
            { label: t('field.selfAssessment'), value: s.selfAssessment },
          ]} />
        </div>
        <DetailProse title="描述" text={s.description} />
        <DetailProse title="适用场景" text={s.trigger} />
        <DetailProse title="执行步骤" text={s.content} empty="(无步骤)" />
        <DetailProse title="验证方法" text={s.verification} />
        <DetailProse title="已知坑" text={s.pitfalls} />
      </div>
      {/* 2026-09-10: 通用讨论模块 */}
      <DiscussionPanel entityType="skill" entityId={s.id} title="技能讨论与协作" />
      </>}
    </div>
  );
}
