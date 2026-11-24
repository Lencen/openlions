// B4 · [id] 子页加载骨架（loading 态真实入口：Next App Router loading.tsx）
// 只在本目录内使用既有 B4 样式，不改共享组件；页头先出标题，数据区出骨架，避免白屏。
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import s from "./_components/b4.module.css";

export default function AgentTabLoading() {
  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <span>成员</span>
          <span className="sep">/</span>
          <span>智能体</span>
          <span className="sep">/</span>
          <span className="current">加载中</span>
        </div>
        <PageHeader>
          <PageTitle>智能体详情</PageTitle>
          <div className="page-subtitle">正在读取名册 / 实时状态 / 会话档案…</div>
        </PageHeader>
        <div className={s.chips} aria-label="页面层级">
          <span className={s.chip}>#</span>
          <span className={s.chip}>智能体</span>
          <span className={s.chip}>详情</span>
          <span className={s.chip + " " + s.chipOn}>只读</span>
        </div>
        <div className={s.grid}>
          <div className={s.card + " " + s.s3}><span className={s.skel + " " + s.skelSm} /><span className={s.skel} /></div>
          <div className={s.card + " " + s.s3}><span className={s.skel + " " + s.skelSm} /><span className={s.skel} /></div>
          <div className={s.card + " " + s.s3}><span className={s.skel + " " + s.skelSm} /><span className={s.skel} /></div>
          <div className={s.card + " " + s.s3}><span className={s.skel + " " + s.skelSm} /><span className={s.skel} /></div>
          <div className={s.card + " " + s.s8}><span className={s.skel + " " + s.skelSm} /><span className={s.skel} /><span className={s.skel} /><span className={s.skel} /></div>
          <div className={s.card + " " + s.s4}><span className={s.skel + " " + s.skelSm} /><span className={s.skel} /><span className={s.skel} /></div>
          <div className={s.card + " " + s.s12}><span className={s.skel + " " + s.skelSm} /><span className={s.skel} /></div>
        </div>
      </main>
    </div>
  );
}
