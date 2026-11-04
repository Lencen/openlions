/**
 * asset-store-port.ts — AssetStorePort 的只读 adapter（2026-10-27）
 *
 * 只实现 get；upsert/archive/link 仍由现有写路径负责，避免在没有双跑/验收前
 * 把写语义搬到新接口。用于以后替换资产存储时先切读。
 */
import { prisma } from "@/lib/prisma";
import type { Asset, AssetKind, AssetStorePort } from "./ports";

const MODELS: Record<AssetKind, any> = {
  memory: (prisma as any).memory,
  knowledge: (prisma as any).knowledge,
  practice: (prisma as any).practice,
  skill: (prisma as any).skill,
};

function toIso(v: any): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export type AssetStoreReadPort = Pick<AssetStorePort, "get">;

export function createAssetStoreReadPort(): AssetStoreReadPort {
  return {
    async get(kind: AssetKind, id: string): Promise<Asset | null> {
      const model = MODELS[kind];
      if (!model) return null;
      const row = await model.findUnique({ where: { id } });
      if (!row) return null;
      return {
        kind,
        id: String(row.id),
        title: String(row.title ?? row.name ?? ""),
        content: String(row.content ?? row.description ?? ""),
        theme: row.theme ?? null,
        sourceType: row.sourceType ?? row.source ?? null,
        sourceId: row.sourceId ?? null,
        qualityScore: row.qualityScore ?? null,
        contentHash: row.contentHash ?? null,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      };
    },
  };
}
