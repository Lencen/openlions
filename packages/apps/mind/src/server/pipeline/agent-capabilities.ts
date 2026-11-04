import { prisma } from "@/lib/prisma";
import {
  getAgentCapability,
  listAgentCapabilities,
  type AgentCapability,
} from "@/server/pipeline/agent-capability";

/**
 * agent-capabilities.ts — 2026-09-14 「能力自检端点」的数据层 (提案 cmtwl36jy02bx1j76zndaehd0 落地)。
 *
 * 为什么需要它 (实测事故链, 不是假想问题):
 *   1) 平台此前**没有任何接口**能回答"某个 agent 到底能不能调用平台 API/MCP"。
 *      于是只能"派探测任务 -> 等 agent 自述" —— 实测 agent-c / agent-f 都回 NO_TOOLS,
 *      但注册表 AgentRegistry.profile.capabilities.tools 对 agent-f 写的是 **true**。
 *      声明与观察互相打脸, 而两边都不可独立复算, 复核只能判 REJECTED。
 *   2) 复核者(文本通道)也拿不到权威来源, 只能靠材料里的 rerun 字段;
 *      而那个字段被截断 ("curl -s -X POST localhost" 后无返回), 整条链空转。
 *
 * 本模块把"能力"拆成三层, 因为**它们不是一回事**:
 *   declared — AgentRegistry.profile.capabilityTier / capabilities: 人工/注册时**声明**的档位, 可改, 未必真实。
 *   granted  — AgentServicePermission: 平台**实际发放**的服务授权(含权限项与到期), 是"允许调用什么"。
 *   observed — TaskExecution 产出文本里的**弱信号**: 有没有自述无工具、有没有引用命令痕迹。
 *
 * ⚠ 诚实边界(本模块刻意写死, 防止又造一个不可验证的"权威"):
 *   文本观察**不能证明**某 agent 运行时真能/真不能调接口 —— 复核引用命令不等于它跑过。
 *   因此:
 *     - consistency 永远不从文本推出 "CONFIRMED(已证实)"。文本只产出 CONSISTENT / DECLARED_CONFLICT /
 *       SELF_REPORT_NO_TOOLS / NO_OBSERVATION。
 *     - 运行时真值必须靠一次**真实调用**: `node scripts/probes/probe-platform-api-mcp.cjs`
 *       (写 nonce -> 经 API 读回; MCP initialize + tools/list + tools/call), 脚本把完整 JSON 输出落盘
 *       并写一条 Evidence(sourceType=CAPABILITY_PROBE)。
 *     - `runtimeVerified` 只有当该 agent 存在一条 passed>0 && failed=0 的 CAPABILITY_PROBE 证据时才为 true,
 *       此时 consistency = RUNTIME_VERIFIED(实测优先, 文本层历史自述不覆盖)。没有证据就是 false —— 不猜。
 */

/** observed 弱信号 A: 自述"本通道无工具/未执行"的措辞 (与 scripts/capability-routing-report.cjs 的 MARKERS 同源)。 */
export const NO_TOOLS_MARKERS = [
  "NO_TOOLS",
  "无工具",
  "本通道无",
  "不包含任何已执行",
  "无法访问",
  "无执行能力",
];

/**
 * observed 弱信号 B: 产出里**引用**了命令/原始输出形态的痕迹。
 * 注意命名: quoted(引用) 而非 executed(执行) —— 复核员抄一条 curl 也会命中, 所以它只是弱信号。
 */
export const QUOTED_EVIDENCE_MARKERS = [
  "HTTP:",
  "curl ",
  "SELECT ",
  "commit ",
  "git ",
  "文件:",
  ".ts:",
];

export interface DeclaredCapability {
  tier: number;
  toolCapable: boolean;
  dimensions: { tools: boolean; db: boolean; file: boolean; network: boolean };
  source: "registry" | "env" | "default";
  reason: string;
  setBy: string | null;
  setAt: string | null;
}

export interface GrantedService {
  name: string;
  displayName: string;
  permissions: string[];
  expiresAt: string | null;
  expired: boolean;
}

export interface GrantedCapability {
  /** 是否持有有效的 mcp_agent_chat 服务授权(= 平台已发放 MCP 通道权限) */
  mcp: boolean;
  /** 是否持有有效的 lions_mind / lions_memory / lions_knowledge 授权(= 平台已发放共享大脑权限) */
  lionsMind: boolean;
  services: GrantedService[];
  /** 有效服务名列表, 供派单快速判断"这个 agent 被允许调哪些入口" */
  tools: string[];
}

