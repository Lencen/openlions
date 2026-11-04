"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/MemoryDetailBody (与列表侧边抽屉共用同一份渲染)。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import MemoryDetailBody from "@/components/cognitive/MemoryDetailBody";

function MemoryDetailInner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (<div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/memory" style={{ color: "var(--text-dim)" }}>记忆库</a><span className="sep">/</span><span className="current">记忆详情</span></div>
        <MemoryDetailBody
          id={id}
          renderHeader={(m: any, loading: boolean) => (
            <div className="page-header"><div className="page-title">{m.title || "记忆详情"}</div><div className="page-subtitle">{loading ? "（加载中...）" : "编号：" + (m.id || id || "(样例)")}</div></div>
          )}
        />
      </main>
    </div>
  );
}

export default function MemoryDetailPage() {
  return (<Suspense fallback={<div>加载中...</div>}><MemoryDetailInner /></Suspense>);
}
