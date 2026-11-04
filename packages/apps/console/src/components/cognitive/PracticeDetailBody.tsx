"use client";
import { humanError } from "@/lib/humanError";
import { fmtStamp as fmtTs } from "@/lib/format";
// 2026-09-14 UI-3: 实践详情正文抽成可复用组件 (详情页 + 列表侧边抽屉共用)。
import type { ReactNode } from "react";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import DiscussionPanel from "@/components/DiscussionPanel";
import { StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { DetailFields, DetailProse } from "@/components/detail";


export default function PracticeDetailBody({
  id,
  renderHeader,
}: {
  id: string;
  renderHeader?: (p: any, loading: boolean) => ReactNode;
}) {
  const { data, loading, error } = useApi<any>(`/api/practice-detail?id=${encodeURIComponent(id)}`);
  const p = data?.result?.data ?? data ?? {};
  if (loading && !p.id) {
    return (<div>{renderHeader ? renderHeader(p, true) : null}<StateBlock loading rows={4} /></div>);
  }
  if (error) {
    return (<div>{renderHeader ? renderHeader(p, false) : null}<div className="panel" style={{ padding: "var(--sp-5)" }}><Alert type="error" message="实践详情加载失败" description={humanError(error, "这条详情")} /></div></div>);
  }
  return (
    <div>
      {renderHeader ? renderHeader(p, loading) : null}
      {!p.id && <div className="panel"><div style={{ padding: "var(--sp-5)", color: "var(--text-muted)" }}>未找到这条实践（id: <span className="mono">{id || "-"}</span>）。点列表项查看真实数据。</div></div>}
      {p.id && <><div className="dt-stack">
        {/* 2026-10-26：统一详情解剖（单列，因为字段少；两列会显得空） */}
        <DetailFields title="基础信息" cols={1} items={[
          { label: "编号", value: p.id, kind: "mono" },
          { label: "标题", value: p.title },
          { label: "类型", value: p.type },
          { label: "难度", value: p.difficulty },
          { label: "质量分", value: p.qualityScore != null ? Number(p.qualityScore).toFixed(2) : "" },
          { label: "主题", value: p.theme },
          { label: t('field.outcome'), value: p.outcome },
          { label: "来源", value: p.agentSource || p.sourceType },
          { label: "开始", value: fmtTs(p.startedAt) },
          { label: "完成", value: fmtTs(p.completedAt) },
          { label: "更新时间", value: fmtTs(p.updatedAt) },
        ]} />
        <DetailProse title="描述" text={p.description} />
      </div>
      {/* 2026-09-10: 通用讨论模块 */}
      <DiscussionPanel entityType="practice" entityId={p.id} title="实践讨论与协作" /></>}
    </div>
  );
}
