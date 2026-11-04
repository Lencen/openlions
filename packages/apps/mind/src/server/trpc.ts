import { initTRPC, TRPCError } from "@trpc/server";
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
// 2026-10-15 钥匙治理(item 2 + item 5): 自动续期与撤销权限判据的**单一实现**都在这里 import。
import { maybeAutoRenewKey, type Actor } from "./lib/key-governance";

// ============================================================================
// P3 阶段 4-6: tRPC 鉴权 (SHARED-BRAIN-AGENT-REGISTRATION-DESIGN-v1.md §6.2)
// 2026-06-17 ut 设计, 跟 mcp 端 x-api-key 模式对齐
//
// RBAC 架构预留 (2026-08-20 agent-x):
//   - 当前是 flat-permission: agent × service → permissions[] (JSON)
//   - 未来演进见 docs/RBAC-ARCHITECTURE-RESERVED.md §三
//   - 扩展点已就位: AgentRegistry.profile / AgentServicePermission.config (JSON 字段可放 tenant_id/role/scope)
//   - 中间件扩展点: isTenantScoped / hasPermission / hasRole 待实现时加, 不动现有 procedure
//   - 非商业版不引入 schema 变更, 保持 flat 模式
// ============================================================================

// Context 含 prisma + headers (从 fetch Request 拿)
export const createTRPCContext = async (opts?: { req?: Request }) => {
  const headers = opts?.req?.headers ?? new Headers();
  return {
    prisma,
    req: opts?.req,
    headers,
    // 2026-10-15 钥匙治理(item 5): 调用者是谁 —— 由鉴权中间件注入。
    //   root_admin     = 平台管理凭据(x-admin-key), 代表平台管理员
    //   identity_admin = role ∈ ADMIN|OWNER 的身份用自己的服务钥匙
    // 普通服务钥匙(EDITOR/VIEWER/NULL)在需要管理员权限的端点上直接 403。
    actor: null as Actor | null,
  };
};

type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({
  // B9 修复 (2026-06-18 11:40): 包 PrismaException 不露 schema 信息
  //   原: 返 PrismaClientKnownRequestError.message 含 "Invalid `prisma.memory.findMany()` invocation" + 完整 SQL
  //   新: 返 user-friendly code + 简短 message, 详细写到 server log
  errorFormatter({ shape, error }) {
    const isPrisma = error.cause?.name?.includes("Prisma") || error.cause?.constructor?.name?.includes("Prisma");
    if (isPrisma) {
      // server log 留全, client 只拿 code
      console.error("[TRPC PrismaError]", error.code, error.message);
      return {
        ...shape,
        data: {
          ...shape.data,
          code: "INTERNAL_SERVER_ERROR",
          httpStatus: 500,
          // 客户端 message 简化, 不返原始 Prisma message
          message: "Internal server error (Prisma operation failed)",
        },
      };
    }
    return shape;
  },
});

// ----------------------------------------------------------------------------
// 中间件: bootstrap key (register 端点用)
// 跟 mcp 端 MCP_API_KEY 类似, server 端共用, 一次性, 改 key 后作废
// 准入 key 在 .env: MIND_BOOTSTRAP_API_KEY
// ----------------------------------------------------------------------------
const isBootstrapAuthed = t.middleware(({ ctx, next }) => {
  const key = ctx.headers.get("x-bootstrap-key") || ctx.headers.get("X-Bootstrap-Key");
  const expected = process.env.MIND_BOOTSTRAP_API_KEY;
  if (!expected) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "MIND_BOOTSTRAP_API_KEY not configured on server",
    });
  }
  if (key !== expected) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "invalid or missing x-bootstrap-key",
    });
  }
  return next();
});

// ----------------------------------------------------------------------------
// 中间件: admin key (addService / removeService / repair-services 用)
// 跟 mcp 端 SERVER_ADMIN_KEY 对齐 (评审 P0-3 拍板: 独立 key, 隔离更彻底)
// 准入 key 在 .env: MIND_ADMIN_API_KEY
// ----------------------------------------------------------------------------
const isAdminAuthed = t.middleware(({ ctx, next }) => {
  const key = ctx.headers.get("x-admin-key") || ctx.headers.get("X-Admin-Key");
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (!expected) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "MIND_ADMIN_API_KEY not configured on server",
    });
  }
  if (key !== expected) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "invalid or missing x-admin-key (admin only)",
    });
  }
  // 2026-10-15 钥匙治理(item 5): 管理端点的调用者身份 = root_admin, 审计里可区分"平台管理员"与"身份管理员"。
  return next({ ctx: { ...ctx, actor: { kind: "root_admin" as const, agentId: null, role: "OWNER" } } });
});

