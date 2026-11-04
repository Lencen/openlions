import { NextResponse } from "next/server";
import { describePlatformCapabilities } from "@/config/platform-capabilities";

/**
 * GET /api/v1/platform/capabilities — 平台动态能力清单 (uos20 P2#10 配套, A 类只读, 无入参)
 *
 * 交付物: 回答"我**现在**能调什么"—— 当前可用 A 类只读接口活清单 + 调用方鉴权状态。
 *   活: 清单每请求从 readonly-protocol-whitelist 现算 (白名单扩一条即多一条)。
 * 与 documentation 的边界: 平台静态能力边界/服务清单/限制条件/版本矩阵属于
 *   GET /api/v1/platform/documentation (静态档), 本接口不重复陈述。
 *
 * 入参: 无 (白名单 schema 为空集, 任何 query 参数被平台层 400 拒绝)。
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return NextResponse.json(describePlatformCapabilities(req.headers));
}
