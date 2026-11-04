import { z } from "zod";
import { createRouter, publicProcedure, protectedProcedure, bootstrapProcedure, adminProcedure, adminOrIdentityAdminProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { getPlatformPolicy, evaluateRegistrationChoice, persistAgentPolicy } from "../pipeline/asset-policy";
// 2026-10-08 round 54: category 受控投影
import { projectCategory } from "../pipeline/enum-projection";
// 2026-10-07 round 53: 受控枚举字段写入侧投影(agent 批量入库路径; 见 pipeline/enum-projection.ts)
import { projectDomain, projectPracticeOutcome } from "../pipeline/enum-projection";
import { safeCreateKnowledge, safeCreatePractice, safeCreateReflection, safeCreateMemory } from "../pipeline/safe-create"; // round 57 G3/G4
import { calcQualityScore } from "../pipeline/db-writer";
// 2026-10-15 round 78: 审计写入收敛到单一实现(另一个调用方 = POST /api/v1/agents/status)
import { recordAudit } from "../lib/audit-log";
// 2026-10-15 钥匙治理(人类批准 item 1/2/3/5): 发钥匙/领取券/到期收口/撤销权限判据的**单一实现**。
//   本文件不再自己拼 TTL、不再自己写 api_key_plain —— 全部走 lib/key-governance。
import {
  BUSINESS_KEY_TTL_DAYS,
  businessKeyTtlMs,
  issueClaimTicket,
  redeemClaimTicket,
  issueBusinessKeysForAgent,
  readablePlaintext,
  expireStaleKeys,
  revokeClaimTicket,
  authorizeRevokeScope,
  type Actor,
  type IssuedKeyEntry,
} from "../lib/key-governance";

// ============================================================================
// P3 阶段 4-6: Agent 服务注册端点
// 2026-06-17 ut 设计, 跟 morning 端 mcp chat register 协议对齐
// 设计文档: docs/SHARED-BRAIN-AGENT-REGISTRATION-DESIGN-v1.md
//
// 2026-10-15 钥匙治理(人类批准, 见 packages/apps/mind/src/server/lib/key-governance.ts 头部):
//   ① 注册/审批不再直发长期业务钥匙, 只发**一次性领取券**(15 分钟, 绑定 agent_id, 换一次即作废);
//   ② 新业务钥匙 TTL = 90 天, 到期翻 EXPIRED, 到期前 30 天窗口内原地自动续期;
//   ③ 明文 api_key_plain 只在发放后 1 小时内可读(读取侧 + 定时清理), 不再长期明文落库;
//   ④ 白名单移除已下线的 agent-h/agent-g; 100 年"永久"档**取消**;
//   ⑤ 撤销类端点要求管理员凭据, 且默认只能撤自己名下(跨身份需显式 allow_cross_identity)。
// ============================================================================

const AGENT_ID_REGEX = /^[a-z][a-z0-9-]*$/;
const SERVICE_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

// 白名单: 历史上拿"永久"key 的 agent_id(跟 mcp 端 mcp_bootstrap 白名单对齐)
// 2026-06-18: 拆分 agent-h → agent-g(claude 端) + agent-h(hermes 端)
// 2026-10-15 钥匙治理 item 4: **移除已下线的 agent-h / agent-g**(库内两行 status=INACTIVE)。
//   白名单现在只剩在役的 morning / thirteen; 且"永久档"已取消 —— 白名单请求 permanent 会被
//   **降级为 90 天并在响应/审计里显式标注**(见 register 的 deprecations), 不再存在 100 年钥匙。
const PERMANENT_AGENT_WHITELIST = new Set(["agent-b", "agent-c"]);

// item 6(2026-10-15): 默认发放时**跳过测试服务**。test_service_p0_3 曾是 ACTIVE+enabled,
//   于是每个新 agent 注册都白拿一把测试钥匙(实测 6 把 ACTIVE)。该服务已在数据侧下线(enabled=false,
//   status=DEPRECATED); 这里再加一条**机制**判据, 以免它(或未来任何 test_* 服务)被重新启用后又渗进默认发放。
const NON_DEFAULT_SERVICE_RE = /^test[_-]/i;

// 工具: 生成 apiKey / sha256 hash
// 2026-10-15 钥匙治理: 实现收敛到 lib/key-governance.ts(generateBusinessKey / hashApiKey),
//   本文件不再自己生成钥匙 —— 避免出现第二份"发钥匙"实现(这正是本次收口要消灭的东西)。

// 工具: JSON 字段存取 (SQLite 不支持 Json 类型, 用 String 存)
function safeJsonStringify(obj: any): string | null {
  if (obj === null || obj === undefined) return null;
  return JSON.stringify(obj);
}

function safeJsonParse<T = any>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export const agentRouter = createRouter({
  // ==========================================================================
  // 1. register - 1 个端点支持多服务 (核心)
  // 鉴权: bootstrapProcedure (MIND_BOOTSTRAP_API_KEY)
  // ==========================================================================
  register: bootstrapProcedure
    .input(z.preprocess(
      // tRPC v11 client 把 input 包装成 {json:{...}}, zod 拿到前先拆
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case (lowercase + dash)"),
        display_name: z.string().min(1),
        channel: z.enum(["hermes", "claude", "mcp", "custom"]),
        // B3 修复 (2026-06-18 11:30): host 默认值补上, 避免 caller 传 'g' / '' 这种简化值
        host: z.string().min(1).default("unknown"),
        sdk_version: z.string().default("1.0.0"),
        // services 数组 (可选, 不传 = 默认全选 enabled=true 的服务)
        services: z.array(z.object({
          name: z.string(),
          permissions: z.array(z.string()).optional(),
          config: z.record(z.string(), z.any()).optional(),
        })).optional(),
        // SOP gate (跟 mcp 端 register 对齐)
        sop_accepted: z.boolean().default(true),
        sop_version: z.string().optional(),
        // profile
        profile: z.record(z.string(), z.any()).optional(),
        avatar: z.string().optional(),
        // 2026-06-17 P3 修复: long_term 标志, true = 1年, false/undefined = 30天
        long_term: z.boolean().default(false),
        // 2026-06-17 P3 修复: permanent 标志, true = 永久 (9999 年)
        // 安全门: 必须在白名单 PERMANENT_AGENT_WHITELIST 内, 否则 403
        // 用于 morning/13/ut 三方永久信任, 永不续期
        permanent: z.boolean().default(false),
        // P0 幂等 (2026-06-18): idempotent=true (默认) → ACTIVE+未过期 perm 沿用旧 key, 不覆盖
        //   force=true → 强制轮换, 忽略 idempotent
        idempotent: z.boolean().default(true),
        force: z.boolean().default(false),
        // 2026-06-17 P3 修复: 注册成功立即同步全部记忆/知识/反思
        // sync_on_register: true = register 成功后, 调用方必须立即 push 自己的全部数据
        // 这步不阻塞 register 返回, 后台异步执行
        sync_on_register: z.boolean().default(false),
        // 2026-10-26 资产可见性策略：注册时声明接受哪种数据策略（平台 public/private 时只能跟随，选反会被拒）
        data_policy: z.object({
          memory: z.enum(["public", "private", "inherit"]).optional(),
          knowledge: z.enum(["public", "private", "inherit"]).optional(),
          skill: z.enum(["public", "private", "inherit"]).optional(),
        }).optional(),
        // 2026-09-02: 双模式接入 — approval_mode
        //   admin: 管理员/可信 bootstrap 调用 (console onboard) → 直接 ACTIVE + 发 key (默认, 兼容旧行为)
        //   self : agent 自助注册 (portal) → status=PENDING, 不发 key, 等管理员 approve
        approval_mode: z.enum(["admin", "self"]).default("admin"),
        // 客户端提供的初始数据统计 (用于 SDK 自检: 客户端先数, 服务端再核)
        initial_stats: z.object({
          memory_count: z.number().int().nonnegative().optional(),
          knowledge_count: z.number().int().nonnegative().optional(),
          reflection_count: z.number().int().nonnegative().optional(),
          practice_count: z.number().int().nonnegative().optional(),
        }).optional(),
      })
    ))
    .mutation(async ({ input }) => {
      // 0. 安全门(item 4, 2026-10-15 钥匙治理): 100 年"永久"档**已取消**。
      //    白名单判据仍然生效(未知调用方带 permanent=true -> 403, 保持 fail-closed);
      //    白名单内也不再发永久钥匙 —— 请求被**降级为 90 天**, 并在响应与审计里显式标注(不静默吞掉)。
      const permanentRequested = input.permanent === true;
      if (permanentRequested && !PERMANENT_AGENT_WHITELIST.has(input.agent_id)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `permanent key 已取消(2026-10-15 钥匙治理): 新签发一律 ${BUSINESS_KEY_TTL_DAYS} 天; 且 ${input.agent_id} 不在白名单内(morning/13)。`,
        });
      }
      const permanentDowngraded = permanentRequested && PERMANENT_AGENT_WHITELIST.has(input.agent_id);
      const longTermRequested = input.long_term === true;

      // 1. 查所有 enabled 服务
      const allServices = await prisma.agentService.findMany({
        where: { enabled: true, status: "ACTIVE" },
      });
      const serviceMap = new Map(allServices.map(s => [s.name, s]));

      // 2. 决定实际要注册的服务
      //   - 不传 services: 默认全选 enabled=true 的服务 **但跳过 test_* 测试服务**(item 6 的机制判据)
      //   - 传 services: 按传入的列表 (空数组 = 不选)
      const servicesToRegister = input.services !== undefined
        ? input.services
        : allServices
            .filter(s => !NON_DEFAULT_SERVICE_RE.test(s.name))
            .map(s => ({
              name: s.name,
              permissions: safeJsonParse<string[]>(s.available_perms, []),
              config: safeJsonParse<any>(s.default_config, {}),
            }));
      const autoSkippedTestServices = input.services === undefined
        ? allServices.filter(s => NON_DEFAULT_SERVICE_RE.test(s.name)).map(s => s.name)
        : [];

      // 2.5 2026-10-26 数据策略校验：注册即契约——平台 public/private 时只能跟随，选反直接拒绝注册
      const platformPolicy = await getPlatformPolicy();
      const policyModes: Record<"memory" | "knowledge" | "skill", "public" | "private"> = { memory: "public", knowledge: "public", skill: "public" };
      for (const kind of ["memory", "knowledge", "skill"] as const) {
        const decision = evaluateRegistrationChoice(platformPolicy[kind], (input as any).data_policy?.[kind]);
        if (!decision.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: decision.code + ": " + decision.message + "（asset=" + kind + "）" });
        }
        policyModes[kind] = decision.mode;
      }

      // 3. 写/更新 AgentRegistry (幂等)
      // 2026-09-02: approval_mode='self' → PENDING (等管理员审批); admin → ACTIVE (兼容旧)
      const registryStatus = input.approval_mode === "self" ? "PENDING" : "ACTIVE";
      const agent = await prisma.agentRegistry.upsert({
        where: { agent_id: input.agent_id },
        create: {
          agent_id: input.agent_id,
          display_name: input.display_name,
          channel: input.channel,
          host: input.host,
          avatar: input.avatar,
          profile: safeJsonStringify(input.profile),
          status: registryStatus,
        },
        update: {
          display_name: input.display_name,
          channel: input.channel,
          host: input.host,
          avatar: input.avatar,
          profile: safeJsonStringify(input.profile),
          status: registryStatus,
          updated_at: new Date(),
        },
      });

      // 2026-10-26: 策略随注册落库（自助/管理审批两条路都要写）
      await persistAgentPolicy(input.agent_id, policyModes);

      // 2026-09-02: self 模式 → 不生成密钥, 返回待审批 (由管理员在 console approve 后发 key)
      if (input.approval_mode === "self") {
        // item 1: 自助注册时把此前可能存在的未换取领取券一并作废(重签语义; 无券则 no-op)
        await revokeClaimTicket(input.agent_id, "register:self", "agent_self", "self re-register supersedes prior claim ticket");
        // 审计: 自助注册请求 (PENDING)
        await recordAudit({
          entityType: "AGENT", entityId: input.agent_id,
          action: "REGISTER_REQUEST",
          actor: input.agent_id, actorType: "agent_self",
          before: null,
          after: JSON.stringify({ status: "PENDING", channel: input.channel, host: input.host }),
          metadata: { display_name: input.display_name, sop_version: input.sop_version || null },
        });
        return {
          status: "pending_approval",
          agent_id: input.agent_id,
          display_name: input.display_name,
          message: "已提交注册, 等待管理员审批。审批通过后会得到一张**一次性领取券**(15 分钟), 用它换取正式业务钥匙(90 天)。",
          key_policy: { mode: "claim_ticket", business_key_ttl_days: BUSINESS_KEY_TTL_DAYS },
          // 注册即被告知平台策略（不接受可放弃注册）
          data_policy: { platform: platformPolicy, effective: policyModes },
        };
      }

      // 4. item 1 新口径: register **不再直接发业务钥匙**。
      //    · 已存在 ACTIVE 且未过期的服务 -> 沿用(不换钥匙, 不打断在跑的客户端; 明文可读时才返明文);
      //    · 其余(新服务 / force=true 强制轮换 / 已过期 / 已撤销) -> 进"领取券"清单, 由 agent 换取时正式签发。
      const result: Record<string, any> = {
        status: "ok",
        agent_id: input.agent_id,
        services: {},
      };
      let hasFailed = false;

      const now = Date.now();
      const force = input.force ?? false;
      const existingPerms = await prisma.agentServicePermission.findMany({
        where: { agent_id: input.agent_id },
        orderBy: { updated_at: "desc" },
      });
      const existingMap = new Map(existingPerms.map((p) => [p.service_name, p]));

      const ticketServices: string[] = [];
      for (const svc of servicesToRegister) {
        const meta = serviceMap.get(svc.name);
        if (!meta) {
          console.warn(`[register] unknown service: ${svc.name}, marked skipped`);
          result.services[svc.name] = {
            status: "skipped",
            error: `service "${svc.name}" not found in AgentService table (add it via adminProcedure addService first)`,
          };
          hasFailed = true;
          continue;
        }
        const existing = existingMap.get(svc.name);
        const stillActive = !!existing && existing.status === "ACTIVE" && existing.expires_at.getTime() > now;
        if (stillActive && !force) {
          // 沿用: 不改 hash/expires_at/status(现有钥匙继续可用, 人类约束 1)
          const plain = readablePlaintext(existing!, now);
          result.services[svc.name] = {
            status: "idempotent_reused",
            api_key: plain || undefined,
            api_key_hint: plain
              ? null
              : "明文缓存窗口(发放后 1 小时)已过: 本机请继续用已落盘的旧 key; 需要重发明文走 adminProcedure grantApiKey(按服务) 或 refresh-service-key",
            token_id: existing!.token_id,
            endpoint: meta.endpoint,
            permissions: safeJsonParse<string[]>(existing!.permissions, []),
            expires_at: existing!.expires_at.toISOString(),
            note: plain
              ? "已有 ACTIVE+未过期 perm, 沿用旧 key(幂等). 设 force=true 可强制轮换(轮换在领取券换取时发生)."
              : "已有 ACTIVE+未过期 perm, 沿用旧 hash(请用 .env 里的旧 API_KEY).",
          };
          // 幂等沿用也刷新一下 updated_at 上一次"活跃"时间(不碰 expires_at/status)
          await prisma.agentServicePermission.update({ where: { id: existing!.id }, data: { updated_at: new Date(now) } }).catch(() => undefined);
          continue;
        }
        ticketServices.push(svc.name);
        result.services[svc.name] = {
          status: "claim_required",
          endpoint: meta.endpoint,
          permissions: svc.permissions || safeJsonParse<string[]>(meta.available_perms, []),
          reason: existing
            ? (force ? "force_rotate" : `existing_status_${existing.status}`)
            : "new_grant",
          note: "注册/审批只发一次性领取券; 用 claim_ticket 调 POST /api/v1/agent/claim-service-key 换取正式业务钥匙",
        };
      }

      // 4.5 发券(一张, 覆盖上面所有需要新钥匙的服务)
      let claimTicket: Record<string, any> | null = null;
      if (ticketServices.length > 0) {
        const t = await issueClaimTicket({
          agentId: input.agent_id,
          services: ticketServices,
          actor: "console-onboard",
          actorType: "bootstrap_key",
          reason: permanentDowngraded ? "permanent_requested_downgraded_to_90d" : (force ? "force_rotate" : "register"),
        });
        claimTicket = {
          value: t.ticket,
          hash8: t.hash8,
          expires_at: t.expires_at,
          ttl_seconds: t.ttl_seconds,
          services: t.services,
          redeem: {
            method: "POST",
            url: "/api/v1/agent/claim-service-key",
            body: { agent_id: input.agent_id, ticket: "<上面这个 value>" },
            note: "一次性: 换取成功后券立即作废(审计保留); 密钥明文只在换取响应里出现一次",
          },
          warning: "本值只在本次响应出现一次, 请立即交给该 agent 并落盘(0600); 丢失就重新签发(旧券随之作废)。",
        };
      } else {
        // 没有需要新签发的服务 -> 清掉可能残留的未换取券(避免旧券日后被误用)
        await revokeClaimTicket(input.agent_id, "register:admin", "bootstrap_key", "no new issuance needed on re-register");
      }
      result.claim_ticket = claimTicket;
      result.claim_required_services = ticketServices;
      result.auto_skipped_default_services = autoSkippedTestServices;

      if (hasFailed) {
        result.status = "partial";
      }

      // 5. roster (3 agent 全部 online, 跟 mcp 端 register 返回一致)
      const allAgents = await prisma.agentRegistry.findMany({
        where: { status: "ACTIVE" },
        select: { agent_id: true, display_name: true },
      });
      result.agent_roster = allAgents;
      result.registered_at = new Date().toISOString();
      result.sop_acknowledged_at = input.sop_accepted ? new Date().toISOString() : null;
      // 2026-10-15: TTL 语义变更 —— 只有"业务钥匙"才有 TTL(90 天), 且是在**换取领取券时**签发的;
      //   本次响应若只发了券, 顶层 expires_at = 券的到期时间(不再冒充钥匙到期时间)。
      result.business_key_ttl_days = BUSINESS_KEY_TTL_DAYS;
      result.business_key_ttl_hours = Math.floor(businessKeyTtlMs() / 3600000);
      result.ttl_hours = result.business_key_ttl_hours;      // 兼容旧字段(旧客户端读它算续期时间)
      result.ttl_type = `standard_${BUSINESS_KEY_TTL_DAYS}d`;
      result.permanent = false;                              // 100 年档已取消
      result.permanent_requested = permanentRequested;
      result.permanent_downgraded = permanentDowngraded;
      result.long_term = false;                              // 1 年档已取消(统一 90 天)
      result.long_term_requested = longTermRequested;
      result.deprecations = [
        ...(permanentDowngraded ? [`permanent=true 已取消: 本次降级为 ${BUSINESS_KEY_TTL_DAYS} 天(白名单内也不再发永久钥匙)`] : []),
        ...(longTermRequested ? [`long_term=true 已取消: 统一 ${BUSINESS_KEY_TTL_DAYS} 天`] : []),
        "注册/审批不再直发业务钥匙: 只发一次性领取券(15 分钟), 换取后得 90 天业务钥匙",
      ];
      result.expires_at = claimTicket ? claimTicket.expires_at : null;
      result.expires_at_meaning = claimTicket ? "claim_ticket_expires_at" : "no_key_issued_in_this_call";

      // 2026-06-17 P3 修复: 返回 sync 指引
      // 2026-10-15 改: 第一步不再是"存 3 把 key"(register 已不发 key), 而是"用券换钥匙"
      const mindApiKey = (result.services.lions_mind as any)?.api_key;
      result.next_steps = {
        step_1: claimTicket
          ? "POST /api/v1/agent/claim-service-key {agent_id, ticket} 换取正式业务钥匙(一次性), 立即落盘 0600"
          : "无需换券: 已有服务沿用旧 key; 其余服务请管理员按服务授权/重发",
        step_2: mindApiKey
          ? "POST agent.bulkImport with your local memories/knowledge/reflections/practices (x-api-key: lions_mind key, max 1000/type)"
          : "拿到 lions_mind key 后再调 agent.bulkImport(用换取响应里的 api_key)",
        step_3: "run health check on each service (GET {endpoint}/health)",
        step_4: `业务钥匙 ${BUSINESS_KEY_TTL_DAYS} 天有效; 到期自动失效, 到期前窗口内平台会自动续期(不换密钥值); 需真正轮换密钥时调 POST /api/v1/agent/refresh-service-key`,
      };
      result.data_policy = { platform: platformPolicy, effective: policyModes };
      result.sync_required = input.sync_on_register;
      result.sync_endpoint = "agent.bulkImport";

      // P1-2 (2026-08-18): 返回 sync_config, 告诉 agent 怎么同步数据
      // - sync_client_url: 同步脚本下载/安装地址 (后续 P1-3 实现 curl 安装)
      // - session_service: 上传 session 的 endpoint + 用的 api_key
      // - data_sources: agent 可选的本地数据源 (优先级排序)
      const sessionApiKey = (result.services.lions_session as any)?.api_key;
      const sessionEndpoint = (result.services.lions_session as any)?.endpoint;
      result.sync_config = {
        sync_client_path: "~/.local/bin/lions-sync.py",
        sync_client_version: "1.0.0",
        session_service: sessionApiKey && sessionEndpoint ? {
          url: sessionEndpoint,
          api_key: sessionApiKey,
          upload_path: "/api/sessions/upload",
        } : null,
        data_sources: [
          {
            type: "hermes_db",
            priority: 1,
            description: "Hermes SQLite state.db (推荐, 实时)",
            auto_detect_paths: [
              "~/.hermes/state.db",
              `~/agents/${input.agent_id}/.hermes/state.db`,
            ],
          },
          {
            type: "hermes_json",
            priority: 2,
            description: "Hermes sessions/*.json 快照 (批量)",
            auto_detect_paths: [
              "~/.hermes/sessions",
              `~/agents/${input.agent_id}/00 ai agent/hermes work/sessions`,
            ],
          },
          {
            type: "claude_jsonl",
            priority: 3,
            description: "Claude ~/.claude/projects/**/*.jsonl",
            auto_detect_paths: ["~/.claude/projects"],
          },
        ],
        install_hint: input.sync_on_register
          ? "curl -o ~/.local/bin/lions-sync.py <sync_client_url> && python3 lions-sync.py"
          : "manual: python3 lions-sync.py --agent <agent_id>",
      };

      // 审计: 管理员直通注册成功 (console onboard / bootstrap)
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "REGISTER_ACTIVE",
        actor: "console-onboard", actorType: "bootstrap_key",
        before: null,
        after: JSON.stringify({ status: "ACTIVE", services: Object.keys(result.services || {}) }),
        metadata: { mode: "admin", ttl_type: result.ttl_type, sync_on_register: input.sync_on_register },
      });

      return result;
    }),

  // ==========================================================================
  // 2. list - 列出所有已注册 agent
  // ==========================================================================
  list: publicProcedure.query(async () => {
    // B18 修复 (2026-06-18 15:25): 用 updated_at DESC (最近活动优先)
    return prisma.agentRegistry.findMany({
      where: { status: "ACTIVE" },
      // 2026-09-07: 返回全部权限(含 REVOKED), 供 console 授权矩阵展示 REVOKED 状态
      include: { permissions: true },
      orderBy: { updated_at: "desc" },
    });
  }),

  // ==========================================================================
  // 3. get - 查单个 agent 详情
  // ==========================================================================
  get: protectedProcedure
    .input(z.object({ agent_id: z.string() }))
    .query(async ({ input }) => {
      return prisma.agentRegistry.findUnique({
        where: { agent_id: input.agent_id },
        // 2026-09-07: 全量权限供授权矩阵
        include: { permissions: true },
      });
    }),

  // ==========================================================================
  // 4. revoke - 撤销 agent (置 status=REVOKED, 失效所有 service 凭证)
  // ==========================================================================
  // 2026-10-15 钥匙治理 item 5(安全修复, 人类批准先做):
  //   修前 = `protectedProcedure` + 不校验 input.agent_id 是否等于调用者 ->
  //     **任何一把有效 service key 都能撤销任意 agent**(实测可达: 库里 57 条 ACTIVE 授权, 每条都能撤别人);
  //   修后 = ① 准入改为 `adminOrIdentityAdminProcedure`: 平台管理凭据(x-admin-key) 或 role ∈ ADMIN|OWNER
  //         的身份自己的服务钥匙; 普通服务钥匙(EDITOR/VIEWER/NULL) 直接 403;
  //        ② 作用域 = "只能撤自己名下", 跨身份必须显式 `allow_cross_identity=true` 且 role=OWNER
  //         (平台管理凭据本身即"显式撤他人", 逐条审计 actorType=admin_key);
  //        ③ 幂等: 目标不存在 -> NOT_FOUND(不再让 Prisma 原始错误冒到客户端);
  //        ④ 撤销时**一并作废未换取的领取券**, 并记录 actor/role/跨身份标志/reason。
  revoke: adminOrIdentityAdminProcedure
    .input(z.object({
      agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
      // 显式跨身份撤销开关(默认 false): 只有 OWNER 身份可打开; 平台管理凭据不需要它
      allow_cross_identity: z.boolean().default(false),
      reason: z.string().max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const actor = (ctx as any).actor as Actor | null;
      const gate = authorizeRevokeScope(actor, input.agent_id, input.allow_cross_identity);
      if (!gate.ok) {
        // 拒绝也要留痕(安全事件): actor 是谁、想撤谁、为什么被拒
        await recordAudit({
          entityType: "AGENT", entityId: input.agent_id,
          action: "REVOKE_DENIED",
          actor: actor?.agentId || "unknown", actorType: actor?.kind || "none",
          before: null, after: null,
          metadata: { reason: gate.message, actor_role: actor?.role || null, cross_identity_requested: input.allow_cross_identity },
        });
        throw new TRPCError({ code: "FORBIDDEN", message: gate.message });
      }
      const target = await prisma.agentRegistry.findUnique({ where: { agent_id: input.agent_id }, select: { status: true, agent_id: true } });
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: `agent ${input.agent_id} not found` });
      }
      // 撤销前把未换取的领取券作废(否则撤销后 15 分钟内仍可能换出钥匙)
      const ticketRevoked = await revokeClaimTicket(input.agent_id, actor?.agentId || "console-admin", actor?.kind || "admin_key", "identity revoked");
      await prisma.agentRegistry.update({
        where: { agent_id: input.agent_id },
        data: { status: "REVOKED", updated_at: new Date() },
      });
      const revokedPerms = await prisma.agentServicePermission.updateMany({
        where: { agent_id: input.agent_id, status: "ACTIVE" },
        data: { status: "REVOKED", updated_at: new Date() },
      });
      // 审计: 撤销接入 (REVOKED, 全部 service 凭证失效)
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "REVOKE",
        actor: actor?.agentId || "console-admin", actorType: actor?.kind || "admin_key",
        before: JSON.stringify({ status: target.status }),
        after: JSON.stringify({ status: "REVOKED", perms_revoked: revokedPerms.count }),
        metadata: {
          actor_role: actor?.role || null,
          cross_identity: actor?.kind === "root_admin" ? true : gate.crossIdentity,
          allow_cross_identity: input.allow_cross_identity,
          claim_ticket_revoked: ticketRevoked,
          reason: input.reason || null,
        },
      });
      return { status: "ok", agent_id: input.agent_id, perms_revoked: revokedPerms.count, claim_ticket_revoked: ticketRevoked, cross_identity: gate.crossIdentity };
    }),

  // ==========================================================================
  // 5. updatePermissions - 更新 agent × service 权限
  // ==========================================================================
  // 2026-10-15 钥匙治理(同级漏洞的相邻加固, 超出批准清单但同属"谁能改谁"这一类):
  //   修前 = 任何一把有效 service key 都能改**任意 agent** 的 permissions(等同提权: 给自己加权限项);
  //   修后 = 只能改**自己**那一条(agent_id 必须等于调用者); 管理侧改权限走 adminProcedure 的
  //          `setServicePermissions`(console 用的就是它, 所以管理路径不受影响)。
  //   回退方式: 删掉下面这个自校验分支即可(不涉及其它代码)。
  updatePermissions: protectedProcedure
    .input(z.object({
      agent_id: z.string(),
      service_name: z.string(),
      permissions: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const caller = (ctx as any).agent?.agent_id as string | undefined;
      if (!caller || caller !== input.agent_id) {
        await recordAudit({
          entityType: "AGENT", entityId: input.agent_id,
          action: "UPDATE_PERMISSIONS_DENIED",
          actor: caller || "unknown", actorType: "agent_key",
          before: null, after: null,
          metadata: { service_name: input.service_name, reason: "cross_agent_update_permissions" },
        });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `只能修改自己的服务权限(调用者=${caller || "?"}, 目标=${input.agent_id}); 管理侧请用 setServicePermissions`,
        });
      }
      const updated = await prisma.agentServicePermission.update({
        where: {
          agent_id_service_name: {
            agent_id: input.agent_id,
            service_name: input.service_name,
          },
        },
        data: {
          permissions: JSON.stringify(input.permissions),
          updated_at: new Date(),
        },
      });
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "UPDATE_PERMISSIONS",
        actor: caller, actorType: "agent_key",
        before: JSON.stringify({ service_name: input.service_name }),
        after: JSON.stringify({ service_name: input.service_name, permissions: input.permissions }),
        metadata: { self_scoped: true },
      });
      return { status: "ok", permissions: input.permissions };
    }),

  // ==========================================================================
  // 5.5 setServicePermissions / setCapabilityTier (2026-09-14)
  //   用户反馈: "无法在 agent 详情中对 agent 权限进行调整" —— 排查确认后端**没有**可用路径:
  //     - grantServiceToAgent: 整服务授权, 且**必然换发新 key**(line 611 每次 generateApiKey),
  //       用它改权限会让该 agent 立刻掉线(客户端还在用旧 key);
  //     - updatePermissions: 是 protectedProcedure(要 agent 自己的 key), 且不校验权限项、
  //       不写审计、记录不存在时直接抛 Prisma 原始错误;
  //     于是 console 详情页的"权限"列只能当只读文本展示。
  //   本过程补齐管理侧能力: 只改权限集合, **绝不换 key**, 校验必须 ⊆ 服务 available_perms, 全程写审计。
  // ==========================================================================
  setServicePermissions: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        service_name: z.string().regex(SERVICE_NAME_REGEX, "service_name must be snake_case"),
        permissions: z.array(z.string().min(1)).max(64),
      }),
    ))
    .mutation(async ({ input }) => {
      const perm = await prisma.agentServicePermission.findUnique({
        where: { agent_id_service_name: { agent_id: input.agent_id, service_name: input.service_name } },
      });
      if (!perm) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `${input.agent_id} × ${input.service_name} 还没有授权记录: 请先"补发授权"再调整权限`,
        });
      }
      const meta = await prisma.agentService.findUnique({ where: { name: input.service_name } });
      const available = safeJsonParse<string[]>(meta?.available_perms, []);
      const unknown = input.permissions.filter((p) => !available.includes(p));
      if (available.length && unknown.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `权限项不在该服务的可用集合内: ${unknown.join(", ")}; 可用: ${available.join(", ")}`,
        });
      }
      const before = safeJsonParse<string[]>(perm.permissions, []);
      // 注意: 只改 permissions 列 —— 不碰 api_key_hash / api_key_plain / token_id / expires_at。
      //   换 key 是 grantServiceToAgent 的语义(重发), 调权限不该让在用客户端掉线。
      await prisma.agentServicePermission.update({
        where: { agent_id_service_name: { agent_id: input.agent_id, service_name: input.service_name } },
        data: { permissions: JSON.stringify(input.permissions), updated_at: new Date() },
      });
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "SET_SERVICE_PERMISSIONS",
        actor: "console-admin", actorType: "admin_key",
        before: JSON.stringify({ service_name: input.service_name, permissions: before }),
        after: JSON.stringify({ service_name: input.service_name, permissions: input.permissions }),
        metadata: { keyRotated: false },
      });
      return {
        status: "ok", agent_id: input.agent_id, service_name: input.service_name,
        permissions: input.permissions, before, keyRotated: false,
        statusUnchanged: perm.status, note: "仅调整权限集合, 密钥未变更(客户端无需重启取新 key)",
      };
    }),

  // 能力分级 T0-T3 的管理入口(2026-09-11 用户批准的分级方案, 权威源 = AgentRegistry.profile.capabilityTier)。
  //   此前只有 seed 脚本能写, 详情页无从调整 —— 本次补上。
  setCapabilityTier: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        tier: z.number().int().min(0).max(3),
        reason: z.string().max(200).optional(),
      }),
    ))
    .mutation(async ({ input }) => {
      const agent = await prisma.agentRegistry.findUnique({ where: { agent_id: input.agent_id } });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: `${input.agent_id} not found` });
      let profile: any = {};
      try { profile = agent.profile ? JSON.parse(String(agent.profile)) : {}; } catch { profile = {}; }
      const before = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
      const TIER_NAME = ["T0 纯文本", "T1 只读查证", "T2 提案式写", "T3 直接写"];
      profile.capabilityTier = input.tier;
      profile.capabilityReason = input.reason || ("console 手工设置 -> " + TIER_NAME[input.tier]);
      profile.capabilitySetBy = "console-admin";
      profile.capabilitySetAt = new Date().toISOString();
      await prisma.$executeRaw`UPDATE AgentRegistry SET profile=${JSON.stringify(profile)}, updated_at=${new Date()} WHERE agent_id=${input.agent_id}`;
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "SET_CAPABILITY_TIER",
        actor: "console-admin", actorType: "admin_key",
        before: JSON.stringify({ capabilityTier: before }),
        after: JSON.stringify({ capabilityTier: input.tier, label: TIER_NAME[input.tier] }),
        metadata: {},
      });
      return { status: "ok", agent_id: input.agent_id, before, tier: input.tier, label: TIER_NAME[input.tier] };
    }),

  // ==========================================================================
  // 6. listServices - 列出所有可用服务 (动态从 AgentService 表读)
  // ==========================================================================
  listServices: publicProcedure.query(async () => {
    return prisma.agentService.findMany({
      where: { enabled: true, status: "ACTIVE" },
      orderBy: { name: "asc" },
    });
  }),

  // ==========================================================================
  // 6.5 grantServiceToAgent / revokeServiceFromAgent (2026-09-07)
  //   业务授权按服务粒度管理: 管理员可单独给某 agent 授权/取消某业务,
  //   不依赖整 agent revoke, 也不受 PERMANENT 白名单限制 (那是 grantApiKey 的重发语义)。
  //   设计: 审批时勾选业务 -> approve 发对应 key; 之后可单独取消(REVOKED)或补发。
  // ==========================================================================
  grantServiceToAgent: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        service_name: z.string().regex(SERVICE_NAME_REGEX, "service_name must be snake_case"),
      }),
    ))
    .mutation(async ({ input }) => {
      // 安全门 1: agent 必须存在且 ACTIVE
      const agent = await prisma.agentRegistry.findUnique({ where: { agent_id: input.agent_id } });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: `${input.agent_id} not found` });
      if (agent.status !== "ACTIVE") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `agent status=${agent.status}, only ACTIVE can be granted` });
      }
      // 安全门 2: service 必须存在且启用
      const meta = await prisma.agentService.findUnique({ where: { name: input.service_name } });
      if (!meta || meta.status !== "ACTIVE" || !meta.enabled) {
        throw new TRPCError({ code: "NOT_FOUND", message: `service ${input.service_name} 不存在或未启用` });
      }
      // 已有记录 (可能 REVOKED): 复用 unique(agent_id, service_name) 重新激活并换新 key
      // 2026-10-15 钥匙治理(item 2/3): 实现收敛到 lib/key-governance —— 90 天 TTL + 明文 1 小时窗口 +
      //   审计(ISSUE_SERVICE_KEY/ROTATED)。这是**管理员显式授权**路径: 允许把 REVOKED 重新激活, 且会轮换密钥。
      const prevPerm = await prisma.agentServicePermission.findUnique({
        where: { agent_id_service_name: { agent_id: input.agent_id, service_name: input.service_name } },
        select: { status: true },
      });
      const issued = await issueBusinessKeysForAgent({
        agentId: input.agent_id,
        serviceNames: [input.service_name],
        actor: "console-admin",
        actorType: "admin_key",
        reuseWhenPossible: false,   // 管理侧授权 = 显式重发, 必须换新 key
        allowRevokedRevival: true,
      });
      const entry = issued[input.service_name] as IssuedKeyEntry | undefined;
      if (!entry || entry.status !== "issued" || !entry.api_key) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: entry?.error || "grant failed" });
      }
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "GRANT_SERVICE",
        actor: "console-admin", actorType: "admin_key",
        before: JSON.stringify({ service_name: input.service_name, prev_status: prevPerm?.status ?? null }),
        after: JSON.stringify({ service_name: input.service_name, status: "ACTIVE", expires_at: entry.expires_at, key_fp: entry.key_fp }),
        metadata: { ttl_days: BUSINESS_KEY_TTL_DAYS, plaintext_cache_seconds: 3600, key_rotated: true },
      });
      return {
        status: "ok", agent_id: input.agent_id, service_name: input.service_name,
        api_key: entry.api_key, expires_at: entry.expires_at,
        plaintext_readable_until: new Date(Date.now() + 3600 * 1000).toISOString(),
        note: "明文只在响应里出现一次 + 库内缓存 1 小时(幂等重发用); 业务钥匙 90 天有效",
      };
    }),

  // 2026-10-15 钥匙治理 item 5: 与 revoke 同款准入 + 作用域(默认只能撤"自己名下"的服务)。
  revokeServiceFromAgent: adminOrIdentityAdminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        service_name: z.string().regex(SERVICE_NAME_REGEX, "service_name must be snake_case"),
        allow_cross_identity: z.boolean().default(false),
        reason: z.string().max(200).optional(),
      }),
    ))
    .mutation(async ({ ctx, input }) => {
      const actor = (ctx as any).actor as Actor | null;
      const gate = authorizeRevokeScope(actor, input.agent_id, input.allow_cross_identity);
      if (!gate.ok) {
        await recordAudit({
          entityType: "AGENT", entityId: input.agent_id,
          action: "REVOKE_SERVICE_DENIED",
          actor: actor?.agentId || "unknown", actorType: actor?.kind || "none",
          before: null, after: null,
          metadata: { service_name: input.service_name, reason: gate.message, actor_role: actor?.role || null },
        });
        throw new TRPCError({ code: "FORBIDDEN", message: gate.message });
      }
      const existing = await prisma.agentServicePermission.findUnique({
        where: { agent_id_service_name: { agent_id: input.agent_id, service_name: input.service_name } },
      });
      if (!existing || existing.status !== "ACTIVE") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${input.agent_id} × ${input.service_name} 无 ACTIVE 授权可取消` });
      }
      await prisma.$executeRaw`
        UPDATE AgentServicePermission SET status=${"REVOKED"}, updated_at=${new Date().toISOString()}
        WHERE agent_id=${input.agent_id} AND service_name=${input.service_name}
      `;
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "REVOKE_SERVICE",
        actor: actor?.agentId || "console-admin", actorType: actor?.kind || "admin_key",
        before: JSON.stringify({ service_name: input.service_name, status: "ACTIVE" }),
        after: JSON.stringify({ service_name: input.service_name, status: "REVOKED" }),
        metadata: {
          actor_role: actor?.role || null,
          cross_identity: actor?.kind === "root_admin" ? true : gate.crossIdentity,
          allow_cross_identity: input.allow_cross_identity,
          reason: input.reason || null,
        },
      });
      return { status: "ok", agent_id: input.agent_id, service_name: input.service_name, cross_identity: gate.crossIdentity };
    }),

  // ==========================================================================
  // 7. addService - 动态加新服务 (管理员操作)
  // 评审 P0-3: 改用 adminProcedure + 独立 MIND_ADMIN_API_KEY (跟 mcp 端 SERVER_ADMIN_KEY 对齐)
  // ==========================================================================
  addService: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        name: z.string().regex(SERVICE_NAME_REGEX, "name must be snake_case (lowercase + underscore)"),
        display_name: z.string(),
        description: z.string(),
        endpoint: z.string().url(),
        health_url: z.string().url().optional(),
        version: z.string(),
        default_config: z.record(z.string(), z.any()).optional(),
        available_perms: z.array(z.string()),
      })
    ))
    .mutation(async ({ input }) => {
      return prisma.agentService.upsert({
        where: { name: input.name },
        create: {
          name: input.name,
          display_name: input.display_name,
          description: input.description,
          endpoint: input.endpoint,
          health_url: input.health_url,
          version: input.version,
          default_config: safeJsonStringify(input.default_config),
          available_perms: safeJsonStringify(input.available_perms),
          status: "ACTIVE",
          enabled: true,
        },
        update: {
          display_name: input.display_name,
          description: input.description,
          endpoint: input.endpoint,
          health_url: input.health_url,
          version: input.version,
          default_config: safeJsonStringify(input.default_config),
          available_perms: safeJsonStringify(input.available_perms),
          status: "ACTIVE",
          enabled: true,
          updated_at: new Date(),
        },
      });
    }),

  // ==========================================================================
  // 8. removeService - 动态删服务 (软删, 置 enabled=false)
  // 评审 P0-3: 改用 adminProcedure
  // ==========================================================================
  removeService: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({ name: z.string() })
    ))
    .mutation(async ({ input }) => {
      return prisma.agentService.update({
        where: { name: input.name },
        data: { enabled: false, status: "DEPRECATED", updated_at: new Date() },
      });
    }),

  // ==========================================================================
  // 9. repair-services - 补齐历史 partial 注册 (评审 P0-1 必答)
  // 用法: admin 发现 agent 有 partial 状态 (历史 register 时 service 失败)
  //       → 调本端点, 重试该 agent 所有 status=ACTIVE 但没拿到 apiKey 的 service
  // 准入: adminProcedure (跟 addService 同权)
  // ==========================================================================
  repairServices: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX),
        // 可选: 只修某些 service, 不传 = 修该 agent 所有 service
        service_names: z.array(z.string()).optional(),
      })
    ))
    .mutation(async ({ input }) => {
      const agent = await prisma.agentRegistry.findUnique({
        where: { agent_id: input.agent_id },
        include: {
          permissions: {
            where: { status: "ACTIVE" },
            include: { service: true },
          },
        },
      });
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: `agent ${input.agent_id} not found` });
      }

      const servicesToRepair = input.service_names
        ? agent.permissions.filter(p => input.service_names!.includes(p.service_name))
        : agent.permissions;

      const repaired: Record<string, any> = {};
      for (const perm of servicesToRepair) {
        // 2026-10-15 钥匙治理(item 2/3): 走单一实现 —— 90 天 TTL + 明文 1 小时窗口 + 审计(此前本端点零审计)
        const res = await issueBusinessKeysForAgent({
          agentId: input.agent_id,
          serviceNames: [perm.service_name],
          actor: "console-admin",
          actorType: "admin_key",
          reuseWhenPossible: false,
          allowRevokedRevival: true,
        });
        const entry = res[perm.service_name];
        if (!entry || entry.status !== "issued" || !entry.api_key) {
          repaired[perm.service_name] = { status: "failed", error: entry?.error || "repair failed" };
          continue;
        }
        repaired[perm.service_name] = {
          status: "repaired",
          api_key: entry.api_key,
          token_id: entry.token_id,
          endpoint: perm.service.endpoint,
          expires_at: entry.expires_at,
        };
      }
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "REPAIR_SERVICES",
        actor: "console-admin", actorType: "admin_key",
        before: null,
        after: JSON.stringify({ services: Object.keys(repaired), ok: Object.values(repaired).filter((r: any) => r.status === "repaired").length }),
        metadata: { ttl_days: BUSINESS_KEY_TTL_DAYS, plaintext_cache_seconds: 3600, requested: input.service_names || null },
      });

      return {
        status: "ok",
        agent_id: input.agent_id,
        repaired_at: new Date().toISOString(),
        business_key_ttl_days: BUSINESS_KEY_TTL_DAYS,
        services: repaired,
      };
    }),

  // ==========================================================================
  // 10. bulkImport - 注册成功→全量同步记忆/知识/反思
  // 2026-06-17 P3 修复: 注册成功第一件事是 push 自己的全部数据
  // 设计:
  //   - 一次调用, 传 memories/knowledge/reflections/practices 数组
  //   - 服务端按 contentHash 去重 (同 agent + 同 hash 跳过)
  //   - 写入时强制带 agentSource=ctx.agent.agent_id
  //   - 返回 inserted/skipped/duplicated 计数, 客户端可自检
  //   - 限频: 单次最多 1000 条/类型, 超过请分批
  // ==========================================================================
  bulkImport: protectedProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        memories: z.array(z.object({
          content: z.string().min(1),
          title: z.string().optional(),
          tier: z.enum(["HOT", "WARM", "COLD"]).default("WARM"),
          type: z.string().optional(),
          tags: z.string().optional(),
          domain: z.string().optional(),
          importance: z.number().min(0).max(1).optional(),
          valueScore: z.number().min(0).max(1).optional(),
          sourceType: z.string().optional(),
          sourceId: z.string().optional(),
          filePath: z.string().optional(),
          // 客户端给的 hash, 优先用 (避免重算)
          contentHash: z.string().optional(),
        })).max(1000).default([]),
        knowledge: z.array(z.object({
          title: z.string().min(1),
          content: z.string().min(1),
          category: z.string().optional(),
          tags: z.string().optional(),
          confidence: z.number().min(0).max(1).optional(),
          sourceType: z.string().optional(),
          sourceId: z.string().optional(),
          sourceDetail: z.string().optional(),
          filePath: z.string().optional(),
        })).max(1000).default([]),
        reflections: z.array(z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          category: z.string().optional(),
          priority: z.string().optional(),
          lesson: z.string().optional(),
          improvements: z.string().optional(),
          insight: z.string().optional(),
          score: z.number().min(0).max(1).optional(),
          sourceType: z.string().optional(),
          sourceId: z.string().optional(),
        })).max(1000).default([]),
        practices: z.array(z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          type: z.string(),
          outcome: z.string(),
          qualityScore: z.number().min(0).max(1).optional(),
          difficulty: z.number().min(0).max(1).optional(),
          duration: z.number().optional(),
          startedAt: z.string().optional(),  // ISO
          completedAt: z.string().optional(),
        })).max(1000).default([]),
        // 同步模式: full=全量替换, incremental=增量跳过已存在
        mode: z.enum(["full", "incremental"]).default("incremental"),
        // dry_run=true 只统计不写入, 用于联调
        dry_run: z.boolean().default(false),
      })
    ))
    .mutation(async ({ ctx, input }) => {
      const agentId = ctx.agent.agent_id;
      const startTime = Date.now();
      const result: Record<string, any> = {
        agent_id: agentId,
        mode: input.mode,
        dry_run: input.dry_run,
        memories: { total: input.memories.length, inserted: 0, skipped: 0, errors: [] as string[] },
        knowledge: { total: input.knowledge.length, inserted: 0, skipped: 0, errors: [] as string[] },
        reflections: { total: input.reflections.length, inserted: 0, skipped: 0, errors: [] as string[] },
        practices: { total: input.practices.length, inserted: 0, skipped: 0, errors: [] as string[] },
      };

      // ==== memories ====
      for (const m of input.memories) {
        try {
          const contentHash = m.contentHash || createHash("sha256").update(m.content, "utf-8").digest("hex");
          // 去重: 同 agent + 同 contentHash 已存在 → skip
          const existing = await ctx.prisma.memory.findFirst({
            where: { agentSource: agentId, contentHash },
            select: { id: true },
          });
          if (existing) {
            result.memories.skipped++;
            continue;
          }
          if (input.dry_run) {
            result.memories.inserted++;
            continue;
          }
          // round 57 G4(2026-10-10): 长标题语义已由 round58 裁决为归一 -> 原豁免条件消失, 迁 safeCreateMemory.
          const _mem = await safeCreateMemory(ctx.prisma, {
            data: {
              content: m.content,
              title: m.title,
              tier: m.tier,
              type: m.type,
              tags: m.tags,
              // 2026-10-07: agent 提交的 domain 是自由文本 -> 过投影(否则与 LLM 直出同源污染 D1)
              domain: projectDomain(m.domain, { title: m.title, content: m.content, theme: (m as any).theme }),
              // 2026-10-07: 本路径原先漏写质量分 -> 落库即 0 分(列默认 0), 产物隐形于质量读数
              qualityScore: calcQualityScore({ type: "memory", content: m.content, title: m.title, theme: (m as any).theme, tags: m.tags, valueScore: m.valueScore ?? 0.5 }),
              importance: m.importance ?? 0.5,
              valueScore: m.valueScore ?? 0.5,
              sourceType: m.sourceType,
              sourceId: m.sourceId,
              filePath: m.filePath,
              agentSource: agentId,
              contentHash,
              migrated: false,
            },
          });
          if (!_mem) { console.warn("[agent.ingest] Memory 被 store 内容闸拒绝(不合规), 跳过"); continue; }
          result.memories.inserted++;
        } catch (e: any) {
          result.memories.errors.push(e.message?.slice(0, 100) || "unknown");
        }
      }

      // ==== knowledge ====
      for (const k of input.knowledge) {
        try {
          // 知识按 title + agentSource 去重
          const existing = await ctx.prisma.knowledge.findFirst({
            where: { title: k.title, agentSource: agentId },
            select: { id: true },
          });
          if (existing) {
            result.knowledge.skipped++;
            continue;
          }
          if (input.dry_run) {
            result.knowledge.inserted++;
            continue;
          }
          await safeCreateKnowledge(ctx.prisma, {
            data: {
              title: k.title,
              content: k.content,
              category: projectCategory(k.category, "knowledge") ?? "OTHER", // 2026-10-08 round 54
              tags: k.tags,
              confidence: k.confidence ?? 0.5,
              sourceType: k.sourceType,
              sourceId: k.sourceId,
              sourceDetail: k.sourceDetail,
              filePath: k.filePath,
              agentSource: agentId,
            },
          });
          result.knowledge.inserted++;
        } catch (e: any) {
          result.knowledge.errors.push(e.message?.slice(0, 100) || "unknown");
        }
      }

      // ==== reflections ====
      for (const r of input.reflections) {
        try {
          const existing = await ctx.prisma.reflection.findFirst({
            where: { title: r.title, agentSource: agentId },
            select: { id: true },
          });
          if (existing) {
            result.reflections.skipped++;
            continue;
          }
          if (input.dry_run) {
            result.reflections.inserted++;
            continue;
          }
          await safeCreateReflection(ctx.prisma, {
            data: {
              title: r.title,
              description: r.description,
              category: r.category,
              priority: r.priority,
              lesson: r.lesson,
              improvements: r.improvements,
              insight: r.insight,
              score: r.score,
              sourceType: r.sourceType,
              sourceId: r.sourceId,
              agentSource: agentId,
            },
          });
          result.reflections.inserted++;
        } catch (e: any) {
          result.reflections.errors.push(e.message?.slice(0, 100) || "unknown");
        }
      }

      // ==== practices ====
      for (const p of input.practices) {
        try {
          // practice 按 title + startedAt 去重 (Practice 模型暂不支持 agentSource 字段)
          const existing = await ctx.prisma.practice.findFirst({
            where: {
              title: p.title,
              ...(p.startedAt ? { startedAt: new Date(p.startedAt) } : {}),
            },
            select: { id: true },
          });
          if (existing) {
            result.practices.skipped++;
            continue;
          }
          if (input.dry_run) {
            result.practices.inserted++;
            continue;
          }
          await safeCreatePractice(ctx.prisma, {
            data: {
              title: p.title,
              description: p.description,
              type: p.type,
              // 2026-10-07: agent 提交的 outcome 是自由文本 -> 过投影(与抽取器同口径)
              outcome: projectPracticeOutcome(p.outcome),
              qualityScore: p.qualityScore,
              difficulty: p.difficulty,
              duration: p.duration,
              startedAt: p.startedAt ? new Date(p.startedAt) : new Date(),
              completedAt: p.completedAt ? new Date(p.completedAt) : null,
            },
          });
          result.practices.inserted++;
        } catch (e: any) {
          result.practices.errors.push(e.message?.slice(0, 100) || "unknown");
        }
      }

      const totalInserted = result.memories.inserted + result.knowledge.inserted +
        result.reflections.inserted + result.practices.inserted;
      const totalSkipped = result.memories.skipped + result.knowledge.skipped +
        result.reflections.skipped + result.practices.skipped;

      result.duration_ms = Date.now() - startTime;
      result.summary = {
        total_inserted: totalInserted,
        total_skipped: totalSkipped,
        total_errors: result.memories.errors.length + result.knowledge.errors.length +
          result.reflections.errors.length + result.practices.errors.length,
      };
      return result;
    }),

  // ==========================================================================
  // 8. grantApiKey - 管理员用, 强制重发明文 api_key (P0-B23)
  //   鉴权: adminProcedure (MIND_ADMIN_API_KEY)
  //   业务场景: 13/morning 等 agent 首次 onboard 拿到占位符 (没存明文) 后,
  //     可立刻调这个端点重发明文 + 存 DB, 后续 register 走幂等也能返
  //   安全门:
  //     - adminProcedure 鉴权 (MIND_ADMIN_API_KEY)
  //     - agent_id 必须在 PERMANENT_AGENT_WHITELIST (避免给陌生 agent 发)
  //     - 返回的明文只在本次响应里出现, 客户端必须立即落盘
  //   行为:
  //     - 生成新 apiKey (跟 register 同样的格式 sk-mind-{32hex})
  //     - 更新 AgentServicePermission (api_key_hash + api_key_plain + token_id + expires_at)
  //     - 不影响其他 service perm
  // ==========================================================================
  grantApiKey: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        service_name: z.string().regex(SERVICE_NAME_REGEX, "service_name must be snake_case"),
        // 2026-10-15: 100 年"永久"档已取消 —— 该参数被**忽略**并在响应/审计里标注(deprecations),
        //   保留它只为不打断既有调用方(传 true 不再报错, 也不再产生永久钥匙)。
        permanent: z.boolean().default(false),
      }),
    ))
    .mutation(async ({ input }) => {
      // 安全门 1: agent_id 必须在白名单 (跟 register 一致)
      if (!PERMANENT_AGENT_WHITELIST.has(input.agent_id)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `agent_id "${input.agent_id}" not in PERMANENT_AGENT_WHITELIST. grantApiKey only for known agents.`,
        });
      }

      // 安全门 2: service_name 必须在 AgentService 表存在
      const meta = await prisma.agentService.findUnique({
        where: { name: input.service_name },
      });
      if (!meta) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `service "${input.service_name}" not found in AgentService table`,
        });
      }

      // 查现有 perm
      const existing = await prisma.agentServicePermission.findUnique({
        where: {
          agent_id_service_name: {
            agent_id: input.agent_id,
            service_name: input.service_name,
          },
        },
      });

      // 2026-10-15 钥匙治理(item 2/3): 单一实现 —— 90 天 TTL + 明文 1 小时窗口(不再长期明文落库)+ 审计。
      //   本端点语义 = 管理员"重发明文"(紧急恢复用), 所以必须轮换密钥。
      const issued = await issueBusinessKeysForAgent({
        agentId: input.agent_id,
        serviceNames: [input.service_name],
        actor: "console-admin",
        actorType: "admin_key",
        reuseWhenPossible: false,
        allowRevokedRevival: true,
      });
      const entry = issued[input.service_name];
      if (!entry || entry.status !== "issued" || !entry.api_key) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: entry?.error || "grantApiKey failed" });
      }
      const newApiKey = entry.api_key;

      // 审计: 管理员重发明文 key (敏感操作)
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "GRANT_API_KEY",
        actor: "console-admin", actorType: "admin_key",
        before: existing ? JSON.stringify({ service_name: input.service_name, status: existing.status, expires_at: new Date(existing.expires_at).toISOString(), key_fp: existing.api_key_hash.slice(0, 8) }) : null,
        after: JSON.stringify({ service_name: input.service_name, action: existing ? "reissued" : "created", expires_at: entry.expires_at, key_fp: entry.key_fp }),
        metadata: {
          ttl_type: `standard_${BUSINESS_KEY_TTL_DAYS}d`,
          ttl_days: BUSINESS_KEY_TTL_DAYS,
          permanent_requested: input.permanent === true,
          permanent_downgraded: input.permanent === true,
          plaintext_cache_seconds: 3600,
        },
      });

      return {
        status: "ok",
        action: existing ? "reissued" : "created",
        agent_id: input.agent_id,
        service_name: input.service_name,
        // 关键: 明文只在响应里出现一次
        api_key: newApiKey,
        api_key_prefix: newApiKey.slice(0, 14) + "...",
        token_id: entry.token_id,
        endpoint: meta.endpoint,
        expires_at: entry.expires_at,
        ttl_days: BUSINESS_KEY_TTL_DAYS,
        ttl_hours: Math.floor(businessKeyTtlMs() / 3600000),
        ttl_type: `standard_${BUSINESS_KEY_TTL_DAYS}d`,
        permanent: false,
        deprecations: input.permanent === true
          ? [`permanent=true 已取消(2026-10-15 钥匙治理): 本次按 ${BUSINESS_KEY_TTL_DAYS} 天签发`]
          : [],
        next_steps: {
          step_1: "立即落盘到 ~/.config/agent-{agent_id}/{service_name}.env (mode 0600)",
          step_2: "明文只在库内**缓存 1 小时**(幂等重发用), 之后自动清空; 业务鉴权始终只查 hash",
          step_3: `业务钥匙 ${BUSINESS_KEY_TTL_DAYS} 天有效; 到期前窗口内平台自动续期(不换密钥值); 主动轮换走 refresh-service-key`,
        },
      };
    }),

  // ==========================================================================
  // 11. transferData - AI 离开/接手: 数据继承 (agentSource 迁移) (P2-B 2026-09-01)
  //   业务: 原 agent 离开 (status=REVOKED) → 其 5 表认知数据迁移到新 agent
  //   安全:
  //     - 默认 dryRun=true (预览影响行数, 不执行)
  //     - 执行需 fromAgent status=REVOKED (数据归属已清) 或 force=true
  //     - 迁移前记一条 FlywheelEvent (审计)
  //   表: Memory/Knowledge/Reflection 有 agentSource; Practice 无 agentSource 列
  //       (Practice 按 sourceId/主题匹配, 暂不迁移, 由飞轮重新提取)
  // ==========================================================================
  transferData: adminProcedure
    .input(z.preprocess(
      (val: any) => {
        if (val && typeof val === "object" && "json" in val && typeof val.json === "object") return val.json;
        return val;
      },
      z.object({
        fromAgentId: z.string().regex(AGENT_ID_REGEX),
        toAgentId: z.string().regex(AGENT_ID_REGEX),
        dryRun: z.boolean().default(true),
        force: z.boolean().default(false),
      })
    ))
    .mutation(async ({ input }) => {
      const { fromAgentId, toAgentId, dryRun, force } = input;
      if (fromAgentId === toAgentId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "fromAgentId 不能等于 toAgentId" });
      }

      // 原 agent 必须存在
      const from = await prisma.agentRegistry.findUnique({ where: { agent_id: fromAgentId } });
      if (!from) throw new TRPCError({ code: "NOT_FOUND", message: `${fromAgentId} not found` });
      if (from.status !== "REVOKED" && !force) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `${fromAgentId} 状态为 ${from.status}, 需先 revoke 或用 force=true`,
        });
      }

      // 预览: 各表 fromAgent 的记录数
      const tables = ["Memory", "Knowledge", "Reflection"] as const;
      const counts: Record<string, number> = {};
      const p = prisma as any;
      for (const t of tables) {
        const modelName = t.charAt(0).toLowerCase() + t.slice(1);
        const r = await p[modelName].count({ where: { agentSource: fromAgentId } });
        counts[t] = r;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);

      if (dryRun) {
        return { status: "preview", dryRun: true, fromAgentId, toAgentId, counts, total,
                 note: "仅预览, 传 dryRun=false 执行 (需 fromAgent 已 REVOKED)" };
      }

      // 执行: agentSource 迁移
      const moved: Record<string, number> = {};
      for (const t of tables) {
        const modelName = t.charAt(0).toLowerCase() + t.slice(1);
        const r = await p[modelName].updateMany({
          where: { agentSource: fromAgentId },
          data: { agentSource: toAgentId },
        });
        moved[t] = r.count;
      }

      // 审计事件
      try {
        await prisma.flywheelEvent.create({
          data: {
            stage: "AGENT_TRANSFER",
            sourceType: "admin",
            sourceId: fromAgentId,
            sourceTitle: `transfer to ${toAgentId}: ${JSON.stringify(moved)}`,
            targetStage: "DONE",
          },
        });
      } catch { /* 审计失败不阻塞 */ }

      return { status: "done", dryRun: false, fromAgentId, toAgentId, moved, total: Object.values(moved).reduce((a, b) => a + b, 0) };
    }),

  // ============================================================================
  // 2026-09-02: Agent 注册审批流 (双模式接入)
  //   portal 自助注册 → status=PENDING → 管理员在 console approve → ACTIVE + 发密钥
  // ============================================================================
  pendingList: adminProcedure.query(async () => {
    const rows = await prisma.$queryRawUnsafe<Array<any>>(`
      SELECT agent_id, display_name, channel, host, profile, created_at, updated_at,
             CASE WHEN token_hash IS NOT NULL AND token_hash != '' THEN 1 ELSE 0 END as has_key
      FROM AgentRegistry WHERE status = 'PENDING' ORDER BY created_at DESC
    `).catch(() => []);
    return rows.map((r) => ({
      agent_id: r.agent_id,
      display_name: r.display_name,
      channel: r.channel,
      host: r.host,
      profile: safeJsonParse(r.profile, null),
      created_at: r.created_at,
      has_key: !!r.has_key,
    }));
  }),

  approve: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        // 可选: 审批时指定给哪些服务发 key (默认全部 ACTIVE 服务, 且跳过 test_* 测试服务)
        services: z.array(z.object({ name: z.string() })).optional(),
      }),
    ))
    .mutation(async ({ input }) => {
      const agent = await prisma.agentRegistry.findUnique({ where: { agent_id: input.agent_id } });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: `${input.agent_id} not found` });
      if (agent.status !== "PENDING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `agent status=${agent.status}, only PENDING can be approved` });
      }
      // 1. 置 ACTIVE
      await prisma.$executeRawUnsafe(
        "UPDATE AgentRegistry SET status='ACTIVE', updated_at=? WHERE agent_id=?",
        new Date(), input.agent_id
      );
      // 2. item 1: 审批**不再直发长期业务钥匙**, 只发一张一次性领取券(15 分钟)
      //    (默认全部 ACTIVE 服务, 但跳过 test_* 测试服务 —— item 6 的机制判据)
      const allServices = await prisma.agentService.findMany({ where: { enabled: true, status: "ACTIVE" } });
      const wanted = input.services !== undefined ? new Set(input.services.map((s) => s.name)) : null;
      const toGrant = input.services !== undefined
        ? allServices.filter((s) => wanted!.has(s.name))
        : allServices.filter((s) => !NON_DEFAULT_SERVICE_RE.test(s.name));
      const ticket = await issueClaimTicket({
        agentId: input.agent_id,
        services: toGrant.map((s) => s.name),
        actor: "console-admin",
        actorType: "admin_key",
        reason: "approve",
      });
      // 审计: 审批通过 (PENDING → ACTIVE + 发领取券), 长期保留供审计
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "APPROVE",
        actor: "console-admin", actorType: "admin_key",
        before: JSON.stringify({ status: "PENDING" }),
        after: JSON.stringify({ status: "ACTIVE", claim_ticket: { hash8: ticket.hash8, expires_at: ticket.expires_at, services: ticket.services } }),
        metadata: { granted_count: 0, claim_ticket_issued: true, ticket_hash8: ticket.hash8, ticket_ttl_seconds: ticket.ttl_seconds, business_key_ttl_days: BUSINESS_KEY_TTL_DAYS, services: ticket.services },
      });
      return {
        status: "approved",
        agent_id: input.agent_id,
        // 兼容旧字段名: 以前这里是 granted[](每服务一把长期 key); 现在是**一张券**
        granted: [],
        claim_ticket: {
          value: ticket.ticket,
          hash8: ticket.hash8,
          expires_at: ticket.expires_at,
          ttl_seconds: ticket.ttl_seconds,
          services: ticket.services,
          warning: "一次性: 换取后立即作废; 明文只出现一次, 请立即交给该 agent 落盘(0600)。",
          redeem: { method: "POST", url: "/api/v1/agent/claim-service-key", body: { agent_id: input.agent_id, ticket: "<上面这个 value>" } },
        },
        business_key_ttl_days: BUSINESS_KEY_TTL_DAYS,
        note: "审批只发领取券; 业务钥匙(90 天)在换取时签发",
      };
    }),

  reject: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({ agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case") }),
    ))
    .mutation(async ({ input }) => {
      const agent = await prisma.agentRegistry.findUnique({ where: { agent_id: input.agent_id } });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: `${input.agent_id} not found` });
      await prisma.$executeRawUnsafe(
        "UPDATE AgentRegistry SET status='INACTIVE', updated_at=? WHERE agent_id=?",
        new Date(), input.agent_id
      );
      // 审计: 拒绝注册 (PENDING → INACTIVE)
      await recordAudit({
        entityType: "AGENT", entityId: input.agent_id,
        action: "REJECT",
        actor: "console-admin", actorType: "admin_key",
        before: JSON.stringify({ status: "PENDING" }),
        after: JSON.stringify({ status: "INACTIVE" }),
        metadata: {},
      });
      return { status: "rejected", agent_id: input.agent_id };
    }),

  // ==========================================================================
  // 2026-09-03: 审计日志查询 (审批记录/操作日志 — 长期保留, 供审计)
  //   鉴权: adminProcedure (console 用 x-admin-key 调)
  //   实体: entityType=AGENT, action ∈ REGISTER_REQUEST/REGISTER_ACTIVE/APPROVE/REJECT/REVOKE/GRANT_API_KEY
  // ==========================================================================
  auditList: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        entityType: z.string().default("AGENT"),
        agent_id: z.string().optional(),
        action: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    ))
    .query(async ({ input }) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (input.entityType) { conds.push("entityType = ?"); params.push(input.entityType); }
      if (input.agent_id) { conds.push("entityId = ?"); params.push(input.agent_id); }
      if (input.action) { conds.push("action = ?"); params.push(input.action); }
      const whereSql = conds.length ? "WHERE " + conds.join(" AND ") : "";
      params.push(input.limit);
      const rows = await prisma.$queryRawUnsafe<Array<any>>(
        `SELECT id, entityType, entityId, action, actor, actorType, before, after, metadata, createdAt
         FROM AuditLog ${whereSql} ORDER BY createdAt DESC LIMIT ?`,
        ...params
      ).catch((e: any) => {
        console.error("[auditList] query failed:", e?.message || e);
        return [];
      });
      return rows.map((r) => ({
        id: r.id,
        entity_type: r.entityType,
        entity_id: r.entityId,
        action: r.action,
        actor: r.actor,
        actor_type: r.actorType,
        before: r.before ? safeJsonParse(r.before, null) : null,
        after: r.after ? safeJsonParse(r.after, null) : null,
        metadata: r.metadata ? safeJsonParse(r.metadata, null) : null,
        created_at: r.createdAt,
      }));
    }),

  // ==========================================================================
  // 2026-10-15 钥匙治理 item 1: 用一次性领取券换正式业务钥匙
  //   鉴权: publicProcedure —— 调用者此刻**还没有**任何业务钥匙(这正是本端点的用途),
  //         凭据就是券本身(`sk-claim-<64hex>`, 一次性 + 绑定 agent_id + 默认 15 分钟)。
  //   一次性保证: 换取时用 `UPDATE AgentRegistry ... WHERE profile=<换取前整串>` 做 CAS,
  //     并发第二次必然 0 行 -> 409 CONFLICT(券仍有效, 可重试); 换取成功后券立即作废。
  //   返回: 每个服务的正式业务钥匙(90 天) + endpoint + 到期时间。明文只出现这一次。
  // ==========================================================================
  claimServiceKey: publicProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        ticket: z.string().min(16).max(200),
        // 默认 true: 对已有且明文可读的 ACTIVE 钥匙沿用, 不轮换(不打断在跑的客户端)
        reuse_existing: z.boolean().default(true),
      }),
    ))
    .mutation(async ({ input }) => {
      const res = await redeemClaimTicket({
        agentId: input.agent_id,
        ticket: input.ticket,
        actor: input.agent_id,
        actorType: "agent_self",
        reuseWhenPossible: input.reuse_existing,
      });
      if (!res.ok) {
        if (res.code === "NOT_FOUND") throw new TRPCError({ code: "NOT_FOUND", message: res.message });
        if (res.code === "CONFLICT") throw new TRPCError({ code: "CONFLICT", message: res.message });
        throw new TRPCError({ code: "FORBIDDEN", message: res.message });
      }
      const services: Record<string, any> = {};
      for (const [name, v] of Object.entries(res.services)) {
        services[name] = {
          status: v.status,
          api_key: v.api_key,
          token_id: v.token_id,
          endpoint: v.endpoint,
          expires_at: v.expires_at,
          permissions: v.permissions,
          key_fp: v.key_fp,
          error: v.error,
        };
      }
      return {
        status: "ok",
        agent_id: res.agent_id,
        ticket_hash8: res.ticket_hash8,
        redeemed_at: res.redeemed_at,
        business_key_ttl_days: res.business_key_ttl_days,
        services,
        next_steps: {
          step_1: "立即把 services[*].api_key 落盘(mode 0600) —— 明文只出现这一次",
          step_2: "券已作废(一次性), 再次调用会被拒; 需要更多服务请管理员重新签发",
          step_3: "此后 90 天内有效; 到期前平台自动续期, 主动轮换走 POST /api/v1/agent/refresh-service-key",
        },
      };
    }),

  // ==========================================================================
  // 2026-10-15 钥匙治理 item 1: 管理员给**已存在**的身份重新签发一张领取券
  //   用途: 换机/重装/丢 key(登记表里没有明文可读的 key 时), 不再需要把长期钥匙人工下发。
  //   安全: adminProcedure; 不改变任何现有 ACTIVE 钥匙(只写券), 所以不会打断在跑的客户端。
  // ==========================================================================
  issueClaimTicketForAgent: adminProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        agent_id: z.string().regex(AGENT_ID_REGEX, "agent_id must be kebab-case"),
        // 不传 = 该 agent 当前所有 ACTIVE 服务(默认; 跳过 test_*)
        services: z.array(z.string()).optional(),
        reason: z.string().max(200).optional(),
      }),
    ))
    .mutation(async ({ input }) => {
      const agent = await prisma.agentRegistry.findUnique({ where: { agent_id: input.agent_id } });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: `${input.agent_id} not found` });
      if (agent.status !== "ACTIVE") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `agent status=${agent.status}, 只有 ACTIVE 身份可签发领取券` });
      }
      let services = input.services;
      if (!services) {
        const perms = await prisma.agentServicePermission.findMany({ where: { agent_id: input.agent_id, status: "ACTIVE" } });
        services = perms.map((p) => p.service_name).filter((n) => !NON_DEFAULT_SERVICE_RE.test(n));
      }
      // 只保留真实存在且启用的服务(其余显式报错, 不静默丢)
      const available = await prisma.agentService.findMany({ where: { enabled: true, status: "ACTIVE" }, select: { name: true } });
      const availableNames = new Set(available.map((s) => s.name));
      const unknown = services.filter((n) => !availableNames.has(n));
      const usable = services.filter((n) => availableNames.has(n));
      if (usable.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `没有可签发的服务(不存在/未启用: ${unknown.join(", ") || "无"})` });
      }
      const t = await issueClaimTicket({
        agentId: input.agent_id,
        services: usable,
        actor: "console-admin",
        actorType: "admin_key",
        reason: input.reason || "admin_reissue",
      });
      return {
        status: "ok",
        agent_id: input.agent_id,
        claim_ticket: {
          value: t.ticket,
          hash8: t.hash8,
          expires_at: t.expires_at,
          ttl_seconds: t.ttl_seconds,
          services: t.services,
          warning: "一次性: 换取后立即作废; 明文只出现一次",
          redeem: { method: "POST", url: "/api/v1/agent/claim-service-key", body: { agent_id: input.agent_id, ticket: "<上面这个 value>" } },
        },
        skipped_unknown_services: unknown,
        business_key_ttl_days: BUSINESS_KEY_TTL_DAYS,
        note: "只写领取券, 不改动任何现有 ACTIVE 钥匙(在跑的客户端不受影响); 换取时默认沿用可读明文",
      };
    }),

  // ==========================================================================
  // 2026-10-15 钥匙治理 item 2/3: 到期收口(翻 EXPIRED + 清过期明文 + 券过期)
  //   鉴权: adminProcedure。可被 curl 或定时器调用(部署步骤里给出 timer 建议; 本轮不碰 systemd/crontab)。
  // ==========================================================================
  expireStaleKeys: adminProcedure
    .input(z.object({ include_legacy_plain: z.boolean().default(false) }).default({ include_legacy_plain: false }))
    .mutation(async ({ input }) => {
      const r = await expireStaleKeys({ includeLegacyPlain: input.include_legacy_plain, actor: "console-admin", actorType: "admin_key" });
      return { status: "ok", ...r, include_legacy_plain: input.include_legacy_plain };
    }),
});
