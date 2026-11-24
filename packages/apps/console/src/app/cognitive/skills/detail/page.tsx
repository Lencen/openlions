"use client";
// 0.5.1 B4-5 /cognitive/skills/detail · Bento 统一详情模板（2026-11-15）
// 槽：页头（标题 + chips 4 + 编号/数据时刻）→ s8 本体（技能定义：描述/执行步骤/适用场景/使用方法/验证/已知坑，
//     超长各段标「已截断」）+ s4 元信息（版本/来源/启用态/等级/时间；启用态等缺字段 n/a+原因）
//     → s12 关联（父子技能/引用知识/校验实践）+ s12 相关视图（技能列表 + 治理 tab）。
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
const ENDPOINT = "/api/skill-detail";

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
        <Link className={styles.link} href="/cognitive/skills">返回技能列表</Link>
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
  const s = data?.result?.data ?? (data && data.id ? data : null);
  const code = error ? httpCode(error) : "";

  if (!id) return <StatePanel kind="empty" title="缺少对象标识" detail="该详情页需要 URL 携带 ?id=<技能编号>；请从技能列表选择一条技能进入。" />;
  if (loading || (!data && !error)) return <SkelCards />;
  if (error) {
    return <StatePanel kind="error" title="技能详情暂时不可用" detail={humanError(error, "这条技能详情")} endpoint={ENDPOINT + "?id=" + encodeURIComponent(id)} code={code} retry={() => setNonce((n) => n + 1)} />;
  }
  if (!s) {
    return <StatePanel kind="empty" title="未找到该技能" detail={<span>编号 <span className="mono">{id}</span> 在技能库中不存在（接口 200 但未返回该记录）；请返回列表重新选择。</span>} />;
  }

  const hasSteps = s.content && String(s.content).trim().length > 0;
  const asOfNote = "n/a（/api/skill-detail 未下发 asOf；下方记录更新时间为库内字段）";
  const childSkills: any[] = Array.isArray(s.childSkills) ? s.childSkills : [];
  const referencedKnow = parseList(s.referencedKnowledgeIds);
  const platforms = parseList(s.platforms);
  const parentName = s.parentSkill && typeof s.parentSkill === "object" ? (s.parentSkill.businessName || s.parentSkill.name || s.parentSkill.id) : "";
  const meta: Array<{ label: string; value: ReactNode; reason?: string }> = [
    { label: "版本", value: s.version != null ? String(s.version) + (s.legacy ? "（存量）" : "") : "", reason: "详情接口未下发版本" },
    { label: "来源", value: s.source, reason: "详情接口未下发来源" },
    { label: "启用态", value: "", reason: "详情接口未下发启用态字段（legacy/visibility 不代表示启用）" },
    { label: "等级", value: s.level, reason: "详情接口未下发等级" },
    { label: "分类", value: s.category, reason: "详情接口未下发分类" },
    { label: "质量分", value: s.qualityScore != null ? Number(s.qualityScore).toFixed(2) : "", reason: "详情接口未下发质量分" },
    { label: "使用次数", value: s.totalUsageCount != null ? String(s.totalUsageCount) : "", reason: "详情接口未下发使用次数" },
    { label: "执行步骤", value: hasSteps ? "有可执行步骤" : "无步骤", reason: "详情接口未下发执行步骤" },
    { label: "可见性", value: s.visibility, reason: "详情接口未下发可见性" },
    { label: "父技能", value: s.parentSkillId, reason: "详情接口未下发父技能" },
    { label: "校验实践", value: s.validatedByPracticeId, reason: "详情接口未下发校验实践" },
    { label: "创建时间", value: s.createdAt ? fmtStamp(s.createdAt) : "", reason: "详情接口未下发创建时间" },
    { label: "更新时间", value: s.updatedAt ? fmtStamp(s.updatedAt) : "", reason: "详情接口未下发更新时间" },
    { label: "内容摘要", value: s.contentHash ? String(s.contentHash).slice(0, 24) + "…" : "", reason: "详情接口未下发 contentHash" },
  ];

  return (
    <>
      <p className={styles.metaLine}>编号：<span className="mono">{id}</span> · 数据时刻：{asOfNote}</p>
      <div className={styles.grid}>
        <section className={styles.card + " " + styles.s8} data-state="ok" data-span="8">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>本体 · {s.businessName || s.name || "无标题"}</h2>
              <p className={styles.cardSub}>技能定义：描述 / 执行步骤 / 适用场景 / 使用方法 / 匹配规则 / 验证方法 / 已知坑{s.technicalName ? " · 技术名 " + s.technicalName : ""}</p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>
          <ProseBlock title="描述" text={s.description} />
          <ProseBlock title="执行步骤" text={s.content} />
          <ProseBlock title="适用场景" text={s.trigger} />
          <ProseBlock title="使用方法" text={s.usageMethod} />
          <ProseBlock title="匹配规则" text={s.autoMatchRules} />
          <ProseBlock title="验证方法" text={s.verification} />
          <ProseBlock title="已知坑" text={s.pitfalls} />
          <ProseBlock title="自评" text={s.selfAssessment} />
          {!s.description && !hasSteps && !s.trigger && !s.usageMethod && !s.verification && !s.pitfalls ? (
            <p className={styles.emptyNote}>无技能定义内容（接口未返回 description/content/trigger 等字段）。</p>
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
              <p className={styles.cardSub}>父子技能 / 引用知识 / 校验实践 / 平台（来自详情接口 parentSkill、childSkills、referencedKnowledgeIds、validatedByPracticeId 等字段）</p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>
          <div className={styles.relCols}>
            <div>
              <h3 className={styles.subTitle}>父技能</h3>
              {s.parentSkillId ? (
                <p className={styles.bullets}><Link className={styles.link} href={"/cognitive/skills/detail?id=" + encodeURIComponent(s.parentSkillId)}>{parentName || s.parentSkillId}</Link></p>
              ) : (<p className={styles.emptyNote}>无父技能（接口 parentSkillId 为空）。</p>)}
              <h3 className={styles.subTitle + " " + styles.subTitleGap}>子技能（{childSkills.length}）</h3>
              {childSkills.length ? (
                <ul className={styles.bullets}>{childSkills.map((c: any, i: number) => (<li key={c?.id || i}>{c?.id ? <Link className={styles.link} href={"/cognitive/skills/detail?id=" + encodeURIComponent(c.id)}>{c.businessName || c.name || c.id}</Link> : String(c)}</li>))}</ul>
              ) : (<p className={styles.emptyNote}>无子技能（接口 childSkills 为空）。</p>)}
            </div>
            <div>
              <h3 className={styles.subTitle}>引用知识（{referencedKnow.length}）</h3>
              {referencedKnow.length ? (
                <ul className={styles.bullets}>{referencedKnow.map((x) => (<li key={x}><Link className={styles.link} href={"/cognitive/knowledge/detail?id=" + encodeURIComponent(x)}>{x}</Link></li>))}</ul>
              ) : (<p className={styles.emptyNote}>无引用知识（接口未下发 referencedKnowledgeIds）。</p>)}
              <h3 className={styles.subTitle + " " + styles.subTitleGap}>校验实践</h3>
              {s.validatedByPracticeId ? (
                <p className={styles.bullets}><Link className={styles.link} href={"/cognitive/practice/detail?id=" + encodeURIComponent(s.validatedByPracticeId)}>{s.validatedByPracticeId}</Link></p>
              ) : (<p className={styles.emptyNote}>无校验实践（接口 validatedByPracticeId 为空）。</p>)}
            </div>
          </div>
          <ul className={styles.relList}>
            <MetaRow label="来源实践" reason="详情接口未下发 sourcePracticeId">{s.sourcePracticeId ? <Link className={styles.link} href={"/cognitive/practice/detail?id=" + encodeURIComponent(s.sourcePracticeId)}>{s.sourcePracticeId}</Link> : ""}</MetaRow>
            <MetaRow label="平台" reason="详情接口未下发 platforms">{platforms.length ? platforms.join("、") : ""}</MetaRow>
            <MetaRow label="主题" reason="详情接口未下发主题">{s.theme}</MetaRow>
            <MetaRow label="替代状态" reason="详情接口未下发 supersededBy">{s.supersededBy ? <span className="mono">已被 {s.supersededBy} 取代</span> : (s.supersededBy === null ? "现行（supersededBy=null）" : "")}</MetaRow>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s12} data-state="ok" data-span="12">
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>相关视图</h2><span className={styles.tag}>只读</span></div>
          <div className={styles.views}>
            <Link className={styles.viewCard} href="/cognitive/skills"><b>技能列表</b><span>返回 /cognitive/skills，保留原有筛选</span></Link>
            <Link className={styles.viewCard} href="/cognitive/practice"><b>实践列表</b><span>技能由实践提炼（/cognitive/practice）</span></Link>
            <Link className={styles.viewCard} href="/cognitive/knowledge?tab=governance"><b>知识治理</b><span>治理 tab（本页仅跳转）</span></Link>
          </div>
          <p className={styles.foot}>本页只读（0.5.1）：无编辑/删除/保存入口；技能讨论与协作面板不在本批详情页范围。</p>
        </section>
      </div>
    </>
  );
}

export default function SkillDetailPage() {
  return (
    <main className="page">
      <div className={styles.crumbNav} aria-label="页面层级">
        <span className={styles.crumbDim}>记忆与知识</span><span className={styles.sep}>/</span>
        <Link href="/cognitive/skills">技能</Link><span className={styles.sep}>/</span>
        <span className={styles.current}>技能详情</span>
      </div>
      <PageHeader>
        <PageTitle>技能详情</PageTitle>
        <div className="page-subtitle">对象详情 · 技能：定义、元信息与关联对象（只读）</div>
        <div className={styles.chips} aria-label="页面层级标签"><span>#</span><span>认知</span><span>详情</span><span className={styles.chipOn}>只读</span></div>
      </PageHeader>
      <Suspense fallback={<SkelCards />}><Inner /></Suspense>
    </main>
  );
}