/**
 * asset-columns.ts — 归属列是否已存在（2026-10-25, 资产归属 R4 的"安全前置"）
 *
 * 为什么需要："列还没有"这件事无法用类型或配置静态保证：
 *   · Prisma 对不存在的列会直接抛 Unknown argument（不是"读不到"，是 500）；
 *   · Knowledge/Skill 的列要等维护窗口（migrate-asset-scoping-pg.cjs）才出现；
 *   · 若把判据代码写成"无条件引用 visibility"，窗口前就是 500；写成"先不接"，窗口后又会忘。
 * 修法：把"列是否存在"做成一个**带缓存的运行时能力探测**，读路径用它决定是否附加归属过滤。
 *   窗口前 = false（行为与改造前逐字一致）；窗口后 = true，**自动生效，不需要再改代码**。
 */
import { prisma } from "@/lib/prisma";
import { isPgDriver } from "./sql-dialect";

const CACHE = new Map<string, { at: number; ok: boolean }>();
const TTL_MS = 60_000;

export async function hasAssetColumns(kind: "knowledge" | "skill"): Promise<boolean> {
  const table = kind === "knowledge" ? "Knowledge" : "Skill";
  const hit = CACHE.get(table);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    if (isPgDriver()) {
      const rows = await prisma.$queryRawUnsafe<any[]>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=? AND column_name IN ('ownerAgentId','visibility')",
        table);
      ok = (rows || []).length >= 2;
    } else {
      const rows = await prisma.$queryRawUnsafe<any[]>('PRAGMA table_info("' + table + '")');
      const names = (rows || []).map((r: any) => String(r.name || ""));
      ok = names.includes("ownerAgentId") && names.includes("visibility");
    }
  } catch {
    ok = false; // 探测失败按"没有列"处理（保守：不附加过滤，保持旧行为）
  }
  CACHE.set(table, { at: Date.now(), ok });
  return ok;
}

/** 测试/窗口后强制刷新用。 */
export function clearAssetColumnsCache(): void {
  CACHE.clear();
}
