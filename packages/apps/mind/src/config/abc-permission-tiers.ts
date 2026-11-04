/**
 * abc-permission-tiers.ts — ABC 三类权限分级单一来源 (uos20 P0#11, 2026-09-23)
 *
 * 决策来源 (与平台记忆同源, 禁止二次定义):
 *   - operator↔agent-d 会话 conv_bb5d4f7066cf msg 31 拍板 + uos20 反馈 #11;
 *   - 分档规则:
 *       A 类 = 纯只读零风险 → 本周开放, 复用 uos20 #3 的 readonly-protocol-whitelist
 *              (method/endpoint 前缀/入参 schema 三件套已齐), 另配**清单**与灰度观察;
 *       B 类 = 受控可写     → **必须** whitelist + audit + rate-limit 三件套齐备才可开,
 *              任一缺失即 fail-closed 不得放行 (本文件 = 闸门, 未过闸的一律 enabled:false);
 *       C 类 = 永远不碰     → 平台层硬拒绝 (403), 与 A/B 无关, 直接命中即拦。
 *
 * 架构定位 (8 维审视之"架构/模块影响"):
 *   - 本文件是**分类与闸门的唯一来源**; A 类明细不复制, 从 readonly-protocol-whitelist 派生,
 *     避免"同一份白名单两处维护"的口径分叉 (2026-09-22 已因 matcher 与白名单漂移踩坑)。
 *   - 本文件**不改动 B 类现有运行时行为** (现存写接口仍由各自 route 校验), 只做策略闸门 +
 *     清单; C 类新增运行时硬拒绝 (所选前缀经核查无现存路由, 零破坏)。
 *   - 守卫接入见 src/middleware.ts (fail-closed)。
 *
 * 复算: npx tsx scripts/probes/probe-abc-permission-tiers.ts
 */
import {
  READONLY_PROTOCOL_WHITELIST,
  readonlyWhitelistCheck,
  describeReadonlyWhitelist,
} from "./readonly-protocol-whitelist";

export type PermissionTier = "A" | "B" | "C" | "UNCLASSIFIED";

/** 分级守卫拒绝结构 (A 类 400/405 或 C 类 403) */
export interface GuardViolation {
  status: 400 | 403 | 405;
  error: string;
  message: string;
}

/** B 类三件套: whitelist(枚举白名单) + audit(审计落库) + rate-limit(限流) */
export type WriteControl = "whitelist" | "audit" | "rateLimit";

export interface ControlRef {
  /** 控制点实现载体 (file:line 或模块名, 供复核) */
  ref: string;
  /** 是否已就位 */
  satisfied: boolean;
}

/** A 类条目: 从 readonly-protocol-whitelist 派生 (只读 GET, 零风险) */
export interface AClassTier {
  tier: "A";
  method: "GET";
  endpointPrefix: string;
  inputParams: string[];
  /** A 类零风险: 恒为 true, 本周开放 */
  open: true;
  description: string;
}

/** B 类条目: 受控可写; 未集齐三件套前 enabled 必须为 false */
export interface BClassTier {
  tier: "B";
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  endpointPrefix: string;
  description: string;
  controls: Record<WriteControl, ControlRef>;
  /** 运行时是否放行 (三件套不全时必须 false) */
  enabled: boolean;
}

/** C 类条目: 永远不碰; method="*" 表示任意方法 */
export interface CClassTier {
  tier: "C";
  method: "*" | "POST" | "PATCH" | "PUT" | "DELETE" | "GET";
  endpointPrefix: string;
  reason: string;
}

/* ------------------------------------------------------------------ *
 * A 类 — 只读 4(+扩展) 接口, 从既有白名单派生 (单一来源, 不复制)
 * ------------------------------------------------------------------ */
export const A_CLASS_TIERS: AClassTier[] = READONLY_PROTOCOL_WHITELIST.map((e) => ({
  tier: "A" as const,
  method: e.method,
  endpointPrefix: e.endpointPrefix,
  inputParams: e.inputSchema.map((p) => `${p.name}:${p.type}${p.required ? "!" : ""}`),
  open: true as const,
  description: e.description,
}));

