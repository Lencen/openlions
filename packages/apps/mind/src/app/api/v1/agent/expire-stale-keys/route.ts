import { NextRequest, NextResponse } from "next/server";
// 2026-10-15 钥匙治理(item 2/3): 到期收口的**手动/定时入口**。
import { expireStaleKeys } from "@/server/lib/key-governance";

/**
 * POST /api/v1/agent/expire-stale-keys — 到期收口(唯一实现 = lib/key-governance.expireStaleKeys)
 *
 * 做三件事(全部幂等, 可重复调用):
 *   ① 业务钥匙 ACTIVE 且 expires_at <= now  -> status='EXPIRED'
 *      (此前的平台代码**从不写** EXPIRED: 过期钥匙在库里永远停在 ACTIVE, 只有鉴权时按 expires_at 拒绝);
 *   ② 明文缓存过 1 小时窗口 -> api_key_plain=NULL + idempotent_until=NULL(物理清空明文钥匙库);
 *      `include_legacy_plain=true` 时**连存量行**(idempotent_until IS NULL 的 2026-10-15 前老行)一起清 ——
 *      默认 false: 自动路径不批量动存量行, 存量清理由人类按交付报告里的一次性步骤显式执行;
 *   ③ 未换取的领取券过 TTL -> profile.claimTicket.status='EXPIRED'(带整串 CAS)。
 *
 * 鉴权: header `x-admin-key` 必须等于 `MIND_ADMIN_API_KEY`(与 mind 其它管理端点同口径)。
 *
 * body(可空): { include_legacy_plain?: boolean }
 * 返:        { ok:true, expired_keys, cleared_plaintext, expired_tickets }
 *
 * 建议(部署步骤里给出, 本轮**未**改 systemd/crontab): 由 5 分钟级 timer 调本端点,
 *   curl -s -X POST http://127.0.0.1:3000/api/v1/agent/expire-stale-keys -H "x-admin-key: $MIND_ADMIN_API_KEY"
 *
 * ⚠️ 2026-11-13 更正（[team] 实测，[team] / github-maintenance-line 踩过）：
 *   $MIND_ADMIN_API_KEY 的**唯一事实源是运行进程的 env（unit 的 Environment=/drop-in）**，
 *   **不是**发布树里的 packages/apps/mind/.env —— 两者实测不同源（进程 43 字符 vs .env 57 字符），
 *   按 .env 取值会 **401**。脚本/自动化请用：
 *     systemctl --user show lions-mind -p Environment --value   （取其中的 MIND_ADMIN_API_KEY）
 *     或从 /proc/<MainPID>/environ 读取（tr '\0' '\n' 后 grep MIND_ADMIN_API_KEY）
 *   对齐 .env 与运行值属部署侧动作（本线不改生产配置）。
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "MIND_ADMIN_API_KEY not configured on server" }, { status: 500 });
  }
  const got = req.headers.get("x-admin-key") || req.headers.get("X-Admin-Key") || "";
  if (got !== expected) {
    return NextResponse.json({ ok: false, error: "invalid or missing x-admin-key (admin only)" }, { status: 401 });
  }
  try {
    let body: any = null;
    try { body = JSON.parse(await req.text()); } catch { body = null; }
    const includeLegacy = body && body.include_legacy_plain === true;
    const r = await expireStaleKeys({ includeLegacyPlain: includeLegacy, actor: "console-admin", actorType: "admin_key" });
    return NextResponse.json({ ok: true, ...r, include_legacy_plain: includeLegacy });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