// ----------------------------------------------------------------------------
// 中间件: agent apiKey (业务端点用)
// 查 AgentServicePermission 表, 验: 存在 + status=ACTIVE + 没过期
// ----------------------------------------------------------------------------
/**
 * 凭据 -> AgentServicePermission 的**单一实现**（2026-10-23 资产归属 R2 抽出）。
 * 为什么抽：`readerProcedure`（可选身份读）需要同一套 key 校验，复制一份就会出现
 *   "带 key 的写能被识别、带 key 的读识别不了"这类静默分叉。
 * 返回 null = 未命中/已过期/已撤销（调用方决定抛错还是降级匿名）。
 */
// 2026-10-23 R2-b: 实现抽到 ./lib/agent-key.ts（REST 路由与 tRPC 共用一份），此处保留 re-export 兼容旧 import。
import { loadApiKeyPerm } from "./lib/agent-key";
export { loadApiKeyPerm };

const isApiKeyAuthed = t.middleware(async ({ ctx, next }) => {
  const key = ctx.headers.get("x-api-key") || ctx.headers.get("X-Api-Key");
  if (!key) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "missing x-api-key header",
    });
  }

  const perm = await loadApiKeyPerm(ctx.prisma, key);

  if (!perm || perm.status !== "ACTIVE" || perm.expires_at < new Date()) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "invalid or expired apiKey",
    });
  }

  // 异步更新 last_used_at (fire-and-forget, 不阻塞请求)
  // P3 修复: 之前 last_used_at 一直显示"从未使用", 因为没有 update 逻辑
  //
  // 2026-10-15 round 78 修改(问题 A): **删除**了同时写 `AgentRegistry.last_seen_at` 的那一句。
  //   原因: 它让 `last_seen_at` 表示"最近调过带 key 的接口", 而不是"agent 最近心跳" ——
  //   而 portal 的在线判定正是
  //     `online := status==='ACTIVE' && now - last_seen_at < 300000`
  //   (packages/apps/portal/src/app/api/portal/agents/route.ts:35)。
  //   于是"谁在调接口"被当成"谁在线", 与 fixer 的每小时回填叠加后, 这一列同时表示三件事,
  //   真正的"心跳断了"被彻底掩盖。收口后 `AgentRegistry.last_seen_at` 的**唯一写者**是
  //   `POST /api/v1/agents/seen`(真心跳), 见 scripts/lib/agent-liveness.cjs 的判据。
  //
  //   那它原来想提供的信号("这个身份的 key 最近被用过")去哪了?
  //   已经**存在且更准确**地记在下面这一句里: `AgentServicePermission.last_used_at`(按 key 粒度)。
  //   需要 agent 粒度的"最近接口活动"时对 last_used_at 取 max 即可 —— 那是**读取侧派生**,
  //   不需要在心跳列上再加一个写者。最小改动 = 只删这一句, 不新增列/不加迁移。
  ctx.prisma.agentServicePermission
    .update({ where: { id: perm.id }, data: { last_used_at: new Date() } })
    .catch((e) => {
      console.error("[trpc] last_used_at update failed:", e);
    });

  // 2026-10-15 钥匙治理(item 2): 到期前自动续期(agent 无感)。
  //   只在"到期前 MIND_RENEWAL_WINDOW_DAYS(默认 30)天"窗口内触发, **原地延长 expires_at, 不换密钥值**
  //   —— 所以正在跑的客户端不会掉线; 真正的密钥轮换仍由客户端调 refresh-service-key 完成。
  //   fire-and-forget(与上面的 last_used_at 同款): 续期失败绝不能影响本次业务调用。
  //   幂等: 续期后 expires_at 变成 now+90 天, 远在窗口之外 -> 同一把钥匙最多每 60 天写一次。
  maybeAutoRenewKey(
    { id: perm.id, agent_id: perm.agent_id, service_name: perm.service_name, expires_at: perm.expires_at, status: perm.status },
    { actor: perm.agent_id, actorType: "agent_key" },
  ).catch((e) => {
    console.error("[trpc] auto-renew failed:", e);
  });

  // 注入 ctx.agent
  return next({
    ctx: {
      ...ctx,
      agent: {
        agent_id: perm.agent_id,
        service_name: perm.service_name,
        permissions: JSON.parse(perm.permissions || "[]") as string[],
        config: perm.config ? JSON.parse(perm.config) : {},
      },
      // item 5: 身份侧调用者(role 从 AgentRegistry 读; 缺失视同 EDITOR = 非管理员)
      actor: {
        kind: "identity_admin" as const,
        agentId: perm.agent_id,
        role: perm.agent?.role || "EDITOR",
      },
    },
  });
});

