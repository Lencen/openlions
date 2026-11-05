// [UI-S6 / 屏06] 智能体不存在 / 取数失败时的降级态 (不 500、不白屏)
import Link from "next/link";
import styles from "../page.module.css";

export default function AgentMissing({ id }: { id: string }) {
  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <Link href="/">概览</Link>
          <span className="sep">/</span>
          <Link href="/agents">智能体</Link>
          <span className="sep">/</span>
          <span className="current">未找到</span>
        </div>
        <div className={"panel " + styles.panelPad}>
          <div className={styles.missingTitle}>没有这个智能体</div>
          <div className={styles.missingDesc}>
            名册里查不到 <span className="mono">{id || "(空)"}</span>，或名册接口暂时不可用。
            &nbsp;<Link href="/agents" className={styles.link}>返回智能体列表</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
