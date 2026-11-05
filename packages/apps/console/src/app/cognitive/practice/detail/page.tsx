"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/PracticeDetailBody (与列表侧边抽屉共用同一份渲染)。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import PracticeDetailBody from "@/components/cognitive/PracticeDetailBody";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

function PracticeDetailInner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/practice">实践</a><span className="sep">/</span><span className="current">实践详情</span></div>
    <PracticeDetailBody
      id={id}
      renderHeader={(p: any, loading: boolean) => (
        <PageHeader><PageTitle>{p.title || "实践详情"}</PageTitle><div className="page-subtitle">{loading ? "（加载中...）" : `ID: ${p.id || id || "(样例)"}`}</div></PageHeader>
      )}
    />
  </main></div>);
}

export default function PracticeDetailPage() {
  return (<Suspense fallback={<div>加载中...</div>}><PracticeDetailInner /></Suspense>);
}
