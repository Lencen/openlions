import { NextResponse } from "next/server";
import { asOf, openMind, q, safeClose } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/knowledge-candidates?limit=20&status=ALL|PENDING_REVIEW|VERIFIED|REJECTED
// 代理 mind: GET /api/v1/flywheel/knowledge-candidates —— agent 结论候选 (三态 pending/verified/rejected)
// 容错: 上游不可达时用 mind 库 (Knowledge sourceType='AGENT_OUTPUT') 本地只读兜底, 绝不 500。
const STATUSES = ["PENDING_REVIEW", "VERIFIED", "REJECTED", "ALL"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);
  const statusRaw = url.searchParams.get("status") || "ALL";
  const status = STATUSES.includes(statusRaw) ? statusRaw : "ALL";
  const warnings: string[] = [];

  let upstream: any = null;
  try {
    // 2026-10-13 round 76-DD: 转发顶栏时间范围(③)
    const range = url.searchParams.get("range");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(
      "http://localhost:3000/api/v1/flywheel/knowledge-candidates?limit=" + limit + "&status=" + encodeURIComponent(status) + (range ? "&range=" + encodeURIComponent(range) : ""),
      { cache: "no-store", signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (res.ok) upstream = await res.json();
    else warnings.push("mind /api/v1/flywheel/knowledge-candidates 返回 " + res.status);
  } catch {
    warnings.push("mind 服务 (3000) 不可达: 候选区降级为本地只读查询");
  }

  let rows: any[] = Array.isArray(upstream?.rows) ? upstream.rows : [];
  let counts = { pending: 0, verified: 0, rejected: 0 };

  if (upstream) {
    counts = { pending: Number(upstream.pending || 0), verified: Number(upstream.verified || 0), rejected: Number(upstream.rejected || 0) };
  } else {
    const mind = openMind();
    const cond = status === "ALL" ? "" : status === "REJECTED" ? " AND (verification='REJECTED' OR stale=1)" : " AND verification='" + status + "'";
    rows = await q(
      mind,
      "SELECT id, title, substr(content,1,4000) content, qualityScore, confidence, verification, humanConfirmed, agentSource, theme, sourceId, stale, staleReason, createdAt " +
        "FROM Knowledge WHERE sourceType='AGENT_OUTPUT'" + cond + " ORDER BY createdAt DESC LIMIT ?",
      limit
    );
    counts = {
      pending: Number((q(mind, "SELECT COUNT(*) c FROM Knowledge WHERE sourceType='AGENT_OUTPUT' AND verification='PENDING_REVIEW' AND stale=0"))[0]?.c || 0),
      verified: Number((q(mind, "SELECT COUNT(*) c FROM Knowledge WHERE sourceType='AGENT_OUTPUT' AND verification='VERIFIED'"))[0]?.c || 0),
      rejected: Number((q(mind, "SELECT COUNT(*) c FROM Knowledge WHERE sourceType='AGENT_OUTPUT' AND stale=1"))[0]?.c || 0),
    };
    safeClose(mind);
  }

  return NextResponse.json({
    asOf: asOf(),
    ok: upstream ? !!upstream.ok : false,
    source: upstream ? "mind /api/v1/flywheel/knowledge-candidates" : "local-readonly-fallback",
    status,
    limit,
    pending: counts.pending,
    verified: counts.verified,
    rejected: counts.rejected,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      qualityScore: r.qualityScore,
      confidence: r.confidence,
      verification: r.verification,
      humanConfirmed: r.humanConfirmed,
      agentSource: r.agentSource,
      theme: r.theme,
      sourceId: r.sourceId,
      stale: r.stale,
      staleReason: r.staleReason,
      createdAt: r.createdAt,
    })),
    warnings,
  });
}
