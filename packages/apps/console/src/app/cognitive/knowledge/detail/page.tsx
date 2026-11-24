"use client";
// 0.5.1 B4-1 /cognitive/knowledge/detail · Bento 统一详情模板（2026-11-15）
// 槽：页头（标题 + chips 4 + 编号/数据时刻）→ s8 本体（标题 + 知识模板正文，超长标「已截断」）
//     + s4 元信息（来源/时效/置信度/时间/标签；缺字段 n/a+原因）→ s12 关联（同主题知识 + 溯源/替代）
//     → s12 相关视图（知识库列表 + 知识治理 tab）。
// 四态：缺参「缺少对象标识」/ loading / error（中文+端点+HTTP 码+重试）/ 未找到 / unavailable（分块 n/a+原因）。
// 只读：0 写请求；治理只跳转 tab，不提供保存/编辑。
import type { ReactNode } from "react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLazyApi } from "@/lib/api";
import { humanError } from "@/lib/humanError";
import { fmtStamp } from "@/lib/format";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import { renderKt } from "@/components/cognitive/KnowledgeDetailBody";
import styles from "./page.module.css";

const CUT = 3000;
const ENDPOINT = "/api/knowledge-detail";

function parseList(v: any): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  try {
    const arr = JSON.parse(String(v));
    return Array.isArray(arr) ? arr.map((x: any) => String(x)) : [String(v)];
  } catch { return [String(v)]; }
}

function parseTags(v: any): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  const raw = String(v).trim();
  if (raw.startsWith("{")) {
    try {
      const o = JSON.parse(raw);
      return Object.entries(o).map(([k, x]) => k + "=" + String(x));
    } catch { /* 非 JSON 对象则按逗号分隔 */ }
  }
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
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

