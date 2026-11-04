// GET /api/knowledge-dedupe/csrf — 签发 console 内部 CSRF nonce (2026-09-23 治理迁移)
// 同源 console 页面加载时调用; 服务端签发 + HttpOnly cookie + 响应体返回, 供 apply 双提交校验。
import { NextResponse } from "next/server";
import { issueNonce, csrfCookieName } from "@/lib/server/console-operator-gate";

export const dynamic = "force-dynamic";

export async function GET() {
  const nonce = issueNonce();
  const res = NextResponse.json({ ok: true, csrf: nonce });
  res.cookies.set(csrfCookieName(), nonce, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 1800,
  });
  return res;
}
