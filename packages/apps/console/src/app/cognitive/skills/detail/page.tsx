"use client";
// 2026-09-14 UI-3: 详情正文已抽到 @/components/cognitive/SkillDetailBody (与列表侧边抽屉共用同一份渲染)。
// 2026-11-06 D-03（0.4.31）：页头（含面包屑）移出数据分支与 Suspense 边界 ——
//   <main> 提升到默认导出，边界内只剩正文；此前整块内容都在 useSearchParams 的边界里，
//   预渲染阶段整页走 fallback，首屏 HTML 连 page-header 都没有。现在加载 / 错误 / 空 / 有数据 四种情况都渲染页头。
//   面包屑与标题文案一字未改；页头里唯一依赖 URL 的「编号」单独放进自己的边界（预渲染输出既有的加载文案）。
//   说明里原有的「· v<版本> · 存量(无步骤)」是数据派生文本，留在正文「基础信息」的版本 / 步骤两行（未删信息）。
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import SkillDetailBody from "@/components/cognitive/SkillDetailBody";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

function DetailId() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  // 2026-11-06：文案用「编号」而不是「ID」—— ui-copy 门把 ID 判为技术词（基线 0），
  //   与 memory/detail 的「编号：」保持同一口径，语义不变。
  return <>编号：{id || "(样例)"}</>;
}

function SkillDetailInner() {
  const params = useSearchParams();
  const id = params.get("id") || "";
  return (<SkillDetailBody id={id} />);
}

export default function SkillDetailPage() {
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>记忆与知识</span><span className="sep">/</span><a href="/cognitive/skills">技能</a><span className="sep">/</span><span className="current">技能详情</span></div>
    <PageHeader><PageTitle>技能详情</PageTitle><div className="page-subtitle"><Suspense fallback="（加载中...）"><DetailId /></Suspense></div></PageHeader>
    <Suspense fallback={<div>加载中...</div>}><SkillDetailInner /></Suspense>
  </main></div>);
}
