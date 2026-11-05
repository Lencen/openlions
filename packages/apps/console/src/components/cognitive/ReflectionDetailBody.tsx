"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3: 反思详情正文抽成可复用组件 (详情页 + 列表侧边抽屉共用)。
// 两个 id 体系并存 (旧 Reflection 记录 / 主题反思 FlywheelReflection), 逻辑保持原样:
//   - 讨论面板挂载目标: 优先主题反思 (本轮反思), 否则旧反思记录
// 2026-11-05 P2 呈现层（批 4/5）：内联 style 清零（类在同名 ReflectionDetailBody.module.css）。
//   结构与文案、取数（/api/reflection-detail）与两个 id 体系的判定逻辑均未动。
import type { ReactNode } from "react";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { t } from "@/i18n";
import DiscussionPanel from "@/components/DiscussionPanel";
import { Pill, StateBlock } from "@/components/ui";
import { fmtNum, fmtScore, fmtStamp as fmtTs, relTime, truncate } from "@/lib/format";
import { DetailFields, DetailProse, DetailSection, DetailTech } from "@/components/detail";
import styles from "./ReflectionDetailBody.module.css";


function Json({ v }: { v: any }) {
  if (v == null) return <span className="tiny">-</span>;
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
  return <pre className={styles.json}>{s}</pre>;
}