// ----------------------------------------------------------------------------
// 中间件: **可选身份**（资产归属 R2，2026-10-23）
//   用途: 读端点（memory.list/get/themeSummary 等）历史上是 publicProcedure（console 不带 key），
//     现在要按"读者是谁"过滤资产，但不能把 public 改成 protected（会 401 打空 dashboard）。
//   规则: 无 key -> 匿名继续；带 key 但失效 -> 401（不静默降级，否则坏 key 会被当成"没权限"而非"配错了"）；
//         x-admin-key 正确 -> root_admin（管理员全读，调用方负责审计）。
//   刻意**不写** last_used_at / 不触发续期：那两件事的语义是"业务调用活动"，
//     把读流量也算进去会污染 signals（见 isApiKeyAuthed 内 2026-10-15 round 78 注释）。
// ----------------------------------------------------------------------------
const isOptionalActor = t.middleware(async ({ ctx, next }) => {
  const adminKey = ctx.headers.get("x-admin-key") || ctx.headers.get("X-Admin-Key");
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (expected && adminKey === expected) {
    return next({ ctx: { ...ctx, actor: { kind: "root_admin" as const, agentId: null, role: "OWNER" } } });
  }

  const key = ctx.headers.get("x-api-key") || ctx.headers.get("X-Api-Key");
  if (!key) return next();   // 匿名：由判据按 anonymous 处理

  const perm = await loadApiKeyPerm(ctx.prisma, key);
  if (!perm || perm.status !== "ACTIVE" || perm.expires_at < new Date()) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid or expired apiKey" });
  }
  return next({
    ctx: {
      ...ctx,
      agent: {
        agent_id: perm.agent_id,
        service_name: perm.service_name,
        permissions: JSON.parse(perm.permissions || "[]") as string[],
        config: perm.config ? JSON.parse(perm.config) : {},
      },
      actor: { kind: "identity_admin" as const, agentId: perm.agent_id, role: perm.agent?.role || "EDITOR" },
    },
  });
});

// ----------------------------------------------------------------------------
// 中间件: 管理员凭据 OR 身份管理员(2026-10-15 钥匙治理 item 5)
//   用途: 撤销类端点(agent.revoke / agent.revokeServiceFromAgent)。
//   为什么不能只用 adminProcedure: 人类批准的口径是"只有管理员能撤, 且只能撤自己名下的服务/身份"
//     —— 身份自己也可能是 ADMIN/OWNER(角色在 AgentRegistry.role)。所以两条准入路径:
//     ① x-admin-key === MIND_ADMIN_API_KEY -> root_admin(平台管理员, 显式撤他人)
//     ② x-api-key 命中一条 ACTIVE 且未过期的 perm, 且该身份 role ∈ ADMIN|OWNER -> identity_admin
//   普通服务钥匙(EDITOR/VIEWER/NULL)在 ② 就被 403 挡掉 —— 这正是被修掉的漏洞。
// ----------------------------------------------------------------------------
const isAdminOrIdentityAdmin = t.middleware(async ({ ctx, next }) => {
  const adminKey = ctx.headers.get("x-admin-key") || ctx.headers.get("X-Admin-Key");
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (expected && adminKey === expected) {
    return next({ ctx: { ...ctx, actor: { kind: "root_admin" as const, agentId: null, role: "OWNER" } } });
  }

  const key = ctx.headers.get("x-api-key") || ctx.headers.get("X-Api-Key");
  if (!key) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: adminKey
        ? "invalid x-admin-key (未匹配 MIND_ADMIN_API_KEY), 且未提供 x-api-key"
        : "撤销类端点需要管理员凭据: x-admin-key(MIND_ADMIN_API_KEY) 或 ADMIN/OWNER 身份的服务钥匙",
    });
  }
  const hash = createHash("sha256").update(key).digest("hex");
  const perm = await ctx.prisma.agentServicePermission.findUnique({
    where: { api_key_hash: hash },
    include: { agent: true, service: true },
  });
  if (!perm || perm.status !== "ACTIVE" || perm.expires_at < new Date()) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid or expired apiKey" });
  }
  const role = (perm.agent?.role || "EDITOR").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `撤销操作需要管理员权限: 身份 ${perm.agent_id} 的 role=${perm.agent?.role || "NULL"}, 普通服务钥匙不能撤销任何身份/服务`,
    });
  }
  return next({
    ctx: {
      ...ctx,
      agent: {
        agent_id: perm.agent_id,
        service_name: perm.service_name,
        permissions: JSON.parse(perm.permissions || "[]") as string[],
        config: perm.config ? JSON.parse(perm.config) : {},
      },
      actor: { kind: "identity_admin" as const, agentId: perm.agent_id, role },
    },
  });
});

