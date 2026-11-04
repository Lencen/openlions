/**
 * asset-scope.ts —— 资产归属判据的**单一实现**（2026-10-23 方案 R1）
 *
 * 背景：Memory 已有 ownerAgentId + memoryScope，但判据只挂在 memory.listScoped 一个接口上；
 *   Knowledge/Skill 完全没有归属。本模块把三者收成同一套纯函数，读路径只允许调这里。
 *
 * 方案与审视：docs/platform-logic/agent-asset-scoping-2026-10-23.md
 *
 * 语义（唯一事实源）：
 *   visibility = private | shared | global
 *   - private：仅 owner 可读；ownerAgentId 为 NULL 的**存量/管线行**一律可读（L1 兼容规则，否则锁死 10 万行）
 *   - shared ：已鉴权 agent 可读（anonymous 不可读）
 *   - global ：任何人可读（含 anonymous）
 *   - admin/OWNER：全读（调用方须 recordAudit 留痕，见方案 A1）
 *
 * 灰度：LIONS_ASSET_SCOPE=off|0 -> 判据退化为"全可读"（等价 2026-10-23 之前的行为）。
 *   开关刻意放在本模块内部（单点），避免某个接口漏加开关。
 */
export type AssetVisibility = "private" | "shared" | "global";
export type AssetKind = "memory" | "knowledge" | "skill";
export type AssetActor =
  | { agentId?: string | null; role?: string | null; anonymous?: boolean }
  | null
  | undefined;
export type AssetRow = {
  ownerAgentId?: string | null;
  visibility?: string | null;
  memoryScope?: string | null;
};

const VISIBILITIES: readonly string[] = ["private", "shared", "global"];

/** 归属列名：Memory 沿用历史列记忆 memoryScope（不重命名，避免第二次 ALTER）。 */
export function ownerColumn(_kind: AssetKind): string {
  return "ownerAgentId";
}
export function visibilityColumn(kind: AssetKind): string {
  return kind === "memory" ? "memoryScope" : "visibility";
}

export function isAdminActor(actor: AssetActor): boolean {
  const r = String((actor && actor.role) || "").toUpperCase();
  return r === "ADMIN" || r === "OWNER";
}

export function isAnonymous(actor: AssetActor): boolean {
  if (!actor) return true;
  if (actor.anonymous === true) return true;
  return !actor.agentId;
}

/** 灰度开关：默认开启；显式 off/0/false 关闭。 */
export function isEnforcementOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.LIONS_ASSET_SCOPE ?? "").toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

/** 行 -> 规范元组。未知/空 visibility 一律按 private（保守）。 */
export function normalizeRow(row: AssetRow | null | undefined, kind: AssetKind = "memory"): { ownerAgentId: string | null; visibility: AssetVisibility } {
  const rawOwner = row && row.ownerAgentId;
  const ownerAgentId = rawOwner == null || String(rawOwner) === "" ? null : String(rawOwner);
  const rawVis = kind === "memory"
    ? (row && (row.memoryScope ?? row.visibility))
    : (row && row.visibility);
  const vis = String(rawVis ?? "").toLowerCase();
  const visibility = (VISIBILITIES.includes(vis) ? vis : "private") as AssetVisibility;
  return { ownerAgentId, visibility };
}

/**
 * Prisma where 片段。管理员/关闭灰度 -> {}（不过滤）。
 * 规则（按读者）：
 *   admin            -> 全部
 *   anonymous        -> 无主 + global
 *   agent（已鉴权）  -> 无主 + shared + global + 自己
 */
export function readableWhere(
  actor: AssetActor,
  opts: { kind?: AssetKind; env?: Record<string, string | undefined> } = {}
): Record<string, unknown> {
  const kind = opts.kind ?? "memory";
  if (!isEnforcementOn(opts.env ?? process.env)) return {};
  if (isAdminActor(actor)) return {};
  const visCol = visibilityColumn(kind);
  const or: Array<Record<string, unknown>> = [{ ownerAgentId: null }, { [visCol]: "global" }];
  const agentId = actor && actor.agentId ? String(actor.agentId) : null;
  if (agentId) or.push({ [visCol]: "shared" }, { ownerAgentId: agentId });
  return { OR: or };
}

/** 单行判定（get / 列表后过滤 / 注入过滤共用）。 */
export function canRead(actor: AssetActor, row: AssetRow | null | undefined, kind: AssetKind = "memory", env?: Record<string, string | undefined>): boolean {
  if (!row) return false;
  if (!isEnforcementOn(env ?? process.env)) return true;
  if (isAdminActor(actor)) return true;
  const { ownerAgentId, visibility } = normalizeRow(row, kind);
  if (ownerAgentId == null) return true;          // L1：存量/管线行 = 公共
  if (visibility === "global") return true;
  if (isAnonymous(actor)) return false;
  if (visibility === "shared") return true;
  const agentId = actor && actor.agentId ? String(actor.agentId) : null;
  return !!agentId && ownerAgentId === agentId;
}

