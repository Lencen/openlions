"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/SkillDetailBody (与列表侧边抽屉共用同一份渲染)。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import SkillDetailBody from "@/components/cognitive/SkillDetailBody";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

function SkillDetailInner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/skills">技能</a><span className="sep">/</span><span className="current">技能详情</span></div>
    <SkillDetailBody
      id={id}
      renderHeader={(s: any, loading: boolean) => (
        <PageHeader><PageTitle>{s.name || "技能详情"}</PageTitle><div className="page-subtitle">{loading ? "（加载中...）" : `ID: ${s.id || id || "(样例)"} · v${s.version ?? 1}${s.legacy ? " · 存量(无步骤)" : ""}`}</div></PageHeader>
      )}
    />
  </main></div>);
}

export default function SkillDetailPage() {
  return (<Suspense fallback={<div>加载中...</div>}><SkillDetailInner /></Suspense>);
}
