import StubPage from "@/components/StubPage";

// /docs — 0.4.39-05/07 目标 IA「服务 · 文档管理」新建页（结构性骨架，四态齐备）。
export default function DocsPage() {
  return (
    <StubPage
      title="文档管理"
      desc="平台文档（设计稿 / 运行手册 / 交接文档）的索引与检索。结构与四态先落地，数据待接入。"
      probe="/api/platform-health"
      todo="文档索引接口尚未接入。补齐路径：mind 的 /api/v1/platform/documentation 提供文档列表（路径 / 标题 / 更新时间 / 归属线）后接入；接入前本页保持「结构稿」，不显示 0 或示例数据。"
    />
  );
}