/* ------------------------------------------------------------------ *
 * B 类 — 受控可写: 必须三件套齐备才 enabled:true
 *   现状 (2026-09-23): 以下候选端点均未集齐审计+限流两件, 故一律 enabled:false;
 *   闸门 validateBClassGate() 在 CI/探针中强制, 防止"缺件放行"。
 *   控制点已就位口径:
 *     - rateLimit: 网关 in-memory token bucket (src/middleware.ts, 100/min burst 20)
 *                  注: 该桶当前只对 /api/trpc 生效, 普通 v1 写接口未覆盖 → 待补;
 *     - audit:     平台审计表 AuditLog (prisma); 写接口需显式落库 → 待补;
 *     - whitelist: 端点在本表被显式枚举 (本文件即载体)。
 * ------------------------------------------------------------------ */
export const B_CLASS_TIERS: BClassTier[] = [
  {
    tier: "B",
    method: "POST",
    endpointPrefix: "/api/v1/knowledge/retract",
    description: "知识撤回 (可写/可逆性受控, 需审计留痕)",
    controls: {
      whitelist: { ref: "abc-permission-tiers.ts B_CLASS_TIERS 显式枚举", satisfied: true },
      audit: { ref: "待补: 写接口 AuditLog 落库 (参考资料: platform/logs 读审计源)", satisfied: false },
      rateLimit: { ref: "待补: v1 写接口限流 (middleware token bucket 当前仅覆盖 /api/trpc)", satisfied: false },
    },
    enabled: false,
  },
  {
    tier: "B",
    method: "POST",
    endpointPrefix: "/api/v1/flywheel/structured/run",
    description: "结构化沉淀手动触发 (写库)",
    controls: {
      whitelist: { ref: "abc-permission-tiers.ts B_CLASS_TIERS 显式枚举", satisfied: true },
      audit: { ref: "待补: 写接口 AuditLog 落库", satisfied: false },
      rateLimit: { ref: "待补: v1 写接口限流", satisfied: false },
    },
    enabled: false,
  },
  {
    tier: "B",
    method: "POST",
    endpointPrefix: "/api/v1/global-organizer/run",
    description: "全局整理器手动触发 (批量写库)",
    controls: {
      whitelist: { ref: "abc-permission-tiers.ts B_CLASS_TIERS 显式枚举", satisfied: true },
      audit: { ref: "待补: 写接口 AuditLog 落库", satisfied: false },
      rateLimit: { ref: "待补: v1 写接口限流", satisfied: false },
    },
    enabled: false,
  },
];

/* ------------------------------------------------------------------ *
 * C 类 — 永远不碰: 平台层硬拒绝 (fail-closed, 403)
 *   所选前缀经核查无现存 route (find packages/apps/mind/src/app/api -name route.ts),
 *   因此硬拒绝不破坏任何在用流程; 新增仅为纵深防御 + 语义明确。
 * ------------------------------------------------------------------ */
export const C_CLASS_TIERS: CClassTier[] = [
  { tier: "C", method: "*", endpointPrefix: "/api/v1/auth", reason: "认证/凭证面 — agent 永不触碰" },
  { tier: "C", method: "*", endpointPrefix: "/api/v1/secrets", reason: "密钥/凭证读取面 — 永不触碰" },
  { tier: "C", method: "*", endpointPrefix: "/api/v1/admin", reason: "平台管理面 — 属 operator 人工维护, agent 不碰" },
  { tier: "C", method: "*", endpointPrefix: "/api/v1/deploy", reason: "部署/进程控制面 — 合并后由集成者统一部署, agent 不碰" },
  { tier: "C", method: "*", endpointPrefix: "/api/v1/sql", reason: "原始 SQL/DB 直通面 — 永不触碰 (只读走 platform/logs 等 A 类)" },
  { tier: "C", method: "*", endpointPrefix: "/internal", reason: "内部端点 — 不对 agent 暴露" },
];

/* ------------------------------------------------------------------ *
 * 判定与闸门
 * ------------------------------------------------------------------ */

