import { PageHeader, PageTitle, Pill, StateBlock } from "@/components/ui";

// /about — 0.4.39-05/07 目标 IA「平台 · 关于平台」新建页（静态信息页，无取数）。
//   口径：只写可从仓库/构建确定的静态事实，不编造运行态数据；运行态看「运维看板」。
export default function AboutPage() {
  return (
    <main className="page">
      <PageHeader>
        <PageTitle>关于平台</PageTitle>
        <Pill tone="neutral">静态</Pill>
      </PageHeader>

      <StateBlock
        title="LIONS Console"
        desc={
          <>
            平台控制台（只读看板 + 配置入口）。版本随发布车推进，具体版本号看右下角版本标记或
            <a href="/system/version-board"> 版本看板</a>。
            <br />
            本页是静态信息页：不取运行态数据；服务健康、库状态、发布记录请到「运维看板」。
          </>
        }
      />

      <StateBlock
        title="入口与约定"
        desc={
          <>
            · 设计与规范：<a href="/design">设计规范</a>、<a href="/platform/logic">平台逻辑</a>
            <br />
            · 运行状态：<a href="/system/health">运维看板</a>、<a href="/system/version-board">版本看板</a>
            <br />
            · 文档与交接：仓库 docs/ 目录（设计稿 / 运行手册 / 交接文档），文档索引页待接入（/docs）
          </>
        }
      />
    </main>
  );
}