function StatePanel({
  kind, title, detail, endpoint, code, retry,
}: { kind: "empty" | "error" | "unavailable"; title: string; detail: ReactNode; endpoint?: string; code?: string; retry?: () => void }) {
  return (
    <section className={styles.state + (kind === "error" ? " " + styles.stateErr : "")} data-state={kind} aria-live="polite">
      <h2 className={styles.stateTitle}>{title}</h2>
      <p className={styles.stateText}>{detail}</p>
      {endpoint ? <p className={styles.stateMeta}>端点：<span className="mono">{endpoint}</span></p> : null}
      {kind === "error" ? <p className={styles.stateMeta}>响应：{code ? "响应码 " + code : "网络不可达或超时（无响应码）"}</p> : null}
      <div className={styles.stateActions}>
        {retry ? <button type="button" className={styles.btn} onClick={retry}>重试</button> : null}
        <Link className={styles.link} href="/cognitive/knowledge">返回知识库列表</Link>
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
  const k = data?.result?.data ?? (data && data.id ? data : null);

  const theme = k?.theme ? String(k.theme) : "";
  const relPath = theme ? "/api/knowledge-list?page=1&pageSize=6&search=" + encodeURIComponent(theme) + "&sortBy=updatedAt&sortOrder=desc" : null;
  const { data: rel } = useLazyApi<any>(relPath);
  const related: any[] = Array.isArray(rel?.items) ? rel.items.filter((r: any) => r && r.id !== k?.id).slice(0, 5) : [];

  const code = error ? httpCode(error) : "";

  if (!id) {
    return <StatePanel kind="empty" title="缺少对象标识" detail="该详情页需要 URL 携带 ?id=<编号>；请从列表选择一条进入。" />;
  }

  if (loading || (!data && !error)) return <SkelCards />;


  if (error) {
    return (
      <StatePanel
        kind="error"
        title="知识详情暂时不可用"
        detail={humanError(error, "这条知识详情")}
        endpoint={ENDPOINT + "?id=" + encodeURIComponent(id)}
        code={code}
        retry={() => setNonce((n) => n + 1)}
      />
    );
  }

  if (!k) {
    return <StatePanel kind="empty" title="未找到该知识" detail={<span>编号 <span className="mono">{id}</span> 在知识库中不存在（接口 200 但未返回该记录）；请返回列表重新选择。</span>} />;
  }

  const content = String(k.content || "");
  const truncated = content.length > CUT;
  const asOfNote = "n/a（/api/knowledge-detail 未下发 asOf；下方记录更新时间为库内字段）";

  const meta: Array<{ label: string; value: ReactNode; reason?: string }> = [
    { label: "来源", value: k.agentSource || k.sourceType || k.sourceDetail, reason: "详情接口未下发来源字段" },
    { label: "来源明细", value: k.sourceDetail, reason: "详情接口未下发来源明细" },
    { label: "时效", value: k.stale == null ? "" : (k.stale ? "已失效：" + (k.staleReason || "未给原因") : "有效（stale=false）"), reason: "详情接口未下发 stale 字段" },
    { label: "置信度", value: k.confidence != null ? Number(k.confidence).toFixed(2) : "", reason: "详情接口未下发置信度" },
    { label: "质量分", value: k.qualityScore != null ? Number(k.qualityScore).toFixed(2) : "", reason: "详情接口未下发质量分" },
    { label: "分类", value: k.category, reason: "详情接口未下发分类" },
    { label: "域", value: k.domain, reason: "详情接口未下发域" },
    { label: "主题", value: k.theme, reason: "详情接口未下发主题" },
    { label: "使用次数", value: k.usageCount != null ? String(k.usageCount) : "", reason: "详情接口未下发使用次数" },
    { label: "创建时间", value: k.createdAt ? fmtStamp(k.createdAt) : "", reason: "详情接口未下发创建时间" },
    { label: "更新时间", value: k.updatedAt ? fmtStamp(k.updatedAt) : "", reason: "详情接口未下发更新时间" },
    { label: "来源层级", value: k.sourceLayer, reason: "详情接口未下发来源层级" },
    { label: "替代关系", value: k.supersededBy ? "已被 " + k.supersededBy + " 取代" : (k.stale === false ? "未被取代（supersededBy=null）" : ""), reason: "详情接口未下发替代关系" },
  ];
  const tags = parseTags(k.tags);

  return (
    <>
      <p className={styles.metaLine}>
        编号：<span className="mono">{id}</span> · 数据时刻：{asOfNote}
      </p>
      <div className={styles.grid}>
        <section className={styles.card + " " + styles.s8} data-state="ok" data-span="8">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>本体 · {k.title || "无标题"}</h2>
              <p className={styles.cardSub}>知识正文（按知识模板渲染）{truncated ? " · 已截断展示" : ""}</p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>
          {content ? (
            <div className={styles.prose}>
              {renderKt(truncated ? content.slice(0, CUT) : content)}
              {truncated ? <p className={styles.cutNote}>已截断：原文 {content.length} 字，此处展示前 {CUT} 字。</p> : null}
            </div>
          ) : (
            <p className={styles.emptyNote}>无内容（接口未返回 content 字段）。</p>
          )}
        </section>

        <section className={styles.card + " " + styles.s4} data-state="ok" data-span="4">
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>元信息</h2><span className={styles.tag}>只读</span></div>
          <ul className={styles.kv}>
            {meta.map((m) => (<MetaRow key={m.label} label={m.label} reason={m.reason}>{m.value}</MetaRow>))}
            <li>
              <span className={styles.kvKey}>标签</span>
              <span className={styles.kvVal}>
                {tags.length ? tags.map((t) => (<span key={t} className={styles.chipTag}>{t}</span>)) : <Na reason="详情接口未下发标签" />}
              </span>
            </li>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s12} data-state="ok" data-span="12">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>关联对象</h2>
              <p className={styles.cardSub}>同主题知识（最多 5 条，来自 /api/knowledge-list?search=主题）与溯源/图谱字段</p>
            </div>
            <span className={styles.tag}>只读</span>
          </div>
          {related.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.tbl}>
                <thead><tr><th>标题</th><th>分类</th><th>质量分</th><th>更新时间</th></tr></thead>
                <tbody>
                  {related.map((r) => (
                    <tr key={r.id}>
                      <td><Link className={styles.link} href={"/cognitive/knowledge/detail?id=" + encodeURIComponent(r.id)}>{r.title || r.id}</Link></td>
                      <td>{r.category || <Na reason="列表未下发分类" />}</td>
                      <td className={styles.num}>{r.qualityScore != null ? Number(r.qualityScore).toFixed(2) : <Na reason="列表未下发质量分" />}</td>
                      <td className={styles.num}>{r.updatedAt ? fmtStamp(r.updatedAt) : <Na reason="列表未下发更新时间" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : theme ? (
            <p className={styles.emptyNote}>无同主题关联知识（主题「{theme}」在 /api/knowledge-list 搜索无其它记录）。</p>
          ) : (
            <p className={styles.emptyNote}>无关联（该知识没有主题，无法按主题取关联；溯源字段见下）。</p>
          )}
          <ul className={styles.relList}>
            <MetaRow label="来源标识" reason="详情接口未下发 sourceId">{k.sourceId}</MetaRow>
            <MetaRow label="来源实践" reason="详情接口未下发 sourcePracticeId">{k.sourcePracticeId ? <Link className={styles.link} href={"/cognitive/practice/detail?id=" + encodeURIComponent(k.sourcePracticeId)}>{k.sourcePracticeId}</Link> : ""}</MetaRow>
            <MetaRow label="图谱节点" reason="详情接口未下发 mapId/pointName">{(k.mapId || k.pointName) ? <span className="mono">{k.mapId || "-"} / {k.pointName || "-"}</span> : ""}</MetaRow>
            <MetaRow label="来源层级 / 来源集合" reason="详情接口未下发 sourceLayer/sourceIds">{(k.sourceLayer || k.sourceIds) ? <span className="mono">{k.sourceLayer || "-"} / {parseList(k.sourceIds).join(", ") || "-"}</span> : ""}</MetaRow>
            <MetaRow label="内容摘要" reason="详情接口未下发 contentHash">{k.contentHash ? <span className="mono">{String(k.contentHash).slice(0, 24)}…</span> : ""}</MetaRow>
            <MetaRow label="被替代" reason="详情接口未下发 supersededBy">{k.supersededBy ? <span className="mono">{k.supersededBy}（{k.supersededAt ? fmtStamp(k.supersededAt) : "替代时间未下发"}）</span> : ""}</MetaRow>
          </ul>
        </section>

        <section className={styles.card + " " + styles.s12} data-state="ok" data-span="12">
          <div className={styles.cardHead}><h2 className={styles.cardTitle}>相关视图</h2><span className={styles.tag}>只读</span></div>
          <div className={styles.views}>
            <Link className={styles.viewCard} href="/cognitive/knowledge">
              <b>知识库列表</b><span>返回 /cognitive/knowledge，保留原有筛选</span>
            </Link>
            <Link className={styles.viewCard} href="/cognitive/knowledge?tab=governance">
              <b>知识治理</b><span>知识治理 tab（/cognitive/knowledge?tab=governance，本页仅跳转）</span>
            </Link>
            <Link className={styles.viewCard} href="/cognitive/reflection">
              <b>反思记录</b><span>反思路线列表（与知识产物同源）</span>
            </Link>
          </div>
          <p className={styles.foot}>本页只读（0.5.1）：无编辑/删除/保存入口；知识讨论与协作面板不在本批详情页范围。</p>
        </section>
      </div>
    </>
  );
}

export default function KnowledgeDetailPage() {
  return (
    <main className="page">
      <div className={styles.crumbNav} aria-label="页面层级">
        <span className={styles.crumbDim}>记忆与知识</span><span className={styles.sep}>/</span>
        <Link href="/cognitive/knowledge">知识库</Link><span className={styles.sep}>/</span>
        <span className={styles.current}>知识详情</span>
      </div>
      <PageHeader>
        <PageTitle>知识详情</PageTitle>
        <div className="page-subtitle">对象详情 · 知识：正文、元信息与关联对象（只读）</div>
        <div className={styles.chips} aria-label="页面层级标签"><span>#</span><span>认知</span><span>详情</span><span className={styles.chipOn}>只读</span></div>
      </PageHeader>
      <Suspense fallback={<SkelCards />}><Inner /></Suspense>
    </main>
  );
}