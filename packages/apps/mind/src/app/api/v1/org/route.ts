import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * LIONS 组织架构 API (2026-09-21 重做, 用户规格: 部门树 + 小组 tab)
 *
 * GET  /api/v1/org  — 部门树(含成员计数) + 小组(含条件/成员) + agents(含条件属性) + 平台设置
 * POST /api/v1/org  — kind: department|deptMember|group|groupMember|setting|role|position|assign|report
 */
async function agentAttrs() {
  const ags = await prisma.agentRegistry.findMany({ where: { status: "ACTIVE" }, select: { agent_id: true, display_name: true, channel: true, host: true, profile: true, last_seen_at: true } });
  const assigns = await prisma.orgAssignment.findMany({ where: { status: "ACTIVE" }, select: { agentId: true, positionId: true } });
  const positions = await prisma.orgPosition.findMany({ select: { id: true, name: true, roleId: true } });
  const posBy = new Map(positions.map((p) => [p.id, p]));
  const roles = await prisma.orgRole.findMany({ select: { id: true, name: true } });
  const roleBy = new Map(roles.map((r) => [r.id, r]));
  return ags.map((a) => {
    let prof: any = {};
    try { prof = JSON.parse(String(a.profile || "{}")); } catch {}
    const asg = assigns.find((x) => x.agentId === a.agent_id);
    const pos = asg ? posBy.get(asg.positionId) : null;
    return { agent_id: a.agent_id, display_name: a.display_name, channel: a.channel, host: a.host,
      ip: prof.ip || prof.host_ip || null, model: prof.model || null,
      position: pos ? pos.name : null, role: pos ? (roleBy.get(pos.roleId)?.name || null) : null,
      last_seen_at: a.last_seen_at ? a.last_seen_at.getTime() : null };
  });
}

async function readOrg() {
  const [depts, members, groups, groupMembers, settings] = await Promise.all([
    prisma.orgDepartment.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.agentDeptMember.findMany(),
    prisma.agentGroup.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.agentGroupMember.findMany(),
    prisma.platformSetting.findMany(),
  ]);
  const memByDept = new Map();
  for (const m of members) { if (!memByDept.has(m.departmentId)) memByDept.set(m.departmentId, []); memByDept.get(m.departmentId).push(m.agentId); }
  const deptTree = (parentId: string | null): any[] => depts.filter((d) => (d.parentId || null) === parentId).map((d) => ({
    id: d.id, name: d.name, desc: d.desc, parentId: d.parentId,
    agentCount: (memByDept.get(d.id) || []).length, agents: memByDept.get(d.id) || [],
    children: deptTree(d.id),
  }));
  const settingMap: Record<string, string> = {};
  for (const s of settings) settingMap[s.key] = s.value;
  return {
    departments: deptTree(null),
    groups: groups.map((g) => {
      let meta: any = {};
      try { meta = g.purpose ? JSON.parse(g.purpose) : {}; } catch { meta = { note: g.purpose }; }
      return { id: g.id, name: g.name, desc: g.purpose || null, conditions: meta.conditions || null, manual: !!meta.manual,
        ownerAgentId: g.ownerAgentId, status: g.status,
        members: groupMembers.filter((m) => m.groupId === g.id).map((m) => ({ agentId: m.agentId, roleInGroup: m.roleInGroup })) };
    }),
    agents: await agentAttrs(),
    settings: settingMap,
    platformName: settingMap["platform.name"] || "lions",
  };
}

export async function GET() {
  try { return NextResponse.json({ ok: true, ...(await readOrg()) }); }
  catch (e: any) { return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const kind = String(b.kind || "");
    const out: any = {};
    if (kind === "department") {
      out.department = await prisma.orgDepartment.create({ data: { name: String(b.name), parentId: b.parentId ? String(b.parentId) : null, desc: b.desc ? String(b.desc) : null } });
    } else if (kind === "deleteDepartment") {
      // 级联删除该部门及其全部子部门(ON DELETE CASCADE 处理成员)
      const id = String(b.id);
      const ids = [id];
      let frontier = [id];
      while (frontier.length) {
        const kids = await prisma.orgDepartment.findMany({ where: { parentId: { in: frontier } }, select: { id: true } });
        frontier = kids.map((k) => k.id); ids.push(...frontier);
      }
      out.removed = await prisma.orgDepartment.deleteMany({ where: { id: { in: ids } } });
    } else if (kind === "deptMember") {
      out.member = await prisma.agentDeptMember.upsert({
        where: { agentId_departmentId: { agentId: String(b.agentId), departmentId: String(b.departmentId) } },
        create: { agentId: String(b.agentId), departmentId: String(b.departmentId) },
        update: {},
      });
    } else if (kind === "deptMemberRemove") {
      out.removed = await prisma.agentDeptMember.deleteMany({ where: { agentId: String(b.agentId), departmentId: String(b.departmentId) } });
    } else if (kind === "group") {
      // purpose 存 JSON: { note, conditions, manual }
      const meta = JSON.stringify({ note: b.desc || null, conditions: b.conditions || null, manual: !!b.manual });
      out.group = await prisma.agentGroup.create({ data: { name: String(b.name), purpose: meta, ownerAgentId: b.ownerAgentId ? String(b.ownerAgentId) : null } });
    } else if (kind === "groupMember") {
      out.member = await prisma.agentGroupMember.upsert({
        where: { groupId_agentId: { groupId: String(b.groupId), agentId: String(b.agentId) } },
        create: { groupId: String(b.groupId), agentId: String(b.agentId), roleInGroup: String(b.roleInGroup || "member") },
        update: { roleInGroup: String(b.roleInGroup || "member") },
      });
    } else if (kind === "setting") {
      out.setting = await prisma.platformSetting.upsert({ where: { key: String(b.key) }, create: { key: String(b.key), value: String(b.value) }, update: { value: String(b.value) } });
    } else if (kind === "role") {
      out.role = await prisma.orgRole.create({ data: { name: String(b.name), desc: b.desc ? String(b.desc) : null, level: Number(b.level || 0) } });
    } else if (kind === "position") {
      out.position = await prisma.orgPosition.create({ data: { name: String(b.name), roleId: String(b.roleId), parentId: b.parentId ? String(b.parentId) : null, desc: b.desc ? String(b.desc) : null } });
    } else if (kind === "assign") {
      const agentId = String(b.agentId); const positionId = String(b.positionId);
      if (b.isPrimary) await prisma.orgAssignment.updateMany({ where: { agentId, isPrimary: true }, data: { isPrimary: false } });
      out.assignment = await prisma.orgAssignment.upsert({ where: { agentId_positionId: { agentId, positionId } }, create: { agentId, positionId, isPrimary: !!b.isPrimary }, update: { isPrimary: !!b.isPrimary, status: "ACTIVE" } });
    } else if (kind === "report") {
      out.report = await prisma.orgReport.upsert({ where: { managerAgentId_reportAgentId: { managerAgentId: String(b.managerAgentId), reportAgentId: String(b.reportAgentId) } }, create: { managerAgentId: String(b.managerAgentId), reportAgentId: String(b.reportAgentId) }, update: {} });
    } else {
      return NextResponse.json({ ok: false, error: "未知 kind: " + kind }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...out });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}