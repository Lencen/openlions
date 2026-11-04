// 2026-07-12: 兼容旧路径 /skill → /skills (单复数错配修复)
// 用户可能在收藏夹/外链中仍有 /skill，此 redirect 静默迁移到 /skills
import { redirect } from "next/navigation";

export const dynamic = "force-static";

export default function SkillRedirect() {
  redirect("/skills");
}