function prefixHit(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** C 类匹配 (永远不碰优先, 先于 A/B 判定) */
export function matchCClass(method: string, pathname: string): CClassTier | null {
  const m = String(method || "").toUpperCase();
  for (const e of C_CLASS_TIERS) {
    if (e.method !== "*" && e.method !== m) continue;
    if (prefixHit(e.endpointPrefix, pathname)) return e;
  }
  return null;
}

/** B 类匹配 */
export function matchBClass(method: string, pathname: string): BClassTier | null {
  const m = String(method || "").toUpperCase();
  for (const e of B_CLASS_TIERS) {
    if (e.method !== m) continue;
    if (prefixHit(e.endpointPrefix, pathname)) return e;
  }
  return null;
}

/** A 类匹配 (直接复用既有白名单判定, 不复制规则) */
export function matchAClass(method: string, pathname: string): AClassTier | null {
  const m = String(method || "").toUpperCase();
  return A_CLASS_TIERS.find((e) => e.method === m && prefixHit(e.endpointPrefix, pathname)) ?? null;
}

/** 分类入口: C 优先 (永不触碰覆盖一切) */
export function classifyEndpoint(
  method: string,
  pathname: string
): { tier: PermissionTier; entry: AClassTier | BClassTier | CClassTier | null } {
  const c = matchCClass(method, pathname);
  if (c) return { tier: "C", entry: c };
  const a = matchAClass(method, pathname);
  if (a) return { tier: "A", entry: a };
  const b = matchBClass(method, pathname);
  if (b) return { tier: "B", entry: b };
  return { tier: "UNCLASSIFIED", entry: null };
}

/**
 * B 类闸门: 任一 enabled:true 的 B 条目, 三件套 satisfied 必须全为 true。
 * 返回 blocked = 违规条目 (应为空); pending = 未开启条目清单 (供灰度推进台账)。
 */
export function validateBClassGate(): {
  blocked: Array<{ endpoint: string; missing: WriteControl[] }>;
  pending: string[];
  enabled: string[];
} {
  const blocked: Array<{ endpoint: string; missing: WriteControl[] }> = [];
  const pending: string[] = [];
  const enabled: string[] = [];
  for (const e of B_CLASS_TIERS) {
    const missing = (Object.keys(e.controls) as WriteControl[]).filter((k) => !e.controls[k].satisfied);
    if (e.enabled) {
      if (missing.length > 0) blocked.push({ endpoint: `${e.method} ${e.endpointPrefix}`, missing });
      else enabled.push(`${e.method} ${e.endpointPrefix}`);
    } else {
      pending.push(`${e.method} ${e.endpointPrefix} (缺: ${missing.join(",") || "无"})`);
    }
  }
  return { blocked, pending, enabled };
}

/**
 * 协议分级守卫 (middleware 调用, fail-closed):
 *   - C 类 → 403 硬拒绝;
 *   - A 类 → 委托 readonlyWhitelistCheck (未知/非法入参 400; 注: 按 method 过滤,
 *     "A 类前缀 + 非 GET" 不在此拦, 交 B/C 类或 route 框架级 405, 见 2026-09-24 订正);
 *   - B 类 / 未分类 → null 放行 (B 现存行为不变, 闸门见 validateBClassGate)。
 */
export function abcGuardCheck(
  method: string,
  pathname: string,
  sp: URLSearchParams
): GuardViolation | null {
  const c = matchCClass(method, pathname);
  if (c) {
    return {
      status: 403 as const,
      error: "c_class_forbidden",
      message: `C 类端点永不对外: ${c.method} ${c.endpointPrefix} (${c.reason})`,
    };
  }
  return readonlyWhitelistCheck(method, pathname, sp);
}

/** 清单 (A 类"配清单"交付物 + B/C 台账), 供 /api/v1/platform/permission-tiers 与探针复用 */
export function describeAbcTiers() {
  const gate = validateBClassGate();
  return {
    generatedAt: new Date().toISOString(),
    policy: {
      A: "纯只读零风险 — 本周开放 + 清单 + 灰度观察",
      B: "受控可写 — whitelist + audit + rate-limit 三件套齐备才开, 缺一 fail-closed",
      C: "永远不碰 — 平台层硬拒绝 (403)",
    },
    counts: {
      A: A_CLASS_TIERS.length,
      B: B_CLASS_TIERS.length,
      C: C_CLASS_TIERS.length,
      B_enabled: gate.enabled.length,
      B_pending: gate.pending.length,
    },
    A: A_CLASS_TIERS,
    B: B_CLASS_TIERS,
    C: C_CLASS_TIERS,
    A_readonlyWhitelist: describeReadonlyWhitelist(),
    B_gate: gate,
  };
}
