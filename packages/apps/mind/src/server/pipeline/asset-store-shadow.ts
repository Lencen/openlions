/**
 * asset-store-shadow.ts — AssetStorePort 的 shadow 写 adapter（2026-10-27）
 *
 * 用途：替换资产存储前先双跑。本 adapter **不写资产表**，只把"本来要写什么"记成
 * FlywheelEvent(ASSET_SHADOW_WRITE)，用于和现有实现对比覆盖率/差异。
 * 禁止在未验收前把它接到主路径。
 */
import { prisma } from "@/lib/prisma";
import type { Asset, AssetInput, AssetKind, AssetRef, AssetStorePort } from "./ports";

async function logShadow(op: string, kind: AssetKind, payload: unknown): Promise<void> {
  try {
    await (prisma as any).flywheelEvent.create({
      data: {
        stage: "ASSET_SHADOW_WRITE",
        sourceType: "asset-shadow",
        sourceId: kind,
        sourceTitle: JSON.stringify({ op, kind, payload }).slice(0, 900),
        targetStage: "OK",
      },
    });
  } catch { /* shadow 失败不影响主流程 */ }
}

export function createAssetStoreShadowPort(): AssetStorePort {
  return {
    async upsert(kind: AssetKind, asset: AssetInput): Promise<AssetRef> {
      await logShadow("upsert", kind, { title: asset.title, contentHash: asset.contentHash ?? null, theme: asset.theme ?? null });
      return { kind, id: "shadow:" + (asset.contentHash || String(Date.now())) };
    },
    async get(): Promise<Asset | null> {
      return null; // shadow 只写不读
    },
    async archive(kind: AssetKind, id: string, reason: string): Promise<void> {
      await logShadow("archive", kind, { id, reason });
    },
    async link(from: AssetRef, to: AssetRef, role: string): Promise<void> {
      await logShadow("link", from.kind, { from, to, role });
    },
  };
}
