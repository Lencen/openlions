import { sessionApiKey } from "@/lib/secret";
import { NextRequest, NextResponse } from "next/server";

/**
 * Session 服务单 session 详情 proxy
 * GET /api/session-detail/{sessionUid}
 * 返回 { session, messages }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { uid: string } }
) {
  const sessionUid = decodeURIComponent(params.uid);

  try {
    const res = await fetch(
      `http://localhost:3002/api/v1/sessions/${encodeURIComponent(sessionUid)}`,
      {
        headers: { "X-API-Key": sessionApiKey(/* SESSION_SERVICE_API_KEY */) },
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: `session 服务 HTTP ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json(
      { error: `session 服务连接失败: ${e.message}` },
      { status: 503 }
    );
  }
}
// 1787060054.0294414
