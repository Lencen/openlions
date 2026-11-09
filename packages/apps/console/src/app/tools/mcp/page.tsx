import StubPage from "@/components/StubPage";

// /tools/mcp — 0.4.39-05/07 目标 IA「工具箱 · MCP」新建页（结构性骨架，四态齐备）。
export default function McpPage() {
  return (
    <StubPage
      title="工具服务"
      desc="工具服务注册表：已接入的外部工具服务、工具清单与健康状态。结构与四态先落地，数据待接入。"
      probe="/api/mcp-proxy"
      todo="工具服务注册表接口尚未接入（数据卡 12 待补）。补齐路径：mcp-proxy 提供 /api/mcp/servers（工具服务列表 + 工具数 + 健康）后接入；接入前本页保持「结构稿」，不显示 0 或示例数据。"
    />
  );
}
