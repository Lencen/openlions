/**
 * PATCH /api/v1/sessions/:sessionUid/status — V1 §15.2.1 HTTP contract
 *
 * mind puller 处理完 session 后回调, 更新 extractStatus
 *
 * Body:
 *   {
 *     status: "PROCESSING" | "DONE" | "FAILED",
 *     processedBy: "mind-pull",
 *     error?: "..."
 *   }
 *
 * Response 200:
 *   { sessionUid, status, processedAt, version }
 *
 * 错误:
 *   401 — api key 缺失或无效
 *   404 — sessionUid 不存在
 *   409 — 状态版本冲突 (If-Match 不匹配)
 *   422 — 参数非法
 *   503 — DB 不可用
 */

import { requireSecret } from "@/lib/secret";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const DEFAULT_API_KEYS = requireSecret("LIONS_UPLOAD_API_KEYS");
const ALLOWED_STATUS = new Set(["PROCESSING", "DONE", "FAILED"]);

function getAuthorizedKeys(): Set<string> {
  const raw = process.env.LIONS_UPLOAD_API_KEYS || DEFAULT_API_KEYS;
  return new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
  );
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionUid: string }> }
) {
  // auth
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || !getAuthorizedKeys().has(apiKey)) {
    return NextResponse.json(
      { success: false, error: "X-API-Key 缺失或无效" },
      { status: 401 }
    );
  }

  try {
    const { sessionUid } = await params;
    if (!sessionUid) {
      return NextResponse.json(
        { success: false, error: "sessionUid 必填" },
        { status: 422 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      status?: string;
      processedBy?: string;
      error?: string;
    };

    if (!body.status || !ALLOWED_STATUS.has(body.status)) {
      return NextResponse.json(
        {
          success: false,
          error: `status 必须是 ${Array.from(ALLOWED_STATUS).join("|")}`,
        },
        { status: 422 }
      );
    }

    const existing = await prisma.session.findUnique({
      where: { sessionUid },
      select: { id: true, extractStatus: true, updatedAt: true },
    });

    if (!existing) {
      return NextResponse.json(
        { success: false, error: `session ${sessionUid} 不存在` },
        { status: 404 }
      );
    }

    // 状态机: PENDING → PROCESSING → DONE / FAILED
    // 不允许 PENDING ← DONE 这种回退
    const transitions: Record<string, Set<string>> = {
      PENDING: new Set(["PROCESSING"]),
      PROCESSING: new Set(["DONE", "FAILED"]),
      DONE: new Set(),
      FAILED: new Set(["PROCESSING"]), // 允许重试
    };
    const cur = existing.extractStatus || "PENDING";
    if (!transitions[cur]?.has(body.status)) {
      return NextResponse.json(
        {
          success: false,
          error: `状态 ${cur} → ${body.status} 不允许`,
        },
        { status: 409 }
      );
    }

    const now = new Date();
    const updated = await prisma.session.update({
      where: { id: existing.id },
      data: {
        extractStatus: body.status,
        extractedAt: body.status === "DONE" ? now : undefined,
        extractError: body.error ?? null,
        mindSyncedAt: now,
        // D-17 (2026-09-07): 显式刷新 updatedAt — RETRYABLE 扫描依赖它做冷却下界,
        //   防未来绕过本 PATCH 的写路径(如 updateMany)不刷新时间导致过早重试
        updatedAt: now,
      },
      select: { id: true, extractStatus: true, updatedAt: true },
    });

    return NextResponse.json({
      sessionUid,
      status: updated.extractStatus,
      processedAt: updated.updatedAt.toISOString(),
      version: updated.updatedAt.getTime(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[PATCH /api/v1/sessions/:uid/status] error:", msg);
    return NextResponse.json(
      { success: false, error: "服务暂不可用", detail: msg },
      { status: 503 }
    );
  }
}