import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
// 2026-10-09 实践遗留落地: 关系抽取改为确定性纯函数(去掉 Math.random()>0.7 造 RELATED_TO)
import { extractEntities, extractRelations } from "./knowledge-graph-extract";

export const knowledgeGraphRouter = createRouter({
  // 获取实体列表
  listEntities: publicProcedure.input(z.object({
    type: z.string().optional(),
    search: z.string().optional(),
    page: z.number().default(1),
    pageSize: z.number().default(50),
  })).query(async ({ input }) => {
    const offset = (input.page - 1) * input.pageSize;
    const conditions: string[] = [];
    const params: any[] = [];

    if (input.type) {
      conditions.push("type = ?");
      params.push(input.type);
    }
    if (input.search) {
      conditions.push("name LIKE ?");
      params.push(`%${input.search}%`);
    }

    const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    // v3 fix: Prisma 的 $queryRaw 模板字符串不支持 ${whereClause} 这种内插变量
    // (变量里的 ? 占位符会被 Prisma 当成 Prisma.sql 模板的 ? 引用, 报语法错)
    // 改用 $queryRawUnsafe 拼接, 条件走 params 参数化
    const items = await prisma.$queryRawUnsafe<Array<{
      id: string; name: string; type: string; description: string | null;
      aliases: string | null; memoryCount: number; createdAt: Date;
    }>>(
      `SELECT * FROM "KnowledgeEntity" ${whereClause} ORDER BY memoryCount DESC LIMIT ? OFFSET ?`,
      ...params, input.pageSize, offset
    );

    const countResult = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*) as count FROM "KnowledgeEntity" ${whereClause}`,
      ...params
    );
    const total = Number(countResult[0]?.count || 0);

    return { items, total, page: input.page, pageSize: input.pageSize };
  }),

  // 获取关系列表
  listRelations: publicProcedure.input(z.object({
    sourceId: z.string().optional(),
    targetId: z.string().optional(),
    relationType: z.string().optional(),
    page: z.number().default(1),
    pageSize: z.number().default(50),
  })).query(async ({ input }) => {
    const offset = (input.page - 1) * input.pageSize;
    const conditions: string[] = [];
    const params: string[] = [];
    
    if (input.sourceId) { conditions.push("sourceId = ?"); params.push(input.sourceId); }
    if (input.targetId) { conditions.push("targetId = ?"); params.push(input.targetId); }
    if (input.relationType) { conditions.push("relationType = ?"); params.push(input.relationType); }
    
    const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
    
    const items = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT r.*, s.name as sourceName, s.type as sourceType, t.name as targetName, t.type as targetType
       FROM "KnowledgeRelation" r
       JOIN "KnowledgeEntity" s ON r.sourceId = s.id
       JOIN "KnowledgeEntity" t ON r.targetId = t.id
       ${whereClause}
       ORDER BY r.weight DESC
       LIMIT ? OFFSET ?`,
      ...params, input.pageSize, offset
    );

    const countResult = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*) as count FROM "KnowledgeRelation" ${whereClause}`,
      ...params
    );

    return { items, total: Number(countResult[0]?.count || 0), page: input.page, pageSize: input.pageSize };
  }),

  // 获取实体的关联关系
  getEntityRelations: publicProcedure.input(z.object({
    entityId: z.string(),
    depth: z.number().default(1),
  })).query(async ({ input }) => {
    const entityResults = await prisma.$queryRaw<Array<{
      id: string; name: string; type: string; description: string | null;
      aliases: string | null; memoryCount: number;
    }>>`SELECT * FROM "KnowledgeEntity" WHERE id = ${input.entityId}`;
    
    if (!entityResults.length) throw new Error("Entity not found");
    const entity = entityResults[0];
    
    const relations = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT r.*, s.name as sourceName, s.type as sourceType, t.name as targetName, t.type as targetType
      FROM "KnowledgeRelation" r
      JOIN "KnowledgeEntity" s ON r.sourceId = s.id
      JOIN "KnowledgeEntity" t ON r.targetId = t.id
      WHERE r.sourceId = ${input.entityId} OR r.targetId = ${input.entityId}
    `;
    
    return { entity, relations };
  }),

  // 从文本自动构建实体和关系
  buildFromText: publicProcedure.input(z.object({
    text: z.string(),
    sourceMemoryId: z.string().optional(),
    sourceKnowledgeId: z.string().optional(),
  })).mutation(async ({ input }) => {
    const entities = extractEntities(input.text);
    const relations = extractRelations(input.text, entities);
    
    let entitiesCreated = 0;
    let relationsCreated = 0;
    
    // 创建或获取实体
    for (const entity of entities) {
      const existing = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "KnowledgeEntity" WHERE name = ${entity.name}`;
      
      if (existing.length > 0) {
        await prisma.$executeRaw`UPDATE "KnowledgeEntity" SET memoryCount = memoryCount + 1 WHERE id = ${existing[0].id}`;
      } else {
        const id = `kg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await prisma.$executeRaw`INSERT INTO "KnowledgeEntity" (id, name, type, memoryCount) VALUES (${id}, ${entity.name}, ${entity.type}, 1)`;
        entitiesCreated++;
      }
    }
    
    // 创建关系
    for (const rel of relations) {
      const source = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "KnowledgeEntity" WHERE name = ${rel.source}`;
      const target = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "KnowledgeEntity" WHERE name = ${rel.target}`;
      
      if (source.length > 0 && target.length > 0) {
        const existing = await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "KnowledgeRelation" 
          WHERE sourceId = ${source[0].id} AND targetId = ${target[0].id} AND relationType = ${rel.type}
        `;
        
        if (existing.length === 0) {
          const id = `kr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await prisma.$executeRaw`INSERT INTO "KnowledgeRelation" (id, sourceId, targetId, relationType, weight) VALUES (${id}, ${source[0].id}, ${target[0].id}, ${rel.type}, 0.5)`;
          relationsCreated++;
        }
      }
    }
    
    return { entitiesCreated, relationsCreated, totalEntities: entities.length, totalRelations: relations.length };
  }),

  // 手动创建实体
  createEntity: publicProcedure.input(z.object({
    name: z.string(),
    type: z.enum(["CONCEPT", "CODE", "PERSON", "PROJECT", "TOOL", "DOMAIN"]),
    description: z.string().optional(),
    aliases: z.string().optional(),
  })).mutation(async ({ input }) => {
    const existing = await prisma.$queryRaw<Array<{ id: string; name: string; type: string }>>`SELECT id, name, type FROM "KnowledgeEntity" WHERE name = ${input.name}`;
    if (existing.length > 0) return existing[0];
    
    const id = `ke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.$executeRaw`INSERT INTO "KnowledgeEntity" (id, name, type, description, aliases) VALUES (${id}, ${input.name}, ${input.type}, ${input.description || null}, ${input.aliases || null})`;
    
    return { id, name: input.name, type: input.type, description: input.description || null, aliases: input.aliases || null, memoryCount: 0 };
  }),

  // 手动创建关系
  createRelation: publicProcedure.input(z.object({
    sourceId: z.string(),
    targetId: z.string(),
    relationType: z.enum(["IS_A", "PART_OF", "USES", "DEPENDS_ON", "SIMILAR_TO", "RELATED_TO"]),
    weight: z.number().min(0).max(1).optional(),
  })).mutation(async ({ input }) => {
    const existing = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "KnowledgeRelation" 
      WHERE sourceId = ${input.sourceId} AND targetId = ${input.targetId} AND relationType = ${input.relationType}
    `;
    if (existing.length > 0) return existing[0];
    
    const id = `kr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.$executeRaw`INSERT INTO "KnowledgeRelation" (id, sourceId, targetId, relationType, weight) VALUES (${id}, ${input.sourceId}, ${input.targetId}, ${input.relationType}, ${input.weight ?? 0.5})`;
    
    return { id, sourceId: input.sourceId, targetId: input.targetId, relationType: input.relationType, weight: input.weight ?? 0.5 };
  }),

  // 获取图谱统计
  getStats: publicProcedure.query(async () => {
    const entityCountResult = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*) + 0 as count FROM "KnowledgeEntity"`;
    const relationCountResult = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*) + 0 as count FROM "KnowledgeRelation"`;
    const typeDistribution = await prisma.$queryRaw<Array<{ type: string; count: number }>>`SELECT type, COUNT(*) + 0 as count FROM "KnowledgeEntity" GROUP BY type`;
    
    return {
      entityCount: Number(entityCountResult[0]?.count || 0),
      relationCount: Number(relationCountResult[0]?.count || 0),
      typeDistribution: typeDistribution.map(t => ({ type: t.type, count: Number(t.count) })),
    };
  }),

  // 获取图谱可视化数据
  getGraphData: publicProcedure.input(z.object({
    limit: z.number().default(100),
  })).query(async ({ input }) => {
    const relations = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT r.sourceId, r.targetId, r.relationType, r.weight,
             s.name as sourceName, s.type as sourceType,
             t.name as targetName, t.type as targetType
      FROM "KnowledgeRelation" r
      JOIN "KnowledgeEntity" s ON r.sourceId = s.id
      JOIN "KnowledgeEntity" t ON r.targetId = t.id
      WHERE r.weight > 0.3
      ORDER BY r.weight DESC
      LIMIT ${input.limit}
    `;
    
    // 收集所有涉及的实体ID
    const entityIds: string[] = [];
    const seenIds = new Set<string>();
    relations.forEach((r: Record<string, unknown>) => {
      const src = r.sourceId as string;
      const tgt = r.targetId as string;
      if (!seenIds.has(src)) { entityIds.push(src); seenIds.add(src); }
      if (!seenIds.has(tgt)) { entityIds.push(tgt); seenIds.add(tgt); }
    });
    
    // 批量获取实体
    const entities: Array<{ id: string; name: string; type: string; memoryCount: number }> = [];
    for (const eid of entityIds) {
      const rows = await prisma.$queryRaw<Array<{ id: string; name: string; type: string; memoryCount: number }>>`
        SELECT id, name, type, memoryCount FROM "KnowledgeEntity" WHERE id = ${eid}
      `;
      if (rows.length > 0) entities.push(rows[0]);
    }
    
    return {
      nodes: entities.map(e => ({ id: e.id, name: e.name, type: e.type, memoryCount: e.memoryCount })),
      links: relations.map((r: Record<string, unknown>) => ({
        source: r.sourceId, target: r.targetId, type: r.relationType, weight: r.weight,
      })),
    };
  }),
});