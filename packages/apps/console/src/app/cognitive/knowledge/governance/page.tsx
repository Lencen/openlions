import { redirect } from "next/navigation";

// 2026-09-24 IA 整改 (todo_c73421c8e82c424e97e7): /cognitive/knowledge/governance 是
// /cognitive/knowledge 的子页, 按 2026-09-21 IA 重构「子页走 Tab + 嵌套路由」改为知识库页内 Tab。
// 本路由保留(不删除)为**重定向**到深链 /cognitive/knowledge?tab=governance, 避免既有链接 404
// (含 lib/todos.ts 里 knowledge_governance_review 的 href 与用户书签)。
// 治理概览正文已迁至 packages/apps/console/src/app/cognitive/knowledge/_components/KnowledgeGovernancePanel.tsx。
export default function KnowledgeGovernanceRedirect() {
  redirect("/cognitive/knowledge?tab=governance");
}
