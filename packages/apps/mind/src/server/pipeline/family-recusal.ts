/**
 * family-recusal.ts — 同家族弱自证自核「透明披露」闸门 (2026-10-11)
 *
 * 依据(平台记忆, 可复算):
 *   Memory cmv2x8pf000iyrztjk (type=DECISION, SESSION_EXTRACT, score 16.62):
 *   「submitter 是 `agent:<agentName>`、当前 executor task.assignedAgent 是另一个 agent 时,
 *     虽然同 agent 家族但不同 agentId, 不算严格自证自核, 但 verdict 文本必须坦白说明并邀请 leader 覆写;
 *     只有 submitter=executor=你本人 agentId 才走严格 recusal 拒绝复核路径。」
 *
 * 现状(2026-10-11 实测, 见 docs/platform-logic/cmv2z9dsa007oo74gp-*.md):
 *   - 严格型(submitter==executor 同 agentId) 在 skill 层直接拒审, route 侧无代码闸门;
 *   - 弱型(同家族不同 agentId) 既无拒绝也无透明要求 —— 本模块补的就是「最小硬门禁」。
 *
 * 为什么放在 route: 锚点是文本属性, 抄写即可满足; 但「该披露却没披露」是可结构判定的
 *   (candidate.agentSource vs task.assignedAgent vs AgentRegistry.host)。与既有
 *   evidencePreflight / claimed-edits 闸门同一模式: 结单前判定, 不过则 422 拒绝置 DONE。
 *
 * 与严格 recusal 的边界: 弱型**不禁止**复核(平台需要有人干活), 只要求「坦白 + 邀请 leader 覆写」;
 *   若已在产出里披露, 照常放行。
 */

/** 命中弱型同家族时, 产出里必须出现的「家族口径」词 */
export const FAMILY_DISCLOSURE_RE =
  /【Self-Submitter Recusal 弱型坦白】|弱型坦白|Self-Submitter\s*Recusal\s*弱型|同家族|同终端|same\s*family/i;

/** 必须出现的「邀请 leader 覆写」词(供 leader 检索/覆写) */
export const LEADER_OVERWRITE_RE =
  /邀请\s*leader\s*覆写|请\s*leader\s*覆写|leader\s*覆写|invite-leader-overwrite|leader\s*overwrite/i;

export interface FamilyRecusalResult {
  /** 是否命中弱型同家族 (同 host 不同 agentId) */
  triggered: boolean;
  /** 命中时产出是否已「坦白 + 邀请 leader 覆写」 */
  disclosed: boolean;
  /** 归一化后的 submitter (candidate.agentSource 去 `agent:` 前缀) */
  submitterAgentId: string;
  /** 归一化后的 executor (task.assignedAgent) */
  executorAgentId: string;
  /** 若命中, 两者共同的 host/终端名; 否则 null */
  host: string | null;
  /** 人可读说明(命中未披露时进 422 hint) */
  detail: string;
}

/**
 * 把 agentSource / assignedAgent 归一到 AgentRegistry.agent_id。
 * 例: "agent:agent-operator" -> "agent-operator"; "agent-e" -> "agent-e"。
 */
export function normalizeAgentId(raw?: string | null): string {
  return String(raw || "").trim().replace(/^agent:\s*/i, "").trim();
}

/**
 * 纯判定(不碰库, 可单测): 给定 submitter/executor/host 映射与产出文本,
 * 判是否「弱型同家族且未披露」。
 *
 * fail-open 口径: host 缺失 / 同一 agentId / 不同 host -> triggered=false(放行)。
 * 任何读库失败都应由调用方降级到「不阻断」, 与本函数口径一致。
 */
export function checkWeakRecusalDisclosure(opts: {
  output: string;
  submitterAgentSource?: string | null;
  executorAgentId?: string | null;
  hostByAgentId?: Record<string, string | null | undefined>;
}): FamilyRecusalResult {
  const submitterAgentId = normalizeAgentId(opts.submitterAgentSource);
  const executorAgentId = normalizeAgentId(opts.executorAgentId);
  const hosts = opts.hostByAgentId || {};
  const sHost = hosts[submitterAgentId] ?? null;
  const eHost = hosts[executorAgentId] ?? null;

  const sameFamily =
    !!submitterAgentId &&
    !!executorAgentId &&
    submitterAgentId !== executorAgentId &&
    !!sHost &&
    !!eHost &&
    sHost === eHost;

  const text = String(opts.output || "");
  const hasFamilyWord = FAMILY_DISCLOSURE_RE.test(text);
  const hasLeaderInvite = LEADER_OVERWRITE_RE.test(text);
  const disclosed = hasFamilyWord && hasLeaderInvite;

  if (!sameFamily) {
    return {
      triggered: false,
      disclosed: true,
      submitterAgentId,
      executorAgentId,
      host: null,
      detail:
        submitterAgentId === executorAgentId
          ? "submitter==executor 同 agentId(严格自证自核, 由 skill 层处理, 本闸门不管)"
          : "submitter 与 executor 不同家族(host 不同或缺 host 映射), 无需弱型披露",
    };
  }

  return {
    triggered: true,
    disclosed,
    submitterAgentId,
    executorAgentId,
    host: sHost,
    detail: disclosed
      ? `弱型同家族(host=${sHost})已坦白并邀请 leader 覆写`
      : `submitter ${submitterAgentId} 与 executor ${executorAgentId} 同家族(host=${sHost})但不同 agentId, 属弱自证自核; ` +
        (hasFamilyWord ? "缺少「邀请 leader 覆写」" : hasLeaderInvite ? "缺少「同家族」坦白" : "既无同家族坦白也无邀请 leader 覆写"),
  };
}

/**
 * 读库构造 agentId -> host 映射(仅供 route 使用; 失败返回 {} -> 闸门 fail-open)。
 */
export async function loadHostMap(prisma: any, agentIds: string[]): Promise<Record<string, string | null>> {
  const ids = Array.from(new Set((agentIds || []).map((x) => normalizeAgentId(x)).filter(Boolean)));
  const map: Record<string, string | null> = {};
  if (!ids.length) return map;
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT agent_id, host FROM AgentRegistry WHERE agent_id IN (${placeholders})`,
      ...ids,
    );
    for (const r of rows || []) map[String(r.agent_id)] = r.host == null ? null : String(r.host);
  } catch {
    /* fail-open: 读不到注册表就不阻断提交 */
  }
  return map;
}
