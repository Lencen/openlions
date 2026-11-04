import { openMindDb } from "@/server/lib/open-mind-db";
import { NextRequest, NextResponse } from "next/server";
import path from "path";

/**
 * /api/v1/knowledge/norms — 规范类知识列表 (2026-09-22, 知识库整理步骤4)
 *
 * 背景(operator 2026-09-22): 8 维审视等方法论"存了但不会主动到 agent 手上"——
 *   规范知识(domain=platform + 规范关键词)需要独立列表入口, agent 可一次性拉到
 *   "平台要求我怎么做"的轻量索引, 而不是靠内容检索碰运气。
 *
 * GET /api/v1/knowledge/norms?domain=platform&limit=50
 *   返回 domain=platform 且标题/内容命中规范关键词的条目(id/title/一句话描述)。
 *   规范关键词与 scripts/knowledge-domain-backfill.cjs 的 NORM_RE 一致
 *   (审视|纪律|必须|约定|守门|结单|提交规范|规范|红线|不得|禁止)。
 *
 * 用途: agent 落地任务前调一次拿规范索引(轻量), 需要全文再取单条;
 *       不参与每轮上下文注入(呼应 uos20 P0 减注入)。
 */
export const dynamic = "force-dynamic";

const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");
// 规范关键词(与 knowledge-domain-backfill.cjs NORM_RE 同口径)
const NORM_RE = /(审视|纪律|必须|约定|守门|结单|提交规范|规范|红线|不得|禁止)/;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const domain = sp.get("domain") || "platform";
    const limit = Math.min(parseInt(sp.get("limit") || "50", 10) || 50, 200);

    const db = openMindDb({ role: "readonly", dbPath: DB_PATH, caller: "route" });

    // 取 domain 命中 + 非 stale 的行, 在 JS 侧按规范关键词过滤(避免 SQL 正则方言差异)
    const rows: any[] = db.prepare(
      "SELECT id, title, content, tags, category FROM Knowledge WHERE domain = ? AND COALESCE(stale, 0) = 0 ORDER BY COALESCE(confidence, 0) DESC, createdAt DESC LIMIT ?"
    ).all(domain, Math.min(limit * 8, 500));
    db.close();
    const norms = (rows || []).filter((r: any) => NORM_RE.test(String(r.title || "") + " " + String(r.content || "")))
      .map((r: any) => ({
        id: r.id,
        title: String(r.title || "").slice(0, 120),
        summary: String(r.content || "").replace(/\s+/g, " ").slice(0, 160),
        category: r.category ?? null,
        tags: r.tags ?? null,
      }))
      .slice(0, limit);
    return NextResponse.json({ ok: true, count: norms.length, domain, norms });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
