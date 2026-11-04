import { redirect } from "next/navigation";

// 审计模块首页 -> 默认跳到每日总结
export default function AuditPage() {
  redirect("/audit/daily-summary");
}
