"use client";
import { humanError } from "@/lib/humanError";
import { fmtStamp as fmtTs } from "@/lib/format";
// 2026-09-14 UI-3: 知识详情正文抽成可复用组件 (详情页 + 列表侧边抽屉共用)。
import type { ReactNode } from "react";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import DiscussionPanel from "@/components/DiscussionPanel";
import { StateBlock } from "@/components/ui";
import { t as tr } from "@/i18n";
import { DetailFields, DetailProse, DetailTech } from "@/components/detail";


// 2026-09-03: 知识模板正文渲染 (陈述式: #结论 / ##原理 / ##事实 / ##边界 / ##案例)
export function renderKt(content?: string): any {
  if (!content) return "(无内容)";
  const lines = String(content).split("\n");
  const out: any[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push(<p key={out.length} style={{ margin: "var(--sp-0-5) 0 var(--sp-2)" }}>{para.join("\n")}</p>); para = []; } };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { flush(); continue; }
    if (t.startsWith("# ")) { flush(); out.push(<h4 key={out.length} style={{ margin: "var(--sp-2-5) 0 var(--sp-1)", color: "var(--primary)" }}>{t.slice(2)}</h4>); }
    else if (t.startsWith("## ")) { flush(); out.push(<h5 key={out.length} style={{ margin: "var(--sp-2) 0 var(--sp-0-5)", fontWeight: 700 }}>{t.slice(3)}</h5>); }
    else if (t.startsWith("> ")) { flush(); out.push(<p key={out.length} style={{ color: "var(--primary)", fontWeight: 600, margin: "var(--sp-0-5) 0 var(--sp-2)" }}>{t.slice(2)}</p>); }
    else para.push(raw);
  }
  flush();
  return out.length ? out : String(content);
}

export default function KnowledgeDetailBody({
  id,
  renderHeader,
}: {
  id: string;
  renderHeader?: (k: any, loading: boolean) => ReactNode;
}) {
  const { data, loading, error } = useApi<any>(`/api/knowledge-detail?id=${encodeURIComponent(id)}`);
  const k = data?.result?.data ?? data ?? {};
  if (loading && !k.id) {
    return (<div>{renderHeader ? renderHeader(k, true) : null}<StateBlock loading rows={4} /></div>);
  }
  if (error) {
    return (<div>{renderHeader ? renderHeader(k, false) : null}<div className="panel" style={{ padding: "var(--sp-5)" }}><Alert type="error" message="知识详情加载失败" description={humanError(error, "这条详情")} /></div></div>);
  }
  return (
    <div>
      {renderHeader ? renderHeader(k, loading) : null}
      {!k.id && <div className="panel"><div style={{ padding: "var(--sp-5)", color: "var(--text-muted)" }}>未找到这条知识（id: <span className="mono">{id || "-"}</span>）。点列表项查看真实数据。</div></div>}
      {k.id && <><div className="dt-stack">
        <div className="dt-grid-2">
          {/* 2026-10-26：改用统一详情解剖（与记忆详情同一套组件） */}
          <DetailFields title="基础信息" cols={1} items={[
            { label: "编号", value: k.id, kind: "mono" },
            { label: "标题", value: k.title },
            { label: "分类", value: k.category },
            { label: "置信度", value: k.confidence != null ? Number(k.confidence).toFixed(2) : "" },
            { label: "质量分", value: k.qualityScore != null ? Number(k.qualityScore).toFixed(2) : "" },
            { label: tr('field.domain'), value: k.domain },
            { label: "主题", value: k.theme },
            { label: "使用次数", value: String(k.usageCount ?? 0) },
            { label: "创建时间", value: fmtTs(k.createdAt) },
            { label: "更新时间", value: fmtTs(k.updatedAt) },
          ]} />
          <DetailFields title="标签与溯源" cols={1} items={[
            { label: tr('field.tags'), value: (k.tags || "").split(",").filter(Boolean).map((t: string) => <span key={t} className="badge badge-blue" style={{ marginRight: "var(--sp-1)" }}>{t}</span>) },
            { label: "来源", value: k.agentSource || k.sourceType },
            { label: "来源明细", value: k.sourceDetail },
          ]} />
        </div>
        <DetailProse title="内容" text={renderKt(k.content)} />
        <DetailTech items={[
          { k: "sourceId", v: k.sourceId },
          { k: "contentHash", v: k.contentHash ? String(k.contentHash).slice(0, 16) + "…" : null },
          { k: "reinforceCount", v: k.reinforceCount ?? 0 },
          { k: "filePath", v: k.filePath },
        ]} />
      </div>
      {/* 2026-09-10: 通用讨论模块 (时间线 + 发言 + @agent 提问) */}
      <DiscussionPanel entityType="knowledge" entityId={k.id} title="知识讨论与协作" /></>}
    </div>
  );
}
