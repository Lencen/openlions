// 2026-11-02（前端线 B2）：页面版本号的**唯一出口**。
// 页面不再写死版本，而是读这里；这里读仓库根 VERSION + git 提交 + 进程启动时刻。
// 用法：curl -s localhost:3014/api/version | jq
import { NextResponse } from "next/server";
import { readVersionInfo } from "@/lib/server/version";

// 版本随部署变化，且要能区分"改了代码没重启"，不能走静态缓存。
export const dynamic = "force-dynamic";

export async function GET() {
  const v = readVersionInfo();
  return NextResponse.json(v, { headers: { "Cache-Control": "no-store" } });
}
