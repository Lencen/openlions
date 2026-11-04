import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * 资源级 RBAC API (2026-09-21, Q6#5)
 *
 * GET /api/v1/rbac?agent=<agent_id>  — 规则列表 + 该 agent 解析结果(org 角色继承 + 直接授权)
 * POST /api/v1/rbac                 — 授权/撤销 {kind: grant|revoke, subjectType, subjectId, resourceType, resourceKey, permission}
 */
async function roleIdsOf(agentId: string): Promise<string[]> {
  // agent 的组织角色: OrgAssignment -> OrgPosition -> OrgRole
  const asg = await prisma.orgAssignment.findMany({ where: { agentId, status: "ACTIVE" }, select: { positionId: true } });
  const positions = await prisma.orgPosition.findMany({ where: { id: { in: asg.map((a) => a.positionId) }, status: "ACTIVE" }, select: { roleId: true } });
  return Array.from(new Set(positions.map((p) => p.roleId)));
}

export async function GET(req: NextRequest) {
  try {
    const agent = req.nextUrl.searchParams.get("agent") || "";
    const rules = await prisma.resourcePermission.findMany({ orderBy: [{ subjectType: "asc" }, { createdAt: "asc" }] });
    let resolved: any[] = [];
    if (agent) {
      const roleIds = await roleIdsOf(agent);
      const relevant = rules.filter((r) => (r.subjectType === "agent" && r.subjectId === agent) || (r.subjectType === "role" && roleIds.includes(r.subjectId)));
      // 权限聚合: deny 优先; 否则任一 allow 即允许
      const agg = new Map(); // resourceType|resourceKey -> Set(permission) + effect
      for (const r of relevant) {
        const k = r.resourceType + "|" + r.resourceKey;
        const e = agg.get(k) || { permissions: new Set(), denied: new Set() };
        if (r.effect === "deny") e.denied.add(r.permission); else e.permissions.add(r.permission);
        agg.set(k, e);
      }
      resolved = Array.from(agg.entries()).map(([k, e]) => {
        const [resourceType, resourceKey] = k.split("|");
        return { resourceType, resourceKey, allowed: Array.from(e.permissions), denied: Array.from(e.denied),
          viaRoles: roleIds };
      });
    }
    return NextResponse.json({ ok: true, rules: rules.map((r) => ({ ...r, createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime() })), resolved, agent });
  } catch (e: any) { return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const { kind, subjectType, subjectId, resourceType, resourceKey, permission } = b;
    if (kind === "grant") {
      await prisma.resourcePermission.upsert({
        where: { subjectType_subjectId_resourceType_resourceKey_permission: { subjectType, subjectId, resourceType, resourceKey, permission } },
        create: { subjectType, subjectId, resourceType, resourceKey, permission, effect: b.effect || "allow" },
        update: { effect: b.effect || "allow" },
      });
    } else if (kind === "revoke") {
      await prisma.resourcePermission.deleteMany({ where: { subjectType, subjectId, resourceType, resourceKey, permission } });
    } else {
      return NextResponse.json({ ok: false, error: "kind 必须 grant|revoke" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) { return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 }); }
}