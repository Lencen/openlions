"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/PracticeDetailBody (与列表侧边抽屉共用同一份渲染)。
// 2026-11-06 D-03（0.4.31）：页头（含面包屑）移出数据分支与 Suspense 边界 ——
//   <main> 提升到默认导出，边界内只剩正文；此前整块内容都在 useSearchParams 的边界里，
//   预渲染阶段整页走 fallback，首屏 HTML 连 page-header 都没有。现在加载 / 错误 / 空 / 有数据 四种情况都渲染页头。
//   面包屑与标题文案一字未改；页头里唯一依赖 URL 的「编号」单独放进自己的边界（预渲染输出既有的加载文案）。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import PracticeDetailBody from "@/components/cognitive/PracticeDetailBody";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

function DetailId() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  // 2026-11-06：文案用「编号」而不是「ID」—— ui-copy 门把 ID 判为技术词（基线 0），
  //   与 memory/detail 的「编号：」保持同一口径，语义不变。
  return <>编号：{id || "(样例)"}</>;
}

function PracticeDetailInner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (<PracticeDetailBody id={id} />);
}

export default function PracticeDetailPage() {
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/practice">实践</a><span className="sep">/</span><span className="current">实践详情</span></div>
    <PageHeader><PageTitle>实践详情</PageTitle><div className="page-subtitle"><Suspense fallback="（加载中...）"><DetailId /></Suspense></div></PageHeader>
    <Suspense fallback={<div>加载中...</div>}><PracticeDetailInner /></Suspense>
  </main></div>);
}
