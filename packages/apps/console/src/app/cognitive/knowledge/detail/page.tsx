"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/KnowledgeDetailBody (与列表侧边抽屉共用同一份渲染)。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import KnowledgeDetailBody from "@/components/cognitive/KnowledgeDetailBody";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

function KnowledgeDetailInner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/knowledge">知识库</a><span className="sep">/</span><span className="current">知识详情</span></div>
    <KnowledgeDetailBody
      id={id}
      renderHeader={(k: any, loading: boolean) => (
        <PageHeader><PageTitle>{k.title || "知识详情"}</PageTitle><div className="page-subtitle">{loading ? "（加载中...）" : `ID: ${k.id || id || "(样例)"}`}</div></PageHeader>
      )}
    />
  </main></div>);
}

export default function KnowledgeDetailPage() {
  return (<Suspense fallback={<div>加载中...</div>}><KnowledgeDetailInner /></Suspense>);
}