export default function ReflectionDetailBody({
  id,
  renderHeader,
}: {
  id: string;
  renderHeader?: (ctx: { legacy: any; fw: any; discEntityId: string; loading: boolean }) => ReactNode;
}) {
  const { data, loading, error } = useApi<any>(`/api/reflection-detail?id=${encodeURIComponent(id)}`);

  const legacy = data?.result?.data ?? (data?.id ? null : data) ?? {};
  const fw = data?.flywheel ?? null;

  // 讨论面板挂载目标: 优先主题反思 (本轮反思), 否则旧反思记录
  const discEntityId = fw?.id || legacy?.id || id;
  const discLabel = fw
    ? t('cognitive.reflection.title')
    : legacy?.id
      ? `反思记录`
      : "未识别";
  const discTitle = fw
    ? `主题反思「${fw.theme}」讨论`
    : `反思讨论${legacy?.title ? "：" + String(legacy.title).slice(0, 24) : ""}`;

  return (
    <div>
      {renderHeader ? renderHeader({ legacy, fw, discEntityId, loading }) : null}
      {loading && !data ? <div className="panel"><StateBlock loading rows={4} /></div> : null}
      {error ? <div className={"panel " + styles.padLg}><Alert type="error" message="反思详情加载失败" description={humanError(error, "这条详情")} /></div> : null}

      {data && !loading && !fw && !legacy?.id ? (
        <>
          <div className="panel"><div className={styles.padLgDim}>{t('cognitive.reflection.notFound')}</div></div>
          <DiscussionPanel entityType="reflection" entityId={id} title="反思讨论" />
        </>
      ) : null}

      {/* ========== ① 旧 Reflection 记录 ========== */}
      {legacy?.id ? (
        <>
          {/* 2026-10-26：统一详情解剖（与其它详情页同一套组件） */}
          <div className="dt-stack">
            <div className="dt-grid-2">
              <DetailFields title="基础信息" cols={1} items={[
                { label: "编号", value: legacy.id, kind: "mono" },
                { label: "标题", value: legacy.title },
                { label: "状态", value: legacy.status },
                { label: "分类", value: legacy.category },
                { label: "优先级", value: legacy.priority },
                { label: "分数", value: legacy.score != null ? Number(legacy.score).toFixed(2) : "" },
                { label: "主题", value: legacy.theme },
                { label: "动作", value: (legacy.actionType || "") + (legacy.actionConfidence != null ? " · 置信 " + Number(legacy.actionConfidence).toFixed(2) : "") },
                { label: "来源", value: legacy.agentSource || legacy.sourceType },
                { label: "创建时间", value: fmtTs(legacy.createdAt) },
                { label: "更新时间", value: fmtTs(legacy.updatedAt) },
              ]} />
              <DetailFields title="改进与洞察" cols={1} items={[
                { label: t('field.improvements'), value: legacy.improvements },
                { label: t('field.insight'), value: legacy.insight },
              ]} />
            </div>
            <DetailProse title="教训" text={legacy.lesson || legacy.description} />
            <DetailProse title="根因分析" text={legacy.rootCauseAnalysis} />
            <DetailProse title="建议计划" text={legacy.proposedPlan} />
            {legacy.structuredImprovements ? (
              <DetailSection title="结构化改进">
                <div className={styles.siBox}>{(() => {
                  try {
                    const arr = typeof legacy.structuredImprovements === "string" ? JSON.parse(legacy.structuredImprovements) : legacy.structuredImprovements;
                    return Array.isArray(arr)
                      ? arr.map((x: any, i: number) => (<div key={i} className={styles.siRow}>[{x.severity || "-"}] {x.text}{x.area ? <span className={styles.dim}> ({x.area})</span> : null}</div>))
                      : String(legacy.structuredImprovements);
                  } catch { return String(legacy.structuredImprovements); }
                })()}</div>
              </DetailSection>
            ) : null}
          </div>
        </>
      ) : null}

      {/* ========== ② 主题反思 FlywheelReflection ========== */}
      {fw ? (
        <div className="dt-stack">
          {/* 2026-10-26：主题反思分支也改用统一解剖（此前是 6 个手写 panel + 内联样式）。 */}
          <DetailFields
            title="本轮反思（主题聚合）"
            cols={2}
            items={[
              { label: "状态", value: fw.status },
              { label: "覆盖率", value: fw.coverageScore != null ? fmtScore(fw.coverageScore, 3) : "" },
              { label: "Δ 覆盖率", value: fw.coverageDelta != null ? fmtScore(fw.coverageDelta, 3) : "" },
              { label: "尝试次数", value: String(fmtNum(fw.attempts)) },
              { label: "结构化发现", value: String(fmtNum(fw.structuredFindingsCount)) + " 条" },
              { label: "粒度", value: fw.reflectionGranularity === "day" ? "日结" : "主题粒度" },
              { label: "产物", value: fw.productCounts ? Object.entries(fw.productCounts).map(([k, v]) => `${k} ${v}`).join(" · ") : "" },
              { label: "更新", value: fw.updatedAt ? relTime(fw.updatedAt) : "" },
            ]}
          />
          <DetailProse title="本轮摘要" text={fw.summary} empty="(无摘要)" />
          <div className="dt-grid-2">
            <DetailSection title="覆盖缺口">
              {Array.isArray(fw.missedTopics) && fw.missedTopics.length
                ? fw.missedTopics.map((t: string, i: number) => (<div key={i} className={styles.listRow}>· {t}</div>))
                : <span className="tiny">无</span>}
            </DetailSection>
            <DetailSection title="改进建议">
              {Array.isArray(fw.improvements) && fw.improvements.length
                ? fw.improvements.map((t: string, i: number) => (<div key={i} className={styles.listRow}>· {t}</div>))
                : <span className="tiny">无</span>}
            </DetailSection>
          </div>
          <div className="dt-grid-2">
            <DetailSection title="冲突">
              {Array.isArray(fw.conflicts) && fw.conflicts.length ? fw.conflicts.map((c: any, i: number) => (
                <div key={i} className={styles.conflictRow}>
                  <span className="badge badge-yellow">冲突</span> {c?.reason || JSON.stringify(c)}
                  {Array.isArray(c?.memoryIds) ? <span className={"tiny mono " + styles.gapLeft}>{c.memoryIds.join(", ")}</span> : null}
                </div>
              )) : <span className="tiny">无</span>}
            </DetailSection>
            <DetailSection title="来源统计">
              {fw.sourceStats && typeof fw.sourceStats === "object" ? (
                <dl className="dt-fields one">
                  {Object.entries(fw.sourceStats).map(([k, v]) => (
                    <div className="dt-field" key={k}>
                      <dt>{k}</dt>
                      <dd className="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                    </div>
                  ))}
                </dl>
              ) : <Json v={fw.sourceStats} />}
            </DetailSection>
          </div>
          <DetailSection title={t('cognitive.reflection.structured')}>
            {Array.isArray(fw.structuredFindings) && fw.structuredFindings.length ? fw.structuredFindings.map((f: any, i: number) => (
              <div key={i} className={styles.finding}>
                <div className={styles.findingHead}>
                  <span className="badge badge-blue">{f.category || "-"}</span>
                  {f.id ? <span className={"tiny mono " + styles.gapLeft}>{f.id}</span> : null}
                </div>
                <div className={styles.findingBody}>{truncate(f.what || f.text || JSON.stringify(f), 240)}</div>
                {f.why ? <div className={"tiny " + styles.findingWhy}>原因：{truncate(f.why, 160)}</div> : null}
              </div>
            )) : <span className="tiny">无</span>}
          </DetailSection>
          <DetailTech items={[
            { k: "触发原因", v: fw.triggerReason ? JSON.stringify(fw.triggerReason) : null },
            { k: "日结统计", v: fw.dayStats ? JSON.stringify(fw.dayStats) : null },
            { k: "最近错误", v: fw.lastErrors ? JSON.stringify(fw.lastErrors) : null },
          ]} />
        </div>
      ) : null}

      {/* ========== 讨论（挂到当前反思对应的 id） ========== */}
      <DiscussionPanel entityType="reflection" entityId={discEntityId} title={discTitle} />
    </div>
  );
}
