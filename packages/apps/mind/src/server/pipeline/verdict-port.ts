/**
 * verdict-port.ts — VerdictPort 只读 adapter（2026-10-27）
 *
 * 只读 AcceptanceVerdict 的当前结论；判定/写回仍由 acceptance/runner.cjs 负责
 * （唯一裁判不外包，避免新实现绕过证据闸门）。
 */
import { prisma } from "@/lib/prisma";
import type { Verdict } from "./ports";

export type VerdictReadPort = {
  latest(entityType: "Task" | "Todo", entityId: string): Promise<Verdict | null>;
};

export function createVerdictReadPort(): VerdictReadPort {
  return {
    async latest(entityType, entityId): Promise<Verdict | null> {
      const row = await (prisma as any).acceptanceVerdict.findUnique({
        where: { entityType_entityId: { entityType, entityId } },
      });
      if (!row) return null;
      let fails: string[] = [];
      try { fails = JSON.parse(String(row.failsJson || "[]")); } catch { fails = []; }
      return {
        entityType: row.entityType,
        entityId: row.entityId,
        verdict: row.verdict === "PASS" ? "PASS" : "FAIL",
        specType: row.specType ?? null,
        fails,
        source: row.source === "shadow" ? "shadow" : "runner",
      };
    },
  };
}
