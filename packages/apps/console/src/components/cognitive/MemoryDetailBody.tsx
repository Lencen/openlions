"use client";
import { humanError } from "@/lib/humanError";
import { fmtStamp as fmtTs } from "@/lib/format";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 记忆详情正文抽成可复用组件 ——
// 详情页(/cognitive/memory/detail)与列表侧边抽屉(CognitiveDetailDrawer)共用同一份渲染, 不再两处漂移。
// 约定: 组件自己按 id 拉数据; 调用方可通过 renderHeader 注入自己的标题区(详情页用 page-header, 抽屉用紧凑标题)。
import type { ReactNode } from "react";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import DiscussionPanel from "@/components/DiscussionPanel";
import { StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { DetailFields, DetailProse, DetailSection, DetailTech } from "@/components/detail";


export default function MemoryDetailBody({
  id,
  renderHeader,
}: {
  id: string;
  renderHeader?: (m: any, loading: boolean) => ReactNode;
}) {
  const { data, loading, error } = useApi<any>("/api/memory-detail?id=" + encodeURIComponent(id));
  const m = data && data.result && data.result.data ? data.result.data : (data || {});
  const theme = m.theme || "";
  const relatedPath = theme ? "/api/memories?page=1&pageSize=5&search=" + encodeURIComponent(theme) + "&sortBy=updatedAt&sortOrder=desc" : "";
  const { data: related } = useApi<any>(relatedPath);
  let relatedItems: any[] = [];
  if (related && Array.isArray(related.items)) {
    relatedItems = related.items.filter(function (r: any) { return r.id !== m.id; }).slice(0, 5);
  }
  if (loading && !m.id) {
    return (<div>{renderHeader ? renderHeader(m, true) : null}<StateBlock loading rows={4} /></div>);
  }
  if (error) {
    return (<div>{renderHeader ? renderHeader(m, false) : null}<div className="panel" style={{ padding: "var(--sp-5)" }}><Alert type="error" message="记忆详情加载失败" description={humanError(error, "这条详情")} /></div></div>);
  }
  return (
    <div>
      {renderHeader ? renderHeader(m, loading) : null}
      {!m.id && <div className="panel"><div style={{ padding: "var(--sp-5)", color: "var(--text-muted)" }}>未找到这条记忆（id: <span className="mono">{id || "-"}</span>）。点列表项查看真实数据。</div></div>}
      {m.id && (
        <div className="dt-stack">
          {/* 2026-10-26：改用统一详情解剖（DetailFields/DetailProse/DetailTech）——
              原来是两张 <table class="tbl"> 定义表（带表头重、列宽不可控），与其它详情页各写一套。 */}
          <div className="dt-grid-2">
            <DetailFields
              title="基础信息"
              cols={1}
              items={[
                { label: "编号", value: m.id, kind: "mono" },
                { label: "标题", value: m.title },
                { label: "类型", value: m.type },
                { label: t('field.tier'), value: m.tier },
                { label: t('field.domain'), value: m.domain },
                { label: "价值分", value: m.valueScore ? Number(m.valueScore).toFixed(2) : "" },
                { label: "重要性", value: m.importance != null ? Number(m.importance).toFixed(2) : "" },
                { label: "质量分", value: m.qualityScore != null ? Number(m.qualityScore).toFixed(2) : "" },
                { label: "主题", value: m.theme },
                { label: "来源", value: m.agentSource || m.sourceType },
                { label: "创建时间", value: fmtTs(m.createdAt) },
                { label: "更新时间", value: fmtTs(m.updatedAt) },
              ]}
            />
            <DetailFields
              title="关联"
              cols={1}
              items={[
                { label: t('field.linkedTo'), value: m.linkedTo },
                { label: t('field.tags'), value: m.tags },
                { label: "强化次数", value: String(m.reinforceCount || 0) },
              ]}
            />
          </div>
          <DetailProse title="内容" text={m.content || m.summary} />
          <DetailTech
            items={[
              { k: "sourceId", v: m.sourceId },
              { k: "contentHash", v: m.contentHash },
              { k: "filePath", v: m.filePath },
              { k: "supersededBy", v: m.supersededBy },
            ]}
          />
          {theme ? (
            <DetailSection title={`同主题记忆（「${theme}」，最多 5 条）`}>
              {relatedItems.length > 0 ? (
                <table className="tbl"><thead><tr><th>标题</th><th>类型</th><th>质量分</th><th>更新时间</th></tr></thead><tbody>
                  {relatedItems.map(function (r: any) {
                    return (<tr key={r.id}><td><a href={"/cognitive/memory/detail?id=" + r.id} style={{ color: "var(--primary)", textDecoration: "none" }}>{r.title || r.id}</a></td><td className="nowrap">{r.type || "-"}</td><td className="num">{r.qualityScore != null ? Number(r.qualityScore).toFixed(2) : "-"}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{r.updatedAt ? String(r.updatedAt).slice(0, 10) : "-"}</td></tr>);
                  })}
                </tbody></table>
              ) : (<div style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>无同主题记录</div>)}
            </DetailSection>
          ) : null}
          {/* 2026-09-10: 通用讨论模块 */}
          <DiscussionPanel entityType="memory" entityId={m.id} title="记忆讨论与协作" />
        </div>
      )}
    </div>
  );
}
