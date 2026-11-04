/**
 * GET /api/v1/flywheel/structured — 查询某 theme 的 FLYWHEEL_STRUCTURED 记忆列表
 * V1.7 §4.1 API
 *
 * Query params:
 *   ?theme=任务调度 (必填)
 *   ?limit=20 (默认 20, 最大 100)
 *   ?offset=0 (默认 0)
 */
import { queryStructuredMemories } from "@/server/pipeline/structured-memory-store";
// 2026-10-23 R2-c: 结构化记忆里含 title/content，必须按归属过滤
import { readableWhere } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const theme = url.searchParams.get("theme");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const who = await resolveRequestActor(req as any);
  if (!who.ok) return Response.json({ error: who.error }, { status: who.status });
  const scope = readableWhere(who.actor, { kind: "memory" });

  try {
    if (theme) {
      const { items, total } = await queryStructuredMemories(theme, { limit, offset, scope });
      return Response.json({ theme, items, total, limit, offset });
    } else {
      // 无 theme: 返回全部 FLYWHEEL_STRUCTURED Memory
      const { prisma } = await import("@/lib/prisma");
      const [items, total] = await Promise.all([
        prisma.memory.findMany({
          where: { sourceType: "FLYWHEEL_STRUCTURED", ...(Object.keys(scope).length ? { AND: [scope] } : {}) },
          orderBy: { createdAt: "desc" },
          take: limit, skip: offset,
          select: { id: true, title: true, content: true, theme: true, createdAt: true },
        }),
        prisma.memory.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", ...(Object.keys(scope).length ? { AND: [scope] } : {}) } }),
      ]);
      return Response.json({ items, total, limit, offset });
    }
  } catch (e: any) {
    console.error(`[structured-query:V1.7] theme="${theme}" err: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
