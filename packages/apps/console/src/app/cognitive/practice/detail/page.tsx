"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/PracticeDetailBody (与列表侧边抽屉共用同一份渲染)。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import PracticeDetailBody from "@/components/cognitive/PracticeDetailBody";

function PracticeDetailInner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/practice" style={{ color: "var(--text-dim)" }}>实践</a><span className="sep">/</span><span className="current">实践详情</span></div>
    <PracticeDetailBody
      id={id}
      renderHeader={(p: any, loading: boolean) => (
        <div className="page-header"><div className="page-title">{p.title || "实践详情"}</div><div className="page-subtitle">{loading ? "（加载中...）" : `ID: ${p.id || id || "(样例)"}`}</div></div>
      )}
    />
  </main></div>);
}

export default function PracticeDetailPage() {
  return (<Suspense fallback={<div>加载中...</div>}><PracticeDetailInner /></Suspense>);
}
