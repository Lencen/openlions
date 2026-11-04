// GET /api/knowledge-governance — 知识治理概览 (2026-09-23 由 portal 迁入 console)
//   口径逐字沿用原 portal /api/portal/knowledge/governance, 仅换执行宿主(console 内部管理台)。
//   返回: { ok, total, byDomain, byCategory, quality{high,mid,low}, oneLiners,
//          noMeta, needsBackfill, superseded, tagsVocabHit }
import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { openMind, q, scalar } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

const REPO = process.env.LIONS_REPO || "" + (process.env.LIONS_HOME || process.cwd()) + "";

// 受控词表命中率(抽样 200 行); 与 scripts/knowledge-tags-vocab.json 对齐
function loadVocab(): Set<string> {
  const paths = [
    path.join(REPO, "scripts/knowledge-tags-vocab.json"),
    path.join(process.cwd(), "..", "..", "scripts/knowledge-tags-vocab.json"),
  ];
  for (const p of paths) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      return new Set(
        ([] as string[])
          .concat(v.products || [], v.technologies || [], v.channels || [], v.business || [])
          .map((x) => String(x).toLowerCase())
      );
    } catch {
      /* try next */
    }
  }
  return new Set();
}

export async function GET() {
  const db = openMind();
  if (!db) {
    return NextResponse.json({ ok: false, error: "mind db unavailable" }, { status: 503 });
  }
  try {
    const total = await scalar(db, "SELECT COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0");
    const byDomain = await q(
      db,
      "SELECT COALESCE(domain,'(null)') d, COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 GROUP BY domain ORDER BY c DESC"
    );
    const byCategory = await q(
      db,
      "SELECT COALESCE(NULLIF(category,''),'(null)') d, COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 GROUP BY category ORDER BY c DESC LIMIT 20"
    );
    // 2026-10-21 前端修复：这三行原来没有 await，对象里存的是 Promise → JSON 变 {} → 页面显示"—"。
    const [qHigh, qMid, qLow] = await Promise.all([
      scalar(db, "SELECT COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 AND qualityScore >= 0.7"),
      scalar(db, "SELECT COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 AND qualityScore >= 0.4 AND qualityScore < 0.7"),
      scalar(db, "SELECT COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 AND qualityScore < 0.4"),
    ]);
    const quality = { high: qHigh, mid: qMid, low: qLow };
    const oneLiners = await scalar(db, "SELECT COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 AND LENGTH(COALESCE(content,'')) < 80");
    const noMeta = await scalar(
      db,
      "SELECT COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 AND (domain IS NULL OR domain='') AND (tags IS NULL OR tags='') AND (category IS NULL OR category='')"
    );
    const needsBackfill = await scalar(
      db,
      "SELECT COUNT(*) c FROM Knowledge WHERE COALESCE(stale,0)=0 AND (domain IS NULL OR domain='') AND (tags IS NULL OR tags='')"
    );
    const superseded = await scalar(db, "SELECT COUNT(*) c FROM Knowledge WHERE supersededBy IS NOT NULL AND supersededBy != ''");

    let tagHits = 0;
    let tagTotal = 0;
    const vocab = loadVocab();
    if (vocab.size > 0) {
      const sample = await q(db, "SELECT tags FROM Knowledge WHERE tags IS NOT NULL AND tags != '' ORDER BY RANDOM() LIMIT 200");
      for (const r of sample) {
        for (const t of String(r.tags || "").split(",")) {
          const k = t.trim().toLowerCase();
          if (!k) continue;
          tagTotal++;
          if (vocab.has(k)) tagHits++;
        }
      }
    }
    const tagsVocabHit = tagTotal ? Math.round((100 * tagHits) / tagTotal) : 0;

    return NextResponse.json({
      ok: true,
      asOf: new Date().toISOString(),
      total,
      byDomain: Object.fromEntries(byDomain.map((r: any) => [r.d, r.c])),
      byCategory: Object.fromEntries(byCategory.map((r: any) => [r.d, r.c])),
      quality,
      oneLiners,
      noMeta,
      needsBackfill,
      superseded,
      tagsVocabHit,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  } finally {
    // 连接池由 lions-db 管理，不手动 close
  }
}
