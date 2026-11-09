"use client";
// 2026-11-06 D-03：页面标记（根 layout 一处，SSR 输出稳定标记 data-page）
//   为什么放在 layout：D-03 验收要求"标记由 layout 层 SSR 输出"，不能每页写死（否则总会漏几页）。
//   客户端页在数据到之前可能没有页头，但一定有这个标记，判据据此断言"这一页确实渲染了"。
import { usePathname } from "next/navigation";
import { pageKeyOf } from "@/lib/pageKey";

export default function PageMarker() {
  const pathname = usePathname() || "";
  const key = pageKeyOf(pathname);
  // 不在清单里的路径（如 404 / 反向样本）不写标记，判据据此判"确实不在清单"。
  if (!key) return null;
  return <div data-page={key} hidden aria-hidden="true" />;
}