export interface ObservedCapability {
  /** 纳入观察的已完成产出条数(最近 N 条) */
  completedRuns: number;
  /** 弱信号 A: 自述无工具的产出条数 */
  noToolsSelfReports: number;
  /** 弱信号 B: 引用过命令/原始输出的产出条数(不等于真的执行过) */
  quotedCommandEvidence: number;
  lastNoTools: { taskId: string; at: string | null } | null;
  lastQuotedEvidence: { taskId: string; at: string | null } | null;
  /** 文本观察无法证明运行时能力, 这里恒为说明性文字 */
  caveat: string;
}

export interface RuntimeProbe {
  /** 探测时间 */
  at: string | null;
  evidenceId: string;
  passed: number;
  failed: number;
  /** 探测脚本写下的完整原始输出文件(不截断) */
  evidencePath: string | null;
  ok: boolean;
}

export type Consistency =
  | "RUNTIME_VERIFIED"     // 已附一次真实调用实测(API+MCP)且全通过 -> 运行时确证(最高置信)
  | "CONSISTENT"           // 声明有工具 + 无"无工具"自述 + 有引用痕迹 -> 与声明一致(仍未运行时实测)
  | "DECLARED_CONFLICT"    // 声明有工具, 但产出自述无工具 -> 声明存疑, 不得据此派工具类任务
  | "SELF_REPORT_NO_TOOLS" // 声明无工具 + 自述无工具 -> 一致
  | "NO_OBSERVATION";      // 没有可判定的产出

export interface AgentCapabilitiesReport {
  agentId: string;
  displayName: string | null;
  channel: string | null;
  host: string | null;
  role: string | null;
  declared: DeclaredCapability;
  granted: GrantedCapability;
  observed: ObservedCapability;
  consistency: Consistency;
  /** 给派单/复核用的一句话结论(有 runtimeProbe 时以其为准) */
  verdict: string;
  /** 最近一次真实调用探测的证据(来自 Evidence 表 sourceType=CAPABILITY_PROBE); 没有则 null */
  runtimeProbe: RuntimeProbe | null;
  /** 是否已附上真实调用探测的完整证据(failed=0 且 passed>0) */
  runtimeVerified: boolean;
  /** 拿到运行时真值该跑的命令 */
  runtimeProbeCommand: string;
  /**
   * 权威范围声明 —— 防止又把本端点当成"万能真值":
   * declared/granted 是**平台侧登记事实**, observed 是**文本弱信号**;
   * 运行时"此刻能否连通"仍需一次真实调用(见 runtimeProbeCommand)。
   */
  authoritativeFor: string;
  checkedAt: string;
}

export const RUNTIME_PROBE_COMMAND = "node scripts/probes/probe-platform-api-mcp.cjs";

function num(v: any): number {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  return Number(v);
}

function iso(v: any): string | null {
  if (v == null) return null;
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

async function readRegistry(agentId: string): Promise<any | null> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT agent_id, display_name, channel, host, role, profile FROM AgentRegistry WHERE agent_id = ? LIMIT 1",
      agentId,
    );
    return rows && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

