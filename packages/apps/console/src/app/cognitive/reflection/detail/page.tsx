"use client";
// 0.5.1 B4-4 /cognitive/reflection/detail · Bento 统一详情模板（2026-11-15）
// 槽：页头（标题 + chips 4 + 编号/数据时刻）→ s8 本体（旧反思记录的教训/根因/计划，或主题反思的本轮摘要/发现）
//     + s4 元信息（状态/覆盖度/分数/时间；旧记录无覆盖度 => n/a+原因）→ s12 关联（关联记忆/知识/会话 + 改进动作）
//     → s12 相关视图（反思列表 + 治理 tab）。
// 两个 id 体系（旧 Reflection 记录 / 主题反思 FlywheelReflection）并存：按接口 found 字段如实标注命中情况。
// 四态：缺参「缺少对象标识」/ loading / error（中文+端点+HTTP 码+重试）/ 未找到 / unavailable（分块 n/a+原因）。
// 只读：0 写请求。
import type { ReactNode } from "react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLazyApi } from "@/lib/api";
import { humanError } from "@/lib/humanError";
import { fmtStamp } from "@/lib/format";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

const CUT = 3000;
const ENDPOINT = "/api/reflection-detail";

function parseList(v: any): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  try {
    const arr = JSON.parse(String(v));
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [String(v)];
  } catch { return [String(v)]; }
}

function Na({ reason }: { reason: string }) {
  return <span className={styles.na}>n/a（{reason}）</span>;
}

function MetaRow({ label, children, reason }: { label: string; children?: ReactNode; reason?: string }) {
  const empty = children === null || children === undefined || children === "";
  return (
    <li>
      <span className={styles.kvKey}>{label}</span>
      <span className={styles.kvVal}>{empty ? <Na reason={reason || "接口未下发该字段"} /> : children}</span>
    </li>
  );
}

function httpCode(e: unknown): string {
  const st = (e as any)?.status;
  if (typeof st === "number" && st > 0) return String(st);
  const m = String((e as Error)?.message ?? "").match(/(\d{3})/);
  return m ? m[1] : "";
}

function SkelCards() {
  return (
    <div className={styles.grid}>
      <section className={styles.card + " " + styles.s8} data-state="loading" data-span="8">
        <div className={styles.cardHead}><h2 className={styles.cardTitle}>本体</h2><span className={styles.tag}>加载中</span></div>
        <span className={styles.skel} /><span className={styles.skel} /><span className={styles.skel + " " + styles.skelShort} />
      </section>
      <section className={styles.card + " " + styles.s4} data-state="loading" data-span="4">
        <div className={styles.cardHead}><h2 className={styles.cardTitle}>元信息</h2></div>
        <span className={styles.skel} /><span className={styles.skel} /><span className={styles.skel} />
      </section>
    </div>
  );
}

function StatePanel({ kind, title, detail, endpoint, code, retry }: { kind: "empty" | "error" | "unavailable"; title: string; detail: ReactNode; endpoint?: string; code?: string; retry?: () => void }) {
  return (
    <section className={styles.state + (kind === "error" ? " " + styles.stateErr : "")} data-state={kind} aria-live="polite">
      <h2 className={styles.stateTitle}>{title}</h2>
      <p className={styles.stateText}>{detail}</p>
      {endpoint ? <p className={styles.stateMeta}>端点：<span className="mono">{endpoint}</span></p> : null}
      {kind === "error" ? <p className={styles.stateMeta}>响应：{code ? "响应码 " + code : "网络不可达或超时（无响应码）"}</p> : null}
      <div className={styles.stateActions}>
        {retry ? <button type="button" className={styles.btn} onClick={retry}>重试</button> : null}
        <Link className={styles.link} href="/cognitive/reflection">返回反思列表</Link>
      </div>
    </section>
  );
}

function ProseBlock({ title, text }: { title: string; text?: any }) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  const cut = s.length > CUT;
  return (
    <div className={styles.subBlock}>
      <h3 className={styles.subTitle}>{title}{cut ? <span className={styles.badge}>已截断</span> : null}</h3>
      <p className={styles.prose}>{cut ? s.slice(0, CUT) + "…" : s}</p>
      {cut ? <p className={styles.cutNote}>已截断：原文 {s.length} 字，此处展示前 {CUT} 字。</p> : null}
    </div>
  );
}

