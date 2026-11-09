import StubPage from "@/components/StubPage";

// /agents/groups — 0.4.39-05/07 目标 IA「成员 · 小组」新建页（结构性骨架，四态齐备）。
export default function AgentGroupsPage() {
  return (
    <StubPage
      title="小组"
      desc="智能体分组（小组）的成员、配额与策略。结构与四态先落地，数据待接入。"
      probe="/api/agent-list"
      todo="小组的数据模型尚未在 mind 侧落地（当前库无 Group/小组表），所以本页没有可展示的数据。补齐路径：mind 提供 /api/v1/agent-groups（小组列表 + 成员 + 配额）后接入；接入前本页保持「结构稿」，不显示 0 或示例数据。"
    />
  );
}