/** 审计/调试用：给出判定原因（不参与权限计算）。 */
export function explain(actor: AssetActor, row: AssetRow | null | undefined, kind: AssetKind = "memory", env?: Record<string, string | undefined>): { allowed: boolean; reason: string } {
  if (!row) return { allowed: false, reason: "row_missing" };
  if (!isEnforcementOn(env ?? process.env)) return { allowed: true, reason: "enforcement_off" };
  if (isAdminActor(actor)) return { allowed: true, reason: "admin" };
  const { ownerAgentId, visibility } = normalizeRow(row, kind);
  if (ownerAgentId == null) return { allowed: true, reason: "legacy_no_owner" };
  if (visibility === "global") return { allowed: true, reason: "global" };
  if (isAnonymous(actor)) return { allowed: false, reason: "anonymous_" + visibility };
  if (visibility === "shared") return { allowed: true, reason: "shared" };
  const agentId = actor && actor.agentId ? String(actor.agentId) : null;
  if (agentId && ownerAgentId === agentId) return { allowed: true, reason: "owner" };
  return { allowed: false, reason: "owner_mismatch" };
}

/**
 * 写入侧赋权：只用于**有身份**的写路径（tRPC actor / x-api-key）。
 * 无身份 -> { ownerAgentId: null, visibility: 请求值或 private }（= L1 公共行）。
 * 非管理员不能把 owner 写成别人（防伪造归属）。
 */
export function writableOwner(
  actor: AssetActor,
  requested?: { ownerAgentId?: string | null; visibility?: string | null }
): { ownerAgentId: string | null; visibility: AssetVisibility } {
  const reqVis = String(requested?.visibility ?? "").toLowerCase();
  const explicit = VISIBILITIES.includes(reqVis) ? (reqVis as AssetVisibility) : null;
  const actorId = actor && actor.agentId ? String(actor.agentId) : null;
  const reqOwner = requested?.ownerAgentId == null || String(requested.ownerAgentId) === "" ? null : String(requested.ownerAgentId);
  // 2026-10-26 修：**可见性默认值必须跟着 owner 走**——
  //   无主（匿名/管线写入）默认 global（公共），有主默认 private；否则会出现"owner=null 但 visibility=private"的自相矛盾行，
  //   前端按列值显示就会把公共存量误标成私有（2026-10-26 frontend-line-2 实测发现 71 行）。
  const pick = (owner: string | null) => (explicit ?? (owner ? "private" : "global")) as AssetVisibility;
  // 管理员可显式指定 owner（代写）；未指定时仍归属自己（身份管理员有 agentId，root_admin 为 null）。
  if (isAdminActor(actor)) { const owner = reqOwner ?? actorId; return { ownerAgentId: owner, visibility: pick(owner) }; }
  if (!actorId) return { ownerAgentId: null, visibility: pick(null) };
  if (reqOwner && reqOwner !== actorId) return { ownerAgentId: actorId, visibility: pick(actorId) }; // 越权请求降级为自己
  return { ownerAgentId: actorId, visibility: pick(actorId) };
}

/**
 * Memory 写入列（R3）：只接受"可见性"这一项业务入参，**owner 永远由服务端从身份推导**。
 * 为什么不收 ownerAgentId：客户端能指定归属 = 可伪造（把私有记忆塞给别人 / 把别人的写成自己的）。
 */
export function memoryWriteFields(
  actor: AssetActor,
  requested?: { visibility?: string | null }
): { ownerAgentId: string | null; memoryScope: AssetVisibility } {
  const o = writableOwner(actor, { visibility: requested?.visibility ?? null });
  return { ownerAgentId: o.ownerAgentId, memoryScope: o.visibility };
}

/** ctx.actor（tRPC 身份）-> 判据 actor。无 agentId = 匿名。 */
export function toAssetActor(actor?: { agentId?: string | null; role?: string | null } | null): AssetActor {
  if (!actor) return null;
  return { agentId: actor.agentId ?? null, role: actor.role ?? null };
}

function sqlLiteral(v: string): string {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/**
 * 裸 SQL 聚合/检索用的 where 片段（Prisma 的 `readableWhere` 无法用于 `$queryRawUnsafe`）。
 * 与 readableWhere 同源同规则；返回 "" 表示不过滤（管理员/灰度关闭）。
 * 注意：列名来自固定枚举，不拼接外部输入；只有 agentId 进字面量，且做单引号转义。
 */
export function scopeSqlFragment(
  actor: AssetActor,
  kind: AssetKind = "memory",
  env: Record<string, string | undefined> = process.env
): string {
  if (!isEnforcementOn(env)) return "";
  if (isAdminActor(actor)) return "";
  const vis = visibilityColumn(kind);
  if (kind !== "memory" && kind !== "knowledge" && kind !== "skill") throw new Error("bad kind: " + String(kind));
  const own = "ownerAgentId IS NULL";
  const agentId = actor && actor.agentId ? String(actor.agentId) : null;
  if (!agentId) return `(${own} OR ${vis} = 'global')`;
  return `(${own} OR ${vis} IN ('shared','global') OR ownerAgentId = ${sqlLiteral(agentId)})`;
}