function Inner() {
  const sp = useSearchParams();
  const id = (sp.get("id") || "").trim();
  const [nonce, setNonce] = useState(0);
  const path = id ? ENDPOINT + "?id=" + encodeURIComponent(id) + (nonce ? "&_r=" + nonce : "") : null;
  const { data, loading, error } = useLazyApi<any>(path);

  const legacy = data?.result?.data ?? (data && data.id && !data.found ? data : null);
  const fw = data?.flywheel ?? null;
  const found = data?.found ?? { legacy: !!legacy, flywheel: !!fw };
  const code = error ? httpCode(error) : "";
  const asOf = data?.asOf ? fmtStamp(data.asOf) : "";

  if (!id) return <StatePanel kind="empty" title="缺少对象标识" detail="该详情页需要 URL 携带 ?id=<反思编号>；请从反思列表选择一条反思进入。" />;
  if (loading || (!data && !error)) return <SkelCards />;
  if (error) {
    return <StatePanel kind="error" title="反思详情暂时不可用" detail={humanError(error, "这条反思详情")} endpoint={ENDPOINT + "?id=" + encodeURIComponent(id)} code={code} retry={() => setNonce((n) => n + 1)} />;
  }
  if (!legacy && !fw) {
    return <StatePanel kind="empty" title="未找到该反思" detail={<span>编号 <span className="mono">{id}</span> 在旧反思记录与主题反思两套 id 体系中均未命中（found.legacy=false / found.flywheel=false）；请返回列表重新选择。</span>} />;
  }

  const title = legacy?.title || (fw ? "主题反思 · " + (fw.theme || "无主题") : "无标题");
  const status = legacy?.status || fw?.status || "";
  const coverage = fw?.coverageScore != null ? Number(fw.coverageScore).toFixed(3) : "";
  const improvementActions = parseList(legacy?.improvementActions);
  const relMem = parseList(legacy?.relatedMemoryIds);
  const relKnow = parseList(legacy?.relatedKnowledgeIds);
  const relSess = parseList(legacy?.relatedSessionIds);
  const relProb = parseList(legacy?.relatedProblemIds);
  const warnings: string[] = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];

  const meta: Array<{ label: string; value: ReactNode; reason?: string }> = [
    { label: "id 体系", value: found.legacy && found.flywheel ? "两套都有（旧反思记录 + 主题反思）" : found.legacy ? "旧反思记录" : "主题反思", reason: "接口未下发命中情况" },
    { label: "状态", value: status, reason: "接口未下发状态" },
    { label: "覆盖度", value: coverage, reason: "旧反思记录无覆盖度字段" },
    { label: "分数", value: legacy?.score != null ? Number(legacy.score).toFixed(2) : "", reason: "接口未下发分数" },
    { label: "分类", value: legacy?.category, reason: "接口未下发分类" },
    { label: "优先级", value: legacy?.priority, reason: "接口未下发优先级" },
    { label: "动作", value: legacy?.actionType ? String(legacy.actionType) + (legacy.actionConfidence != null ? " · 置信 " + Number(legacy.actionConfidence).toFixed(2) : "") : "", reason: "接口未下发动作字段" },
    { label: "尝试次数", value: fw?.attempts != null ? String(fw.attempts) : "", reason: "仅主题反思有尝试次数" },
    { label: "结构化发现", value: fw?.structuredFindingsCount != null ? String(fw.structuredFindingsCount) + " 条" : "", reason: "仅主题反思有结构化发现计数" },
    { label: "粒度", value: fw?.reflectionGranularity ? (fw.reflectionGranularity === "day" ? "日结" : "主题粒度") : "", reason: "仅主题反思有粒度" },
    { label: "来源", value: legacy?.agentSource || legacy?.sourceType, reason: "接口未下发来源" },
    { label: "创建时间", value: legacy?.createdAt ? fmtStamp(legacy.createdAt) : (fw?.createdAt ? fmtStamp(fw.createdAt) : ""), reason: "接口未下发创建时间" },
    { label: "更新时间", value: legacy?.updatedAt ? fmtStamp(legacy.updatedAt) : (fw?.updatedAt ? fmtStamp(fw.updatedAt) : ""), reason: "接口未下发更新时间" },
  ];

  return (
    <>
      <p className={styles.metaLine}>编号：<span className="mono">{id}</span> · 数据时刻：{asOf || "n/a（/api/reflection-detail 未下发 asOf）"}</p>
      <div className={styles.grid}>
        <section className={styles.card + " " + styles.s8} data-state="ok" data-span="8">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>本体 · {title}</h2>
              <p className={styles.cardSub}>
                {found.legacy && found.flywheel ? "旧反思记录 + 主题反思（两个 id 体系同时命中，讨论挂载以主题反思为准）" : found.legacy ? "旧反思记录" : "主题反思（按主题聚合）"}
              </p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>

          {warnings.length ? (<p className={styles.warnNote}>上游告警：{warnings.join("；")}</p>) : null}

          {legacy ? (
            <div>
              <h3 className={styles.groupTitle}>旧反思记录</h3>
              <ProseBlock title="教训 / 描述" text={legacy.lesson || legacy.description} />
              <ProseBlock title="根因分析" text={legacy.rootCauseAnalysis} />
              <ProseBlock title="建议计划" text={legacy.proposedPlan} />
              <ProseBlock title="改进建议" text={legacy.improvements} />
              <ProseBlock title="洞察" text={legacy.insight} />
              {legacy.structuredImprovements ? (<ProseBlock title="结构化改进" text={legacy.structuredImprovements} />) : null}
            </div>
          ) : null}

          {fw ? (
            <div>
              <h3 className={styles.groupTitle}>主题反思（本轮）</h3>
              <ProseBlock title="本轮摘要" text={fw.summary} />
              {Array.isArray(fw.missedTopics) && fw.missedTopics.length ? (
                <div className={styles.subBlock}><h3 className={styles.subTitle}>覆盖缺口（{fw.missedTopics.length}）</h3><ul className={styles.bullets}>{fw.missedTopics.map((x: any, i: number) => (<li key={i}>{String(x)}</li>))}</ul></div>
              ) : null}
              {Array.isArray(fw.improvements) && fw.improvements.length ? (
                <div className={styles.subBlock}><h3 className={styles.subTitle}>改进建议（{fw.improvements.length}）</h3><ul className={styles.bullets}>{fw.improvements.map((x: any, i: number) => (<li key={i}>{String(x)}</li>))}</ul></div>
              ) : null}
              {Array.isArray(fw.conflicts) && fw.conflicts.length ? (
                <div className={styles.subBlock}><h3 className={styles.subTitle}>冲突（{fw.conflicts.length}）</h3><ul className={styles.bullets}>{fw.conflicts.map((c: any, i: number) => (<li key={i}>{typeof c === "string" ? c : (c?.reason || JSON.stringify(c))}</li>))}</ul></div>
              ) : null}
              {Array.isArray(fw.structuredFindings) && fw.structuredFindings.length ? (
                <div className={styles.subBlock}><h3 className={styles.subTitle}>结构化发现（{fw.structuredFindings.length}）</h3><ul className={styles.bullets}>{fw.structuredFindings.slice(0, 20).map((f: any, i: number) => (<li key={i}>[{f.category || "-"}] {String(f.what || f.text || "").slice(0, 240)}{f.why ? " —— 原因：" + String(f.why).slice(0, 160) : ""}</li>))}</ul></div>
              ) : null}
              {!String(fw.summary || "").trim() && !(Array.isArray(fw.structuredFindings) && fw.structuredFindings.length) && !(Array.isArray(fw.improvements) && fw.improvements.length) && !(Array.isArray(fw.missedTopics) && fw.missedTopics.length) ? (
                <p className={styles.emptyNote}>本轮主题反思无摘要/发现/改进（接口字段为空；状态与覆盖度见右侧元信息）。</p>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className={styles.card + " " + styles.s4} data-state="ok" data-span="4">
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>元信息</h2><span className={styles.tag}>只读</span></div>
          <ul className={styles.kv}>{meta.map((x) => (<MetaRow key={x.label} label={x.label} reason={x.reason}>{x.value}</MetaRow>))}</ul>
        </section>

        <section className={styles.card + " " + styles.s12} data-state="ok" data-span="12">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>关联对象</h2>
              <p className={styles.cardSub}>关联记忆 / 知识 / 会话 / 问题与改进动作（来自详情接口 related*Ids 与 improvementActions 字段）</p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>
          <div className={styles.relCols}>
            <div>
              <h3 className={styles.subTitle}>关联记忆（{relMem.length}）</h3>
              {relMem.length ? (<ul className={styles.bullets}>{relMem.map((x) => (<li key={x}><Link className={styles.link} href={"/cognitive/memory/detail?id=" + encodeURIComponent(x)}>{x}</Link></li>))}</ul>) : (<p className={styles.emptyNote}>无关联记忆（接口未下发 relatedMemoryIds）。</p>)}
              <h3 className={styles.subTitle + " " + styles.subTitleGap}>关联知识（{relKnow.length}）</h3>
              {relKnow.length ? (<ul className={styles.bullets}>{relKnow.map((x) => (<li key={x}><Link className={styles.link} href={"/cognitive/knowledge/detail?id=" + encodeURIComponent(x)}>{x}</Link></li>))}</ul>) : (<p className={styles.emptyNote}>无关联知识（接口未下发 relatedKnowledgeIds）。</p>)}
            </div>
            <div>
              <h3 className={styles.subTitle}>关联会话 / 问题</h3>
              <ul className={styles.bullets}>
                {relSess.map((x) => (<li key={"s-" + x}>会话：<span className="mono">{x}</span></li>))}
                {relProb.map((x) => (<li key={"p-" + x}>问题：<span className="mono">{x}</span></li>))}
                {!relSess.length && !relProb.length ? (<li>无关联会话/问题（接口未下发）。</li>) : null}
              </ul>
              <h3 className={styles.subTitle + " " + styles.subTitleGap}>改进动作（{improvementActions.length}）</h3>
              {improvementActions.length ? (<ul className={styles.bullets}>{improvementActions.map((x, i) => (<li key={i}>{x}</li>))}</ul>) : (<p className={styles.emptyNote}>无改进动作（接口未下发 improvementActions）。</p>)}
            </div>
          </div>
          <ul className={styles.relList}>
            <MetaRow label="关联知识编号" reason="详情接口未下发 knowledgeId">{legacy?.knowledgeId}</MetaRow>
            <MetaRow label="里程碑 / 学习路径" reason="详情接口未下发 milestoneId/learningPathId">{(legacy?.milestoneId || legacy?.learningPathId) ? <span className="mono">{legacy?.milestoneId || "-"} / {legacy?.learningPathId || "-"}</span> : ""}</MetaRow>
            <MetaRow label="内容摘要" reason="详情接口未下发 contentHash">{legacy?.contentHash ? <span className="mono">{String(legacy.contentHash).slice(0, 24)}…</span> : ""}</MetaRow>
            <MetaRow label="替代状态" reason="详情接口未下发 supersededBy">{legacy?.supersededBy ? <span className="mono">已被 {legacy.supersededBy} 取代</span> : ""}</MetaRow>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s12} data-state="ok" data-span="12">
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>相关视图</h2><span className={styles.tag}>只读</span></div>
          <div className={styles.views}>
            <Link className={styles.viewCard} href="/cognitive/reflection"><b>反思列表</b><span>返回 /cognitive/reflection，保留原有筛选</span></Link>
            <Link className={styles.viewCard} href="/cognitive/knowledge"><b>知识库</b><span>知识产物列表（/cognitive/knowledge）</span></Link>
            <Link className={styles.viewCard} href="/cognitive/knowledge?tab=governance"><b>知识治理</b><span>治理 tab（本页仅跳转）</span></Link>
          </div>
          <p className={styles.foot}>本页只读（0.5.1）：无编辑/删除/保存入口；反思讨论与协作面板不在本批详情页范围（旧页面的讨论挂载信息不再展示）。</p>
        </section>
      </div>
    </>
  );
}

export default function ReflectionDetailPage() {
  return (
    <main className="page">
      <div className={styles.crumbNav} aria-label="页面层级">
        <span className={styles.crumbDim}>记忆与知识</span><span className={styles.sep}>/</span>
        <Link href="/cognitive/reflection">反思</Link><span className={styles.sep}>/</span>
        <span className={styles.current}>反思详情</span>
      </div>
      <PageHeader>
        <PageTitle>反思详情</PageTitle>
        <div className="page-subtitle">对象详情 · 反思：教训、根因、建议与关联（只读）</div>
        <div className={styles.chips} aria-label="页面层级标签"><span>#</span><span>认知</span><span>详情</span><span className={styles.chipOn}>只读</span></div>
      </PageHeader>
      <Suspense fallback={<SkelCards />}><Inner /></Suspense>
    </main>
  );
}