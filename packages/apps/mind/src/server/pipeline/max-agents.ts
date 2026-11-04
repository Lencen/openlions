/**
 * max-agents.ts — maxAgents 授权上限判定（2026-10-27，S2 矩阵）
 *
 * 口径（商业化线拍板）：
 *   - **近 24h 有心跳的活跃 agent** 计入上限；注册总数只展示、不用历史注册永久占额度；
 *   - 超限**拒绝并带 reason {active, limit}**，不静默降级；
 *   - 已在活跃集合里的 agent **不受影响**（否则一旦满额，现有 agent 会互相踢下线）。
 *
 * 诚实边界：本平台无鉴权，"活跃"按 `AgentRegistry.last_seen_at` 判断，
 *   伪造心跳即可规避——本门消除的是**无意识超用**，不是防攻击。
 */
import { prisma } from "@/lib/prisma";
import { licenseStatus } from "@/lib/license";

export type MaxAgentsVerdict =
  | { ok: true; active: number; limit: number | null; reason: string }
  | { ok: false; active: number; limit: number; reason: string; code: "MAX_AGENTS_EXCEEDED" };

const ACTIVE_WINDOW_HOURS = 24;

/** 从 license 取 maxAgents（platform.maxAgents）；无 license/无上限返回 null */
export function licensedMaxAgents(): number | null {
  const st = licenseStatus();
  const m = st.payload && st.payload.platform ? (st.payload.platform as any).maxAgents : null;
  const n = Number(m);
  const licensed = Number.isFinite(n) && n > 0 ? n : null;

  // 2026-10-27（平台数据线要求）: **测试专用**低限覆盖，用于打通"超限 402"的负向 E2E。
  //   为什么不造测试 license：那要动私有签名 key，等于伪造授权（明确不做）。
  //   安全约束：必须同时给两个变量才生效，且每次生效都打 WARN，便于审计时发现；
  //   生产环境不应设置这两个变量。这是"最小可见的测试钩子"，不是生产绕过通道。
  const ov = Number(process.env.LIONS_MAX_AGENTS_TEST_OVERRIDE);
  // 2026-10-27（平台数据线要求）: **生产不可误开**。
  //   NODE_ENV=production 时若检测到测试钩子 → **报警并忽略覆盖**（不退出进程，避免把生产打挂；
  //   但绝不生效）。生产误设的后果是"上限被压到 1"，那会拦掉所有新 agent，比不生效危险得多。
  // 第三个开关：显式允许"在 NODE_ENV=production 的**测试实例**上使用"（如隔离库边界测试）。
  //   注意 `next start` 本身就会设 NODE_ENV=production，所以仅靠 NODE_ENV 无法区分"生产"与"测试实例"。
  //   因此要求**三个显式变量**同时存在才生效：TEST_ACK + TEST_OVERRIDE + TEST_ALLOW_PROD。
  const allowInProd = process.env.LIONS_MAX_AGENTS_TEST_ALLOW_PROD === "1";
  if (process.env.LIONS_MAX_AGENTS_TEST_ACK === "1" && process.env.NODE_ENV === "production" && !allowInProd) {
    console.error("[max-agents] CRITICAL 生产环境检测到 LIONS_MAX_AGENTS_TEST_ACK=1 —— 测试钩子被忽略！" +
      "请立即移除该环境变量（LIONS_MAX_AGENTS_TEST_OVERRIDE=" + String(process.env.LIONS_MAX_AGENTS_TEST_OVERRIDE || "") + "）");
    return licensed;
  }
  if (process.env.LIONS_MAX_AGENTS_TEST_ACK === "1" && Number.isFinite(ov) && ov > 0) {
    console.warn("[max-agents] WARN 使用测试覆盖上限 " + ov + "（LIONS_MAX_AGENTS_TEST_OVERRIDE）；仅限测试环境");
    return ov;
  }
  return licensed;
}

/**
 * 判定某个 agent 是否还能"新占用"一个名额。
 * @param agentId 本次要操作的 agent
 * @param opts.force 跳过缓存读 license（默认 false）
 */
export async function checkMaxAgents(agentId: string, opts?: { force?: boolean }): Promise<MaxAgentsVerdict> {
  const st = licenseStatus(opts?.force === true);
  const limit = licensedMaxAgents();

  // 开发模式（未要求 license）或无上限：放行但给出读数，便于观测。
  if (!st.required || limit === null) {
    const active = await countActiveAgents();
    return { ok: true, active, limit, reason: limit === null ? "未设置 maxAgents 上限" : "开发模式放行" };
  }

  const activeIds = await activeAgentIds();
  return decideMaxAgents({ active: activeIds.size, limit, isExisting: activeIds.has(String(agentId)) });
}

/**
 * 原子占席（平台数据线批准的修法 (b)）:
 *   在一个事务里 `pg_advisory_xact_lock` 串行化"判活+占席"，再：
 *     - agent 已在活跃集 → touch last_seen_at，放行；
 *     - 活跃数 < limit → upsert 一行（登记活跃）并放行；
 *     - 否则拒绝。
 * 为什么必须原子：只做"claim 时 touch 活跃"（方案 a）不够——两个并发请求会在同一毫秒都读到 0。
 * 仅在"授权模式"下占席；开发模式不写库（避免本地无谓副作用）。
 */
export async function claimSeatAtomic(agentId: string, opts?: { force?: boolean }): Promise<MaxAgentsVerdict> {
  const st = licenseStatus(opts?.force === true);
  const limit = licensedMaxAgents();
  if (!st.required || limit === null) {
    const active = await countActiveAgents();
    return { ok: true, active, limit, reason: limit === null ? "未设置 maxAgents 上限" : "开发模式放行（不占席）" };
  }

  const aid = String(agentId);
  const window = ACTIVE_WINDOW_HOURS;
  // 单个事务：advisory lock → 统计 → 占席/放行。串行化点由 lock 保证。
  return await (prisma as any).$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('lions.max_agents'))");
    const rows: any[] = await tx.$queryRawUnsafe(
      'SELECT agent_id FROM "AgentRegistry" WHERE last_seen_at > now() - interval \'' + window + ' hours\''
    );
    const activeIds = new Set<string>((rows || []).map((r) => String(r.agent_id)));
    const active = activeIds.size;

    if (activeIds.has(aid)) {
      await tx.$executeRawUnsafe('UPDATE "AgentRegistry" SET last_seen_at = now(), updated_at = now() WHERE agent_id = $1', aid);
      return { ok: true, active, limit, reason: "该 agent 已在活跃集合内（已刷新心跳）" };
    }
    if (active >= limit) {
      return {
        ok: false, active, limit, code: "MAX_AGENTS_EXCEEDED" as const,
        reason: "活跃 agent 已达授权上限（active=" + active + " / limit=" + limit + "）；已在活跃集合内的 agent 不受影响；如需扩额请升级授权",
      };
    }
    // 占席：upsert（已存在但已过期心跳的 agent 直接复活）
    const id = "agentreg_" + Math.random().toString(36).slice(2, 12);
    await tx.$executeRawUnsafe(
      'INSERT INTO "AgentRegistry" (id, agent_id, display_name, channel, host, status, created_at, updated_at, last_seen_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6, now(), now(), now()) ' +
      'ON CONFLICT (agent_id) DO UPDATE SET last_seen_at = now(), updated_at = now()',
      id, aid, aid, "claim", "auto", "ACTIVE"
    );
    return { ok: true, active: active + 1, limit, reason: "已占席（active=" + (active + 1) + " / limit=" + limit + "）" };
  });
}

async function activeAgentIds(): Promise<Set<string>> {
  const rows: any[] = await (prisma as any).$queryRawUnsafe(
    'SELECT agent_id FROM "AgentRegistry" WHERE last_seen_at > now() - interval \'' + ACTIVE_WINDOW_HOURS + ' hours\''
  ).catch(() => []);
  const s = new Set<string>();
  for (const r of rows || []) if (r && r.agent_id) s.add(String(r.agent_id));
  return s;
}

async function countActiveAgents(): Promise<number> {
  return (await activeAgentIds()).size;
}


/**
 * 纯判定（无 IO，可单测）：给定活跃数与上限，判定"新占用名额"是否放行。
 * 边界：limit-1 放行、limit 拒绝（active >= limit）、limit+1 拒绝；已在集合内的放行。
 */
export function decideMaxAgents(input: { active: number; limit: number; isExisting: boolean }): MaxAgentsVerdict {
  const { active, limit, isExisting } = input;
  if (isExisting) return { ok: true, active, limit, reason: "该 agent 已在活跃集合内，不受上限影响" };
  if (active >= limit) {
    return {
      ok: false, active, limit, code: "MAX_AGENTS_EXCEEDED",
      reason: "活跃 agent 已达授权上限（active=" + active + " / limit=" + limit + "）；" +
        "已在活跃集合内的 agent 不受影响；如需扩额请升级授权",
    };
  }
  return { ok: true, active, limit, reason: "未达上限（active=" + active + " / limit=" + limit + "）" };
}

/** 自检：边界 limit-1 / limit / limit+1 + 已在集合内 + 上限=1 的退化情形 */
export function selftestMaxAgents(): number {
  const cases: Array<{ name: string; in: { active: number; limit: number; isExisting: boolean }; want: boolean }> = [
    { name: "limit-1 (active=9, limit=10) → 放行", in: { active: 9, limit: 10, isExisting: false }, want: true },
    { name: "limit   (active=10, limit=10) → 拒绝", in: { active: 10, limit: 10, isExisting: false }, want: false },
    { name: "limit+1 (active=11, limit=10) → 拒绝", in: { active: 11, limit: 10, isExisting: false }, want: false },
    { name: "满额但 agent 已在集合内 → 放行", in: { active: 10, limit: 10, isExisting: true }, want: true },
    { name: "退化 limit=1, active=0 → 放行", in: { active: 0, limit: 1, isExisting: false }, want: true },
    { name: "退化 limit=1, active=1 → 拒绝", in: { active: 1, limit: 1, isExisting: false }, want: false },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = decideMaxAgents(c.in).ok;
    const ok = got === c.want;
    console.log((ok ? "  ok   " : "  FAIL ") + c.name + "（got=" + got + "）");
    if (!ok) bad++;
  }
  console.log(bad === 0 ? "\nSELFTEST PASS (" + cases.length + " 例)" : "\nSELFTEST FAIL: " + bad);
  return bad === 0 ? 0 : 1;
}
