// memory-permission.ts — **兼容 shim**（2026-10-23 资产归属 R2）
// 判据已收敛到 ./asset-scope.ts（单一实现）。本文件只保留旧 import 的出口，避免打断既有调用点；
// 新代码请直接 import { readableWhere, canRead, explain } from "./asset-scope"。
// 语义变化（有意）：global 现在真的"任何人可读"；已鉴权 agent 额外可读 shared（旧实现漏了 shared 的读端）。
import { canRead } from "./asset-scope";

export type MemoryActor = { agentId?: string | null; role?: string | null } | null | undefined;

export { isAdminActor, readableWhere } from "./asset-scope";

/** @deprecated 用 canRead(actor, row, "memory") */
export function canReadMemory(
  actor: MemoryActor,
  m: { ownerAgentId?: string | null; memoryScope?: string | null } | null | undefined
): boolean {
  return canRead(actor, m, "memory");
}
