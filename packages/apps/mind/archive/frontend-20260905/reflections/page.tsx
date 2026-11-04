// 2026-07-20: /reflections -> /reflection 路由统一
// /reflections (373行, react-query) 与 /reflection (819行, useState) 功能重复
// 侧边栏已用 /reflection, 此 redirect 收敛旧路径
import { redirect } from "next/navigation";

export const dynamic = "force-static";

export default function ReflectionsRedirect() {
  redirect("/reflection");
}
