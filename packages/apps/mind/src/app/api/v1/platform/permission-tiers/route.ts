import { NextResponse } from "next/server";
import { describeAbcTiers } from "@/config/abc-permission-tiers";

/**
 * GET /api/v1/platform/permission-tiers — ABC 权限分级清单 (A 类只读, 无入参)
 *
 * agent-x P0#11 交付物: A 类"配清单" + B 类三件套台账 + C 类永不触碰清单。
 * 本 route 不依赖 DB/prisma, 纯配置派生, 可被探针直接调用复算。
 */
export async function GET() {
  return NextResponse.json(describeAbcTiers());
}
