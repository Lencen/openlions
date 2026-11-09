"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/ReflectionDetailBody (与列表侧边抽屉共用同一份渲染)。
// 两个 id 体系并存 (旧 Reflection 记录 / 主题反思 FlywheelReflection) 的判定逻辑在 body 内, 页面只负责面包屑与标题。
// 2026-11-06 D-03（0.4.31）：页头（含面包屑）移出数据分支与 Suspense 边界 ——
//   <main> 提升到默认导出，边界内只剩正文 + 「讨论挂载」行（那一行本身是数据派生，仍由 renderHeader 注入）；
//   此前整块内容都在 useSearchParams 的边界里，预渲染阶段整页走 fallback，首屏 HTML 连 page-header 都没有。
//   现在加载 / 错误 / 空 / 有数据 四种情况都渲染页头；面包屑与标题文案一字未改。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ReflectionDetailBody from "@/components/cognitive/ReflectionDetailBody";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

function DetailId() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  // 2026-11-06：文案用「编号」而不是「ID」—— ui-copy 门把 ID 判为技术词（基线 0），
  //   与 memory/detail 的「编号：」保持同一口径，语义不变。
  return <>编号：{id || "(样例)"}</>;
}

function Inner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (
    <ReflectionDetailBody
      id={id}
      renderHeader={(ctx: any) => (
        <>
          {/* 2026-11-05 P2 批8：挂载类型文字色改 data-kind + 属性选择器，动态色配方同 inkOf */}
          {!ctx.loading && id ? (
            <div className={styles.mountRow}>
              讨论挂载：<b className={styles.mountKind} data-kind={ctx.fw ? "fw" : "legacy"}>{ctx.fw ? "主题反思" : ctx.legacy?.id ? "反思记录" : "未识别"}</b>
              <span className={"mono tiny " + styles.mountId}>{(ctx.discEntityId || "").slice(0, 12)}…</span>
              {ctx.fw && ctx.legacy?.id ? <span className="tiny"> · 该 id 在两套体系中都存在, 讨论挂在主题反思上</span> : null}
              {!ctx.fw && ctx.legacy?.id ? <span className="tiny"> · 未匹配到主题反思, 讨论挂在旧反思记录上</span> : null}
              {ctx.fw && !ctx.legacy?.id ? <span className="tiny"> · 旧反思表没有这条 id (两套 id 不通用)</span> : null}
            </div>
          ) : null}
        </>
      )}
    />
  );
}

export default function ReflectionDetailPage() {
  return (<div className="layout-with-sidebar"><main className="main">
    {/* 2026-11-05 P2 批8：面包屑弱化色下沉到 module.css */}
    <div className="breadcrumb"><span className={styles.crumbDim}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/reflection" className={styles.crumbDim}>反思</a><span className="sep">/</span><span className="current">反思详情</span></div>
    <PageHeader><PageTitle>反思详情</PageTitle><div className="page-subtitle"><Suspense fallback="（加载中...）"><DetailId /></Suspense></div></PageHeader>
    <Suspense fallback={<div>加载中...</div>}><Inner /></Suspense>
  </main></div>);
}
