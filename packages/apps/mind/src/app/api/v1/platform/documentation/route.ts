import { NextResponse } from "next/server";
import { describePlatformDocumentation } from "@/config/platform-documentation";

/**
 * GET /api/v1/platform/documentation — 平台静态档 (uos20 P2#10, A 类只读, 无入参)
 *
 * 交付物: 回答"平台是什么"—— 能力边界 / 服务清单 / 限制条件 / 版本兼容矩阵。
 * 与 capabilities 的边界: 本接口是**静态档** (带版本号, 不随请求变化);
 *   "我现在能调什么"请用 GET /api/v1/platform/capabilities (动态)。
 *   (平台记忆 cmuc5i5jy / cmue9y6gw: 两接口必须显式区分, 否则会塌成一个)
 *
 * 只读纪律: 纯配置派生, 不依赖 DB/prisma/网络; 可被探针直接调用复算。
 * 缓存: 静态内容 → force-static, 避免每次请求重新组装与不必要的动态标记。
 */
export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(describePlatformDocumentation());
}
