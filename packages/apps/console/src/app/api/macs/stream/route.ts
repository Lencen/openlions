import { NextRequest } from "next/server";
import { macsAdminKey, MACS_BASE } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// 2026-10-21 SSE 代理：浏览器不能直接带 x-api-key 连 MACS，所以由 console 服务端持 key 连上游，
// 再把事件流转发给浏览器。交接文档要求：断线要能看见（黄条 + 重连计数）—— 计数在客户端做。
// 说明：MACS 的 SSE 是**按 agent 订阅**的；console 目前订阅一个身份（默认 operator），
//   任何新消息只会触发"刷新列表"，不直接往消息流里塞（避免与分页/游标打架）。
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get("agent_id") || "agent-operator";
  const key = macsAdminKey();
  if (!key) return new Response("MACS admin key 未配置", { status: 503 });
  // 2026-10-21 实测：上游 /sse/{agent} 可能拒绝第二个会话（responder 已占位），fetch 会直接抛错。
  //   这里必须 catch，否则 Next 会返回 500（浏览器 EventSource 只会看到 error，无法区分原因）。
  let upstream: Response;
  try {
    upstream = await fetch(MACS_BASE + "/sse/" + encodeURIComponent(agentId), {
      headers: { "x-api-key": key, accept: "text/event-stream" },
      cache: "no-store",
    });
  } catch (e: any) {
    return new Response("MACS 实时通道不可用：" + String(e?.message || e), { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("MACS 实时通道拒绝连接（状态 " + upstream.status + "）", { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