async function readGrants(agentId: string): Promise<GrantedService[]> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT p.service_name, s.display_name, p.permissions, p.status, p.expires_at " +
        "FROM AgentServicePermission p LEFT JOIN AgentService s ON s.name = p.service_name " +
        "WHERE p.agent_id = ? AND p.status = 'ACTIVE'",
      agentId,
    );
    const now = Date.now();
    const out: GrantedService[] = [];
    for (const r of rows || []) {
      const exp = num(r.expires_at);
      let perms: string[] = [];
      try {
        const p = JSON.parse(String(r.permissions || "[]"));
        if (Array.isArray(p)) perms = p.map(String);
      } catch {
        perms = [];
      }
      out.push({
        name: String(r.service_name),
        displayName: r.display_name == null ? String(r.service_name) : String(r.display_name),
        permissions: perms,
        expiresAt: iso(r.expires_at),
        expired: exp > 0 && exp < now,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function readObserved(agentId: string, limit = 50): Promise<ObservedCapability> {
  let rows: any[] = [];
  try {
    rows = await prisma.$queryRawUnsafe(
      "SELECT taskId, output, completedAt, createdAt FROM TaskExecution " +
        "WHERE agentId = ? AND status = 'COMPLETED' ORDER BY createdAt DESC LIMIT ?",
      agentId,
      limit,
    );
  } catch {
    rows = [];
  }
  let noTools = 0;
  let quoted = 0;
  let lastNoTools: ObservedCapability["lastNoTools"] = null;
  let lastQuoted: ObservedCapability["lastQuotedEvidence"] = null;
  for (const r of rows || []) {
    const o = String(r.output || "");
    const at = iso(r.completedAt ?? r.createdAt);
    if (NO_TOOLS_MARKERS.some((m) => o.includes(m))) {
      noTools++;
      if (!lastNoTools) lastNoTools = { taskId: String(r.taskId), at };
    }
    if (QUOTED_EVIDENCE_MARKERS.some((m) => o.includes(m))) {
      quoted++;
      if (!lastQuoted) lastQuoted = { taskId: String(r.taskId), at };
    }
  }
  return {
    completedRuns: (rows || []).length,
    noToolsSelfReports: noTools,
    quotedCommandEvidence: quoted,
    lastNoTools,
    lastQuotedEvidence: lastQuoted,
    caveat: "文本弱信号: 引用命令 ≠ 真的执行过; 运行时能力必须用 runtimeProbeCommand 实测",
  };
}

/**
 * 读最近一次**真实调用**探测的结果。由 scripts/probes/probe-platform-api-mcp.cjs 写入 Evidence:
 *   sourceType = 'CAPABILITY_PROBE', agentId = 被探测的 agent, payload = { passed, failed, evidencePath, api, mcp }
 * 这是唯一能给出"运行时确证"的来源 —— 文本观察永远只是弱信号。
 */
async function readRuntimeProbe(agentId: string): Promise<RuntimeProbe | null> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT id, payload, createdAt FROM Evidence WHERE sourceType = 'CAPABILITY_PROBE' AND agentId = ? " +
        "ORDER BY createdAt DESC LIMIT 1",
      agentId,
    );
    if (!rows || !rows.length) return null;
    const r = rows[0];
    let p: any = {};
    try {
      p = JSON.parse(String(r.payload || "{}"));
    } catch {
      p = {};
    }
    const passed = num(p.passed);
    const failed = num(p.failed);
    return {
      at: iso(r.createdAt),
      evidenceId: String(r.id),
      passed,
      failed,
      evidencePath: p.evidencePath == null ? null : String(p.evidencePath),
      ok: failed === 0 && passed > 0,
    };
  } catch {
    return null;
  }
}

function judge(declared: DeclaredCapability, observed: ObservedCapability): { c: Consistency; verdict: string } {  const declaredTools = declared.dimensions.tools || declared.toolCapable;
  if (!observed.completedRuns) {
    return {
      c: "NO_OBSERVATION",
      verdict:
        "注册表声明 T" + declared.tier + (declaredTools ? "(有工具)" : "(无工具)") +
        "; 该 agent 无已完成产出, 文本层判不了 —— 跑 " + RUNTIME_PROBE_COMMAND + " 拿运行时真值",
    };
  }
  if (declaredTools && observed.noToolsSelfReports > 0) {
    return {
      c: "DECLARED_CONFLICT",
      verdict:
        "注册表声明有工具(tools=" + declared.dimensions.tools + "), 但最近 " + observed.completedRuns +
        " 条产出里有 " + observed.noToolsSelfReports + " 条自述无工具 —— 声明存疑; 派工具/改动类任务前必须先实测, 不得据此声明派单",
    };
  }
  if (declaredTools) {
    return {
      c: "CONSISTENT",
      verdict:
        "声明有工具, 且最近 " + observed.completedRuns + " 条产出未见'无工具'自述(" +
        observed.quotedCommandEvidence + " 条含命令引用) —— 与声明一致, 但文本层不算运行时实证",
    };
  }
  if (observed.noToolsSelfReports > 0) {
    return {
      c: "SELF_REPORT_NO_TOOLS",
      verdict: "声明无工具, 产出亦自述无工具 —— 一致",
    };
  }
  return {
    c: "NO_OBSERVATION",
    verdict: "声明为 " + (declaredTools ? "有工具" : "无工具") + ", 但产出证据不足以判定",
  };
}

