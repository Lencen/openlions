/**
 * PATCH /api/v1/session-groups/[groupKey] — Update group extractStatus
 *
 * Body: { extractStatus: "PENDING"|"PROCESSING"|"DONE"|"FAILED", extractError?: string }
 *
 * mind pipeline 处理完 group 后调此接口更新状态
 *
 * 鉴权: X-API-Key
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// D-13 (2026-09-07): 双轨鉴权
import { authorizeApiKey } from "@/lib/routeAuth";

const VALID_STATUS = new Set(["PENDING", "PROCESSING", "DONE", "FAILED"]);

export async function PATCH(
  req: Request,
  { params }: { params: { groupKey: string } },
) {
  const auth = await authorizeApiKey(req.headers.get("x-api-key"));
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }
  const agentIdScope = auth.ok && auth.via === "mind" ? auth.agentId : null;

  try {
    const groupKey = decodeURIComponent(params.groupKey);
    const body = await req.json();
    const { extractStatus, extractError } = body;

    if (!extractStatus || !VALID_STATUS.has(extractStatus)) {
      return NextResponse.json(
        { success: false, error: `extractStatus 必须是 ${[...VALID_STATUS].join("/")} 之一` },
        { status: 422 },
      );
    }

    // sk-mind key: 只允许更新自己 agent 的 group 状态
    if (agentIdScope) {
      const owned = await prisma.sessionGroup.findUnique({
        where: { groupKey },
        include: { members: { where: { session: { agentId: agentIdScope } }, take: 1 } },
      });
      if (!owned || owned.members.length === 0) {
        return NextResponse.json({ success: false, error: "无权修改其他 agent 的 group" }, { status: 403 });
      }
    }

    const updated = await prisma.sessionGroup.update({
      where: { groupKey },
      data: {
        extractStatus,
        extractError: extractError || null,
        extractedAt: extractStatus === "DONE" || extractStatus === "FAILED" ? new Date() : null,
      },
      select: {
        id: true,
        groupKey: true,
        extractStatus: true,
        extractedAt: true,
      },
    });

    return NextResponse.json({ success: true, group: updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Record not found")) {
      return NextResponse.json({ success: false, error: "Group not found" }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 503 });
  }
}
