import { redirect } from "next/navigation";

// 2026-11-15 B4-6 修复：**生产构建（next start）下本页曾被静态预渲染** —— 构建期 redirect() 被固化成
//   静态 RSC 载荷里的 NEXT_REDIRECT digest，运行时只回 307 而**不带 Location**（实测 3004/3106：
//   `curl -sI /cognitive/knowledge/governance` => 307 + x-nextjs-cache: HIT + 无 Location）；
//   dev（next dev）在请求期执行 redirect()，所以 307+Location 正常 —— 这就是"实测 307 无 Location"的根因。
//   修法：本页强制动态渲染（请求期执行 redirect），生产构建同样返回 307 + Location。
export const dynamic = "force-dynamic";

// 2026-09-24 IA 整改 (todo_c73421c8e82c424e97e7): /cognitive/knowledge/governance 是
// /cognitive/knowledge 的子页, 按 2026-09-21 IA 重构「子页走 Tab + 嵌套路由」改为知识库页内 Tab。
// 本路由保留(不删除)为**重定向**到深链 /cognitive/knowledge?tab=governance, 避免既有链接 404
// (含 lib/todos.ts 里 knowledge_governance_review 的 href 与用户书签)。
// 治理概览正文已迁至 packages/apps/console/src/app/cognitive/knowledge/_components/KnowledgeGovernancePanel.tsx。
export default function KnowledgeGovernanceRedirect() {
  redirect("/cognitive/knowledge?tab=governance");
}
