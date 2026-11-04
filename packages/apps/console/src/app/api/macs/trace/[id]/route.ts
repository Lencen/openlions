import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// 2026-10-22 兼容别名：/api/macs/trace/<id>（主路径是 /api/macs/trace?id=…）。
// 后端探测脚本常用路径段写法；两者等价，转发到主实现（把 id 拼成查询参数再调用）。
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "").trim();
  const url = new URL(req.url);
  url.pathname = "/api/macs/trace";
  url.search = "?id=" + encodeURIComponent(id);
  const r = await fetch(url.toString(), { headers: { accept: "application/json" }, cache: "no-store" });
  const body = await r.json().catch(() => ({ ok: false, error: "别名转发失败" }));
  return NextResponse.json(body, { status: r.status });
}
