// lib/server/proxy-fetch.ts — 安全的上游 HTTP fetch 工具 (2026-09-28 立)
//
// 立规背景(实测发现的 console 系统性 bug):
//   packages/apps/console/src/app/api 下 10+ 个 proxy route 都长这样:
//     const res = await fetch(<upstream URL>)
//     const data = await res.json()
//     return NextResponse.json(data?.result?.data?.json || ...)
//   没有 res.ok 检查、没有 try/catch、没有 content-type 检查。
//   上游一旦返回非 JSON(404 / 500 HTML 页 / proxy error / 502 网关错误 / 任何非 200)
//   ---> JSON.parse(<!DOCTYPE...>) 抛 SyntaxError, proxy 自身 500。
// 实测示例(09-28): GET /api/skills-list?... -> 500 (上游 trpc/skills.list 当时返回 HTML 页),
//   console-dev.log 报 `SyntaxError: Unexpected token '<', "<!DOCTYPE "...`。
//
// 本 helper 修法: 显式状态检查 + try/catch + 标准化错误返回, 防止 proxy 变 500。
//   调用方拿到的永远是结构化结果(成功 -> JSON, 失败 -> 标准化错误响应), 不需要自己 try/catch。
//
// 用法:
//   import { safeFetchJson } from "@/lib/server/proxy-fetch";
//   const r = await safeFetchJson(url, { timeoutMs: 5000 });
//   if (!r.ok) return NextResponse.json({ items: [], total: 0, _error: r.error }, { status: 502 });
//   return NextResponse.json(r.data);
//
// 不影响成功路径: status 2xx 时与 await res.json() 等价, 只是包了一层 try/catch + 非 2xx 检测。

/** 2026-10-13 round 76-EJ: 把上游返回的 status **规整成合法 HTTP 状态**。
 *  背景: 上游不可达时 status 可能是 **0**(或任何 200-599 之外的值); 直接塞进 NextResponse 会抛
 *    `RangeError: init["status"] must be in the range of 200 to 599, inclusive.`
 *  —— **实测已把 console 的 dev server 打挂**(GET /api/session-stats, 见 console-dev.log)。
 *  全站 10+ 处 proxy route 都在写 `status: r.status` / `status: res.status`, 因此统一用本函数收口。
 */
export function safeStatus(s: number | undefined | null, fallback = 502): number {
  const n = Number(s);
  return Number.isFinite(n) && n >= 200 && n <= 599 ? n : fallback;
}

export type ProxyFetchResult =
  | { ok: true; status: number; data: any }
  | { ok: false; status: number; error: string; htmlHint?: boolean };

export async function safeFetchJson(
  url: string,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: string;
  } = {}
): Promise<ProxyFetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: ctrl.signal,
      headers: opts.headers,
      ...(opts.method ? { method: opts.method } : {}),
      ...(opts.body ? { body: opts.body } : {}),
    });
    const status = res.status;
    const txt = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status,
        error: `上游返回错误 ${res.status} ${res.statusText}`.slice(0, 200),
        htmlHint: txt.trimStart().startsWith("<"),
      };
    }
    try {
      return { ok: true, status, data: txt.length === 0 ? null : JSON.parse(txt) };
    } catch (e: unknown) {
      return {
        ok: false,
        status,
        error: "上游返回成功但响应内容不是合法数据格式: " + String((e as { message?: string })?.message || "").slice(0, 150),
        htmlHint: txt.trimStart().startsWith("<"),
      };
    }
  } catch (e: unknown) {
    const msg = String((e as { message?: string })?.message || "");
    const isAbort = /aborted|aborted\b/i.test(msg);
    return { ok: false, status: 0, error: isAbort ? `请求上游超时 (${opts.timeoutMs ?? 8000}ms)` : `请求上游失败: ${msg}`.slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}
