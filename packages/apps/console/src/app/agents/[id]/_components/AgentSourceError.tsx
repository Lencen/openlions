// [UI-S6] 名册接口取数失败降级态 —— 与 AgentMissing 区分:
//   AgentMissing 表示「名册取数成功但查不到该 agent」;
//   本组件表示「名册接口本身失败, 无法判断 agent 是否存在」, 避免把取数失败显示成「没有这个智能体」。
// 2026-11-06 D-03：去掉 "use client" —— 本组件只用 Link / ReactNode，无任何 hooks 与事件，
//   改成服务端组件后，页头（header 插槽）与其他降级态走同一条服务端渲染路径，
//   不再依赖"服务端把 ReactNode 传给客户端组件"这条边界（虽然合法，但少一层可少一个坑）。
import Link from "next/link";
import styles from "../page.module.css";

export default function AgentSourceError({ id, header }: { id: string; header?: React.ReactNode }) {
  return (
    <div className="layout-with-sidebar">
      <main className="main">
        {/* 2026-11-06 D-03：降级态也要先出页头（否则 SSR 无 page-header） */}
        {header}
        <div className="breadcrumb">
          <Link href="/">概览</Link>
          <span className="sep">/</span>
          <Link href="/agents">智能体</Link>
          <span className="sep">/</span>
          <span className="current">取数失败</span>
        </div>
        <div className={"panel " + styles.panelPad}>
          <div className={styles.errorTitle}>名册接口取数失败</div>
          <div className={styles.errorDesc}>
            暂时读不到智能体名册（<span className="mono">/api/agent-list</span>），因此无法确认 <span className="mono">{id || "(空)"}</span> 是否存在。
            <br />这不等于「没有这个智能体」—— 请稍后刷新，或检查 BFF。
            <br /><Link href="/agents" className={styles.link}>返回智能体列表</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
