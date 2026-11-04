import { createHash } from "crypto";

/**
 * 技能双名称（2026-10-26）
 * - businessName：给人看的业务名（沿用写入时的 name，去掉首尾空白）
 * - technicalName：给查询/引用用的技术名（Unicode 词字符保留、其余转连字符、ASCII 小写；
 *   没有可用字符时回退 sk-<md5前8位>）
 *
 * 例： "Next.js tRPC 调试" -> "next-js-trpc-调试"
 *      "修复并验收心跳冻结巡检" -> "修复并验收心跳冻结巡检"
 *
 * 唯一性不在本函数保证：库上有两条部分唯一索引
 *   Skill_technicalName_public_uniq  (technicalName) WHERE ownerAgentId IS NULL
 *   Skill_owner_technicalName_uniq   (ownerAgentId, technicalName) WHERE ownerAgentId IS NOT NULL
 * 撞名时由调用方的 dedupe/retire 逻辑处理（与 name 撞名同一条路径）。
 */
export function makeTechnicalName(businessName: string): string {
  const raw = String(businessName || "").trim();
  const slug = raw
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (slug.length >= 2) return slug.slice(0, 120);
  return "sk-" + createHash("md5").update(raw).digest("hex").slice(0, 8);
}

export function skillNameFields(businessName: string): { businessName: string; technicalName: string } {
  const b = String(businessName || "").trim();
  return { businessName: b, technicalName: makeTechnicalName(b) };
}

/**
 * 按名称找**公共**技能（ownerAgentId IS NULL）的 id：先 technicalName，再退回 legacy name。
 * 为什么先技术名：它是新的查询键（公共桶有部分唯一索引，结果确定）；name 仍全局唯一，退回分支同样确定，
 *   不会出现 Prisma findUnique 在非唯一列上"随便返回一条"的情况。
 */
export async function findPublicSkillId(client: any, businessName: string): Promise<string | null> {
  const { technicalName } = skillNameFields(businessName);
  const byTech = await client.skill.findFirst({ where: { technicalName, ownerAgentId: null }, select: { id: true } });
  if (byTech && byTech.id) return String(byTech.id);
  const byName = await client.skill.findFirst({
    where: { name: String(businessName || "").trim(), ownerAgentId: null },
    select: { id: true },
  });
  return byName && byName.id ? String(byName.id) : null;
}

function isUniqueViolation(e: any): boolean {
  if (!e) return false;
  if (e.code === "P2002") return true;
  const msg = String(e.meta?.target || e.message || "");
  return /Unique constraint|duplicate key/i.test(msg);
}

/**
 * 公共技能的"有则更新、无则创建"（替代 upsert by name）。
 * 为什么不用 prisma.upsert：upsert 必须给**唯一键**，而 technicalName 的唯一性是部分唯一索引（Prisma 不能声明）。
 * 并发：先按技术名查；若两步之间被并发插入，create 会撞唯一索引（P2002）→ 重新查一次再更新，与旧的撞名重试语义一致。
 * 回滚：纯代码路径，无 DDL/无数据迁移；回滚=git revert（或调用点改回 prisma.skill.upsert）。
 */
export async function upsertPublicSkill(
  client: any,
  businessName: string,
  updateData: Record<string, any>,
  createData: Record<string, any>
): Promise<any> {
  const existingId = await findPublicSkillId(client, businessName);
  if (existingId) {
    try {
      return await client.skill.update({ where: { id: existingId }, data: updateData });
    } catch (e) {
      if ((e as any)?.code !== "P2025") throw e; // 行在被删了 -> 落到 create
    }
  }
  try {
    return await client.skill.create({ data: createData });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const id = await findPublicSkillId(client, businessName);
      if (id) return client.skill.update({ where: { id }, data: updateData });
    }
    throw e;
  }
}
