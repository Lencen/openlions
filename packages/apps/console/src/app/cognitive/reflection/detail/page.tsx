"use client";
import { inkOf } from "@/lib/ink";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/ReflectionDetailBody (与列表侧边抽屉共用同一份渲染)。
// 两个 id 体系并存 (旧 Reflection 记录 / 主题反思 FlywheelReflection) 的判定逻辑在 body 内, 页面只负责面包屑与标题。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ReflectionDetailBody from "@/components/cognitive/ReflectionDetailBody";

function Inner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (
    <div className="layout-with-sidebar"><main className="main">
      <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/reflection" style={{ color: "var(--text-dim)" }}>反思</a><span className="sep">/</span><span className="current">反思详情</span></div>
      <ReflectionDetailBody
        id={id}
        renderHeader={(ctx: any) => (
          <>
            <div className="page-header">
              <div className="page-title">{ctx.fw ? `主题反思 · ${ctx.fw.theme}` : ctx.legacy?.title || "反思详情"}</div>
              <div className="page-subtitle">{ctx.loading ? "（加载中...）" : `ID: ${ctx.discEntityId || "(样例)"}`}</div>
            </div>
            {!ctx.loading && id ? (
              <div style={{ marginTop: "var(--sp-1-5)", fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>
                讨论挂载：<b style={{ color: ctx.fw ? inkOf("var(--table-knowledge)") : inkOf("var(--table-memory)") }}>{ctx.fw ? "主题反思" : ctx.legacy?.id ? "反思记录" : "未识别"}</b>
                <span className="mono tiny" style={{ marginLeft: "var(--sp-1-5)" }}>{(ctx.discEntityId || "").slice(0, 12)}…</span>
                {ctx.fw && ctx.legacy?.id ? <span className="tiny"> · 该 id 在两套体系中都存在, 讨论挂在主题反思上</span> : null}
                {!ctx.fw && ctx.legacy?.id ? <span className="tiny"> · 未匹配到主题反思, 讨论挂在旧反思记录上</span> : null}
                {ctx.fw && !ctx.legacy?.id ? <span className="tiny"> · 旧反思表没有这条 id (两套 id 不通用)</span> : null}
              </div>
            ) : null}
          </>
        )}
      />
    </main></div>
  );
}

export default function ReflectionDetailPage() {
  return (<Suspense fallback={<div>加载中...</div>}><Inner /></Suspense>);
}
