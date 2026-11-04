"use client";
// reflections 页 · 反思列表 (点击行展开详情) (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Fragment } from "react";
import { interactiveProps } from "@/components/a11y";
import type { Refl } from "./reflectionsShared";
import { badge, chipStyle, fmtTs } from "./reflectionsShared";
import { fmtPct } from "@/lib/format";
import { t } from "@/i18n";
import ReflectionsDetail from "./ReflectionsDetail";
import TableCopyButton from "@/components/TableCopyButton";

export default function ReflectionsListTable({
  rows,
  loading,
  expandedId,
  detail,
  onOpen,
  onReload,
}: {
  rows: Refl[];
  loading: boolean;
  expandedId: string | null;
  detail: Record<string, Refl>;
  onOpen: (id: string) => void;
  onReload: (id: string) => void;
}) {
  return (
    <div className="panel"><div className="panel-header"><span className="panel-title">反思列表(点击行展开: 本体 / 审计 / 日结 / 派生任务回显)</span></div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>主题</th><th>粒度</th><th>状态</th><th>{t('biz.coverage.col')}</th><th>遗漏</th><th>改进</th><th>更新时间</th></tr></thead><tbody>
        {rows.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", padding: "var(--sp-3-5)", color: "var(--text-dim)" }}>{loading ? "加载中…" : "无"}</td></tr>}
        {rows.map((r) => {
          const openNow = expandedId === r.theme;
          return (
            // 2026-10-13 round 76-AX: 原来用 <span style={{display:"contents"}}> 包两行 <tr> —— <span> 不能是 <tbody> 的子元素
            //   (React 报 "In HTML, <span> cannot be a child of <tbody>" 且会 hydration 不匹配)。改用 Fragment。
            <Fragment key={r.theme}>
              <tr {...interactiveProps(openNow)} style={{ cursor: "pointer" }} onClick={() => onOpen(r.theme)}>
                <td style={{ color: openNow ? "var(--primary)" : "inherit", fontSize: "var(--fs-md)" }}>{r.theme}</td>
                <td><span style={chipStyle(r.reflectionGranularity === "day")}>{r.reflectionGranularity === "day" ? "日结" : "主题"}</span></td>
                <td><span className={badge(r.status)}>{r.status}</span></td>
                <td className="mono" style={{ fontSize: "var(--fs-base)" }}>{r.coverageScore != null ? fmtPct(r.coverageScore) + (r.coverageDelta != null ? " (" + (r.coverageDelta >= 0 ? "+" : "") + fmtPct(r.coverageDelta) + ")" : "") : "-"}</td>
                <td style={{ fontSize: "var(--fs-base)" }}>{(r.missedTopics || []).length}</td>
                <td style={{ fontSize: "var(--fs-base)" }}>{(r.improvements || []).length}</td>
                <td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTs(r.updatedAt)}</td>
              </tr>
              {openNow && <tr><td colSpan={7} style={{ background: "var(--bg-hover)", padding: 0 }}><div style={{ padding: "var(--sp-3-5) 18px" }}>{detail[r.theme] ? <ReflectionsDetail refl={detail[r.theme]} fmtTs={fmtTs} onRelease={() => onReload(r.theme)} /> : "加载详情…"}</div></td></tr>}
            </Fragment>
          );
        })}
      </tbody></table>
    </div>
  );
}
