"use client";
// 0.5.1 B4-3 /cognitive/practice/detail · Bento 统一详情模板（2026-11-15）
// 槽：页头（标题 + chips 4 + 编号/数据时刻）→ s8 本体（实践描述/教训，超长标「已截断」）
//     + s4 元信息（来源/结果/时间/难度；成功率等缺字段 n/a+原因）→ s12 关联（产出/遗留 + 任务/溯源）
//     → s12 相关视图（实践列表 + 治理 tab）。
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
const ENDPOINT = "/api/practice-detail";

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
        <Link className={styles.link} href="/cognitive/practice">返回实践列表</Link>
      </div>
    </section>
  );
}

function Inner() {
  const sp = useSearchParams();
  const id = (sp.get("id") || "").trim();
  const [nonce, setNonce] = useState(0);
  const path = id ? ENDPOINT + "?id=" + encodeURIComponent(id) + (nonce ? "&_r=" + nonce : "") : null;
  const { data, loading, error } = useLazyApi<any>(path);
  const p = data?.result?.data ?? (data && data.id ? data : null);

  const outputs = parseList(p?.outputs);
  const leftovers = parseList(p?.leftovers);
  const code = error ? httpCode(error) : "";

  if (!id) return <StatePanel kind="empty" title="缺少对象标识" detail="该详情页需要 URL 携带 ?id=<实践编号>；请从实践列表选择一条实践进入。" />;
  if (loading || (!data && !error)) return <SkelCards />;
  if (error) {
    return <StatePanel kind="error" title="实践详情暂时不可用" detail={humanError(error, "这条实践详情")} endpoint={ENDPOINT + "?id=" + encodeURIComponent(id)} code={code} retry={() => setNonce((n) => n + 1)} />;
  }
  if (!p) {
    return <StatePanel kind="empty" title="未找到该实践" detail={<span>编号 <span className="mono">{id}</span> 在实践库中不存在（接口 200 但未返回该记录）；请返回列表重新选择。</span>} />;
  }

  const desc = String(p.description || "");
  const truncated = desc.length > CUT;
  const asOfNote = "n/a（/api/practice-detail 未下发 asOf；下方记录更新时间为库内字段）";
  const meta: Array<{ label: string; value: ReactNode; reason?: string }> = [
    { label: "来源", value: p.agentSource || p.sourceType, reason: "详情接口未下发来源字段" },
    { label: "成功率", value: "", reason: "详情接口未下发成功率；仅有结果 outcome" },
    { label: "结果", value: p.outcome, reason: "详情接口未下发结果" },
    { label: "类型", value: p.type, reason: "详情接口未下发类型" },
    { label: "难度", value: p.difficulty != null ? String(p.difficulty) : "", reason: "详情接口未下发难度" },
    { label: "质量分", value: p.qualityScore != null ? Number(p.qualityScore).toFixed(2) : "", reason: "详情接口未下发质量分" },
    { label: "耗时", value: p.duration != null ? String(p.duration) + "（接口原始值，单位未标注）" : "", reason: "详情接口未下发耗时" },
    { label: "开始时间", value: p.startedAt ? fmtStamp(p.startedAt) : "", reason: "详情接口未下发开始时间" },
    { label: "完成时间", value: p.completedAt ? fmtStamp(p.completedAt) : "", reason: "详情接口未下发完成时间" },
    { label: "更新时间", value: p.updatedAt ? fmtStamp(p.updatedAt) : "", reason: "详情接口未下发更新时间" },
    { label: "层级", value: p.tier, reason: "详情接口未下发 tier" },
    { label: "强化次数", value: p.reinforceCount != null ? String(p.reinforceCount) : "", reason: "详情接口未下发强化次数" },
    { label: "时效", value: p.stale == null ? "" : (p.stale ? "已失效：" + (p.staleReason || "未给原因") : "有效（stale=false）"), reason: "详情接口未下发 stale 字段" },
  ];

  return (
    <>
      <p className={styles.metaLine}>编号：<span className="mono">{id}</span> · 数据时刻：{asOfNote}</p>
      <div className={styles.grid}>
        <section className={styles.card + " " + styles.s8} data-state="ok" data-span="8">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>本体 · {p.title || "无标题"}</h2>
              <p className={styles.cardSub}>实践描述（案例）{truncated ? " · 已截断展示" : ""}</p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>
          {desc ? (
            <div className={styles.prose}>
              <p>{truncated ? desc.slice(0, CUT) + "…" : desc}</p>
              {truncated ? <p className={styles.cutNote}>已截断：原文 {desc.length} 字，此处展示前 {CUT} 字。</p> : null}
            </div>
          ) : (<p className={styles.emptyNote}>无描述（接口未返回 description 字段）。</p>)}
          {p.lesson ? (
            <div className={styles.subBlock}><h3 className={styles.subTitle}>教训</h3><p className={styles.prose}>{String(p.lesson)}</p></div>
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
              <p className={styles.cardSub}>关联任务、产出与遗留（产出来自详情接口 outputs/leftovers 字段）</p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>
          <div className={styles.relCols}>
            <div>
              <h3 className={styles.subTitle}>产出（{outputs.length}）</h3>
              {outputs.length ? (<ul className={styles.bullets}>{outputs.map((x, i) => (<li key={i}>{x}</li>))}</ul>) : (<p className={styles.emptyNote}>无产出（接口未返回 outputs）。</p>)}
            </div>
            <div>
              <h3 className={styles.subTitle}>遗留（{leftovers.length}）</h3>
              {leftovers.length ? (<ul className={styles.bullets}>{leftovers.map((x, i) => (<li key={i}>{x}</li>))}</ul>) : (<p className={styles.emptyNote}>无遗留（接口未返回 leftovers）。</p>)}
            </div>
          </div>
          <ul className={styles.relList}>
            <MetaRow label="关联任务" reason="详情接口未下发 taskRef">{p.taskRef ? (<span>{p.taskRef} · <Link className={styles.link} href="/flywheel/tasks">任务列表</Link></span>) : ""}</MetaRow>
            <MetaRow label="来源标识" reason="详情接口未下发 sourceId">{p.sourceId}</MetaRow>
            <MetaRow label="来源层级 / 集合" reason="详情接口未下发 sourceLayer/sourceIds">{(p.sourceLayer || p.sourceIds) ? <span className="mono">{p.sourceLayer || "n/a"} / {parseList(p.sourceIds).join(", ") || "n/a"}</span> : ""}</MetaRow>
            <MetaRow label="被替代" reason="详情接口未下发 supersededBy">{p.supersededBy ? <span className="mono">{p.supersededBy}（{p.supersededAt ? fmtStamp(p.supersededAt) : "替代时间未下发"}）</span> : ""}</MetaRow>
            <MetaRow label="内容摘要" reason="详情接口未下发 contentHash">{p.contentHash ? <span className="mono">{String(p.contentHash).slice(0, 24)}…</span> : ""}</MetaRow>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s12} data-state="ok" data-span="12">
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>相关视图</h2><span className={styles.tag}>只读</span></div>
          <div className={styles.views}>
            <Link className={styles.viewCard} href="/cognitive/practice"><b>实践列表</b><span>返回 /cognitive/practice，保留原有筛选</span></Link>
            <Link className={styles.viewCard} href="/cognitive/reflection"><b>反思记录</b><span>实践与反思同源（/cognitive/reflection）</span></Link>
            <Link className={styles.viewCard} href="/cognitive/knowledge?tab=governance"><b>知识治理</b><span>治理 tab（本页仅跳转）</span></Link>
          </div>
          <p className={styles.foot}>本页只读（0.5.1）：无编辑/删除/保存入口；实践讨论与协作面板不在本批详情页范围。</p>
        </section>
      </div>
    </>
  );
}

export default function PracticeDetailPage() {
  return (
    <main className="page">
      <div className={styles.crumbNav} aria-label="页面层级">
        <span className={styles.crumbDim}>记忆与知识</span><span className={styles.sep}>/</span>
        <Link href="/cognitive/practice">实践</Link><span className={styles.sep}>/</span>
        <span className={styles.current}>实践详情</span>
      </div>
      <PageHeader>
        <PageTitle>实践详情</PageTitle>
        <div className="page-subtitle">对象详情 · 实践：描述、元信息与关联对象（只读）</div>
        <div className={styles.chips} aria-label="页面层级标签"><span>#</span><span>认知</span><span>详情</span><span className={styles.chipOn}>只读</span></div>
      </PageHeader>
      <Suspense fallback={<SkelCards />}><Inner /></Suspense>
    </main>
  );
}