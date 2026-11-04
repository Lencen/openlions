// 2026-09-23 知识治理 portal→console 迁移 (todo_d1dd23282b93437f86fb):
//   console 内部操作门禁 —— 替代 portal 侧可伪造的 `x-lions-operator: operator` 硬编码头。
//
// 威胁模型: 治理 apply 会改 Knowledge.supersededBy 链(约 2.9 万条), 属破坏性内部动作。
//   portal 旧实现用"同源校验 + 硬编码 operator 头", 对公开站点等于无防护(同源人人可造, 头可伪造)。
//   console 是内部管理台, 本门禁在此之上给破坏性写操作两条**不可伪造**通道:
//     A) 浏览器(console 页面): 同源 + 双提交 CSRF nonce
//        - nonce 由 console 服务端签发(crypto.randomBytes), 同时写入 HttpOnly+SameSite=Strict cookie
//          并在响应体返回给同源页面; apply 必须带上 header `x-console-csrf` 且与 cookie 一致,
//          且 nonce 在服务端已签发登记表内(TTL 30min)。跨站页面既读不到 HttpOnly cookie,
//          也读不到响应体(SOP), 因此无法伪造。
//     B) 脚本/运维(无浏览器): header `x-console-operator-token` 必须等于服务端 env
//        `LIONS_CONSOLE_OPERATOR_TOKEN`(常量时间比较)。该值不在源码中, 未配置时该通道 fail-closed 关闭。
//
// 说明: 源码中不存在任何硬编码的操作者口令/头值。
import crypto from "crypto";

const NONCE_TTL_MS = 30 * 60 * 1000;
const CSRF_COOKIE = "lions_console_csrf";

// nonce 登记表(单进程 Next.js; 仅用于"确由本服务签发"的证明, 不承载身份)
const issuedNonces = new Map<string, number>();

function sweep(now: number) {
  issuedNonces.forEach((exp, k) => {
    if (exp < now) issuedNonces.delete(k);
  });
}

/** 签发一次性 CSRF nonce(写入登记表, TTL 30min) */
export function issueNonce(): string {
  const now = Date.now();
  sweep(now);
  const nonce = crypto.randomBytes(24).toString("base64url");
  issuedNonces.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

export function csrfCookieName(): string {
  return CSRF_COOKIE;
}

/** nonce 是否为本服务签发且未过期 */
export function isIssuedNonce(nonce: string): boolean {
  if (!nonce) return false;
  const now = Date.now();
  sweep(now);
  const exp = issuedNonces.get(nonce);
  return !!exp && exp >= now;
}

function readCookie(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return part.slice(idx + 1).trim(); }
    }
  }
  return "";
}

function isSameOrigin(req: Request): boolean {
  const host = req.headers.get("host") || "";
  if (!host) return false;
  const origin = req.headers.get("origin") || "";
  const referer = req.headers.get("referer") || "";
  try {
    if (origin) return new URL(origin).host === host;
    if (referer) return new URL(referer).host === host;
  } catch {
    return false;
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface GateResult {
  ok: boolean;
  actor?: string;
  status?: number;
  error?: string;
  detail?: string;
}

/**
 * console 破坏性操作门禁(fail-closed)。
 * 通过: { ok:true, actor }；拒绝: { ok:false, status, error, detail }。
 */
export function consoleOperatorGate(req: Request): GateResult {
  // A) 脚本通道: 服务端 env token(源码无此值; 未配置则关闭)
  const envToken = process.env.LIONS_CONSOLE_OPERATOR_TOKEN || "";
  const presented = req.headers.get("x-console-operator-token") || "";
  if (envToken && presented && safeEqual(presented, envToken)) {
    return { ok: true, actor: "operator:token" };
  }

  // B) 浏览器通道: 同源 + 双提交 nonce
  if (!isSameOrigin(req)) {
    return { ok: false, status: 403, error: "FORBIDDEN_ORIGIN", detail: "仅接受 console 同源请求(或服务端 operator token)" };
  }
  const headerNonce = req.headers.get("x-console-csrf") || "";
  const cookieNonce = readCookie(req, CSRF_COOKIE);
  if (!headerNonce || !cookieNonce || !safeEqual(headerNonce, cookieNonce) || !isIssuedNonce(headerNonce)) {
    return { ok: false, status: 403, error: "FORBIDDEN_CSRF", detail: "缺少/无效的 console CSRF nonce(请先 GET /api/knowledge-dedupe/csrf)" };
  }
  return { ok: true, actor: "operator:console" };
}