function profileMeta(profile: string | null): { setBy: string | null; setAt: string | null } {
  try {
    const j = profile ? JSON.parse(String(profile)) : null;
    if (!j) return { setBy: null, setAt: null };
    return {
      setBy: j.capabilitySetBy ? String(j.capabilitySetBy) : null,
      setAt: j.capabilitySetAt ? String(j.capabilitySetAt) : null,
    };
  } catch {
    return { setBy: null, setAt: null };
  }
}

async function buildOne(agentId: string, cap: AgentCapability, registry: any | null): Promise<AgentCapabilitiesReport> {
  const [grants, observed, runtimeProbe] = await Promise.all([
    readGrants(agentId),
    readObserved(agentId),
    readRuntimeProbe(agentId),
  ]);
  const meta = profileMeta(registry?.profile ?? null);
  const active = grants.filter((g) => !g.expired);
  const names = active.map((g) => g.name);
  const granted: GrantedCapability = {
    mcp: names.includes("mcp_agent_chat"),
    lionsMind: names.some((n) => n === "lions_mind" || n === "lions_memory" || n === "lions_knowledge"),
    services: grants,
    tools: names,
  };
  const declared: DeclaredCapability = {
    tier: cap.tier,
    toolCapable: cap.toolCapable,
    dimensions: cap.dimensions,
    source: cap.source,
    reason: cap.reason || "",
    setBy: meta.setBy,
    setAt: meta.setAt,
  };
  const runtimeVerified = !!runtimeProbe && runtimeProbe.ok;
  let c: Consistency;
  let verdict: string;
  if (runtimeVerified && runtimeProbe) {
    // 实测优先: 文本层的历史自述不能覆盖一次真实的 API+MCP 调用结果。
    c = "RUNTIME_VERIFIED";
    verdict =
      "已附运行时实测证据(Evidence " + runtimeProbe.evidenceId + ": passed " + runtimeProbe.passed +
      " / failed " + runtimeProbe.failed + (runtimeProbe.evidencePath ? ", 原始输出 " + runtimeProbe.evidencePath : "") +
      ") —— 运行时确证; 文本层自述冲突(n=" + observed.noToolsSelfReports + ")属历史/上下文差异, 不覆盖实测";
  } else {
    const j = judge(declared, observed);
    c = j.c;
    verdict = j.verdict;
  }
  return {
    agentId,
    displayName: registry?.display_name == null ? null : String(registry.display_name),
    channel: registry?.channel == null ? null : String(registry.channel),
    host: registry?.host == null ? null : String(registry.host),
    role: registry?.role == null ? null : String(registry.role),
    declared,
    granted,
    observed,
    consistency: c,
    verdict,
    runtimeProbe,
    runtimeVerified,
    runtimeProbeCommand: RUNTIME_PROBE_COMMAND,
    authoritativeFor:
      "派单/认领的能力下限判定(declared+granted)与'自述无工具'主张的文本核对(observed); 运行时连通性以 runtimeProbe(Evidence)为准, 没有则跑 runtimeProbeCommand 实测",
    checkedAt: new Date().toISOString(),
  };
}

/** 单个 agent 的能力自检报告(三层: declared / granted / observed)。 */
export async function getAgentCapabilitiesReport(agentId: string): Promise<AgentCapabilitiesReport> {
  const [cap, registry] = await Promise.all([getAgentCapability(agentId), readRegistry(agentId)]);
  return buildOne(agentId, cap, registry);
}

/** 全量能力自检报告(看板/审计用)。 */
export async function listAgentCapabilitiesReport(): Promise<AgentCapabilitiesReport[]> {
  const [caps, regs] = await Promise.all([
    listAgentCapabilities(),
    (async () => {
      try {
        return await prisma.$queryRawUnsafe("SELECT agent_id, display_name, channel, host, role, profile FROM AgentRegistry");
      } catch {
        return [] as any[];
      }
    })(),
  ]);
  const byId = new Map<string, any>((regs as any[]).map((r) => [String(r.agent_id), r]));
  const out: AgentCapabilitiesReport[] = [];
  for (const cap of caps) {
    const reg = byId.get(cap.agentId) || null;
    out.push(await buildOne(cap.agentId, cap, reg));
  }
  return out;
}
