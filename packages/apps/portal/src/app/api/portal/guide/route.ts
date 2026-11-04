import { NextRequest, NextResponse } from "next/server";
import { GUIDE_VERSION, GUIDE_UPDATED_AT, getGuideSections, getGuideMarkdown, resolvePlatformBase } from "@/lib/platform-guide";

// GET /api/portal/guide?format=json|md&agentHost=xxx
// Agent 自助拉取最新接入文档: 版本号 + 分节内容 + 平台可达地址
// - 心跳响应会带 guideVersion, agent 发现版本变了就重新拉这里
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") || "json";
  const agentHost = sp.get("agentHost") || "";
  const base = resolvePlatformBase(agentHost);

  if (format === "md") {
    // markdown 整篇 (适合 agent 直接读进 context / 人类复制)
    return new NextResponse(getGuideMarkdown(), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Guide-Version": GUIDE_VERSION,
      },
    });
  }

  // JSON: 结构化 (适合程序处理)
  return NextResponse.json({
    ok: true,
    version: GUIDE_VERSION,
    updatedAt: GUIDE_UPDATED_AT,
    base: base,
    sections: getGuideSections(),
    markdown: getGuideMarkdown(),
  });
}

// GET /api/portal/guide/version - 轻量版本检查 (心跳可调用)
export async function POST(req: NextRequest) {
  return NextResponse.json({ ok: true, version: GUIDE_VERSION, updatedAt: GUIDE_UPDATED_AT });
}