export const createRouter = t.router;
export const publicProcedure = t.procedure;
export const bootstrapProcedure = t.procedure.use(isBootstrapAuthed);  // register 端点
export const adminProcedure = t.procedure.use(isAdminAuthed);          // addService/removeService/repair (评审 P0-3)
export const protectedProcedure = t.procedure.use(isApiKeyAuthed);     // 业务端点
export const readerProcedure = t.procedure.use(isOptionalActor);        // 读端点(可选身份, 2026-10-23 R2)
// 2026-10-15 钥匙治理 item 5: 撤销类端点专用(管理员凭据 或 ADMIN/OWNER 身份钥匙)
export const adminOrIdentityAdminProcedure = t.procedure.use(isAdminOrIdentityAdmin);

// ============================================================================
// P2-A 2026-09-01 RBAC 架构预留 (RBAC-ARCHITECTURE-RESERVED.md §3.3)
//   非商业版不强制启用 — 以下中间件助手供未来商业版端点组合使用,
//   现有端点不接入 (行为不变)。数据层已加 AgentRegistry.role/tenant_id 列。
//   角色层级: OWNER > ADMIN > EDITOR > VIEWER (NULL 视同 EDITOR)
// ============================================================================

const ROLE_RANK: Record<string, number> = { OWNER: 4, ADMIN: 3, EDITOR: 2, VIEWER: 1 };

/** 从 ctx.agent 读取 agent 的 role (查 AgentRegistry.role) */
async function resolveAgentRole(ctx: Context): Promise<string> {
  const agentId = (ctx as any).agent?.agent_id;
  if (!agentId) return "";
  try {
    const a = await ctx.prisma.agentRegistry.findUnique({
      where: { agent_id: agentId },
      select: { role: true },
    });
    return a?.role || "EDITOR"; // NULL 视同 EDITOR
  } catch {
    return "EDITOR";
  }
}

/** 校验 ctx.agent 角色 >= minRole (仅限 protectedProcedure 之后使用) */
export function hasRole(minRole: string) {
  return t.middleware(async ({ ctx, next }) => {
    const role = await resolveAgentRole(ctx);
    const need = ROLE_RANK[minRole] ?? 2;
    const have = ROLE_RANK[role] ?? 2;
    if (have < need) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `role insufficient: need ${minRole} (have ${role})`,
      });
    }
    return next({ ctx: { ...ctx, agent: { ...(ctx as any).agent, role } } });
  });
}

/** 校验 ctx.agent.permissions 含指定权限 (service 级, 现有 permissions[] 数组) */
export function hasPermission(perm: string) {
  return t.middleware(({ ctx, next }) => {
    const perms: string[] = (ctx as any).agent?.permissions ?? [];
    if (!perms.includes(perm)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `permission required: ${perm}`,
      });
    }
    return next();
  });
}

/** 多租户隔离预留: 注入 tenant_id 过滤条件 (未来端点查询用) */
export function isTenantScoped() {
  return t.middleware(async ({ ctx, next }) => {
    const agent = (ctx as any).agent;
    let tenantId: string | undefined;
    if (agent?.agent_id) {
      try {
        const a = await ctx.prisma.agentRegistry.findUnique({
          where: { agent_id: agent.agent_id },
          select: { tenant_id: true },
        });
        tenantId = a?.tenant_id ?? undefined;
      } catch { /* ignore */ }
    }
    return next({ ctx: { ...ctx, tenant: { id: tenantId } } });
  });
}

export type TenantScopedContext = Context & { tenant?: { id?: string } };
