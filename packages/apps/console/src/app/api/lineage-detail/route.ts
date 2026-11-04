import { NextResponse } from "next/server";
import {
  asOf, num, one, openMind, openSession, parseAgentOutput, parseInjection, q, safeClose,
} from "@/lib/server/lions-db";
import {
  ARTIFACT_TYPES, DEFAULT_ARTIFACT_TYPE, artifactLabel, artifactLabelList, artifactTitleCol,
  isArtifactType, type ArtifactType,
} from "@/config/artifactTypes";

export const dynamic = "force-dynamic";

const HIDDEN_COLS = new Set(["content", "description", "structuredContext", "input", "output", "embedding"]);

// GET /api/lineage-detail?type=Knowledge&id=xxx
// 单条产物的端到端血缘: 来源 (sourceType/sourceId 回溯到会话/任务/agent) → 本产物 → 使用 (注入/认领)
// 只读 + 容错: 未找到 / 库不可用时返回空结构, 绝不 500。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawType = url.searchParams.get("type");
  const type: ArtifactType = rawType && isArtifactType(rawType) ? rawType : DEFAULT_ARTIFACT_TYPE;
  const id = url.searchParams.get("id") || "";
  const mind = openMind();
  const sess = openSession();
  const warnings: string[] = [];

  const empty = {
    asOf: asOf(), type, id, found: false, warnings: ["未找到该产物, 或 mind 库不可用"],
    artifact: null, fields: [], source: null, provenance: [], usage: null, derived: [], events: [], timeline: [],
  };

  if ((rawType && !isArtifactType(rawType)) || !id) {
    return NextResponse.json({ ...empty, warnings: [`产物类型必须是 ${artifactLabelList()} 之一, 且 id 不能为空`] });
  }
  if (!mind) {
    safeClose(sess);
    return NextResponse.json(empty);
  }

  const row = await one(mind, `SELECT * FROM ${type} WHERE id = ? LIMIT 1`, id);
  if (!row) {
    safeClose(mind, sess);
    return NextResponse.json(empty);
  }

  // ---------- 字段表 (隐藏超长正文, 单独截断展示) ----------
  const fields: { key: string; value: any }[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || v === "") continue;
    if (HIDDEN_COLS.has(k)) {
      const s = String(v);
      fields.push({ key: k, value: s.length > 2000 ? s.slice(0, 2000) + `…（共 ${s.length.toLocaleString("zh-CN")} 字符）` : s });
    } else {
      fields.push({ key: k, value: v });
    }
  }

  const sourceType: string | null = (row as any).sourceType ?? (row as any).source ?? null;
  const sourceId: string | null = (row as any).sourceId ?? null;
  const agentSource: string | null = (row as any).agentSource ?? null;

  // ---------- 1. 来源回溯 ----------
  type Resolved = {
    kind: "session" | "task" | "artifact" | "agent" | "event" | "external" | "unknown";
    label: string;
    detail: any;
  } | null;
  let resolved: Resolved = null;

  if (sourceId) {
    // 1.1 session 库会话
    const s1 = await one(sess, "SELECT id, sessionUid, agentId, agentName, title, platform, messageCount, model, extractStatus, createdAt, startedAt, lastMessageAt FROM Session WHERE id = ? OR sessionUid = ? LIMIT 1", sourceId, sourceId);
    if (s1) {
      resolved = {
        kind: "session",
        label: `会话 ${s1.title || s1.sessionUid || s1.id}`,
        detail: {
          sessionId: s1.id, sessionUid: s1.sessionUid, agentId: s1.agentId, agentName: s1.agentName,
          platform: s1.platform, messageCount: s1.messageCount, model: s1.model,
          extractStatus: s1.extractStatus, createdAt: s1.createdAt, lastMessageAt: s1.lastMessageAt,
        },
      };
    }
    // 1.2 mind 任务
    if (!resolved) {
      const t = await one(mind, "SELECT id, title, status, assignedAgent, theme, priority, createdAt, completedAt FROM Task WHERE id = ? LIMIT 1", sourceId);
      if (t) {
        resolved = {
          kind: "task",
          label: `任务 ${t.title}`,
          detail: { taskId: t.id, status: t.status, assignedAgent: t.assignedAgent, theme: t.theme, priority: t.priority, createdAt: t.createdAt, completedAt: t.completedAt },
        };
      }
    }
    // 1.3 上游产物 (产物派生链)
    if (!resolved) {
      for (const at of ARTIFACT_TYPES) {
        const titleCol = artifactTitleCol(at);
        const up = await one(mind, `SELECT id, ${titleCol} title, qualityScore, createdAt FROM ${at} WHERE id = ? LIMIT 1`, sourceId);
        if (up) {
          resolved = { kind: "artifact", label: `上游产物 ${artifactLabel(at)}`, detail: { table: at, id: up.id, title: up.title, qualityScore: up.qualityScore, createdAt: up.createdAt } };
          break;
        }
      }
    }
    // 1.4 agent
    if (!resolved) {
      const a = await one(mind, "SELECT agent_id, display_name, channel, host, status, last_seen_at FROM AgentRegistry WHERE agent_id = ? LIMIT 1", sourceId);
      if (a) resolved = { kind: "agent", label: `智能体 ${a.display_name || a.agent_id}`, detail: a };
    }
    // 1.5 事件 / 外部标识
    if (!resolved) {
      const ev = await one(mind, "SELECT stage, sourceType, sourceTitle, createdAt FROM FlywheelEvent WHERE sourceId = ? ORDER BY createdAt DESC LIMIT 1", sourceId);
      if (ev) resolved = { kind: "event", label: `事件 ${ev.stage}`, detail: ev };
    }
  }

  // agentSource 可能是 'agent:agent-operator' / 'PIPELINE_agent-h' 这类写法, 做一次归一化再查注册表
  const agentKey = agentSource
    ? agentSource.replace(/^agent:/, "").replace(/^PIPELINE_/i, "").replace(/^AGENT-/i, "agent-").toLowerCase()
    : null;
  const agentInfo = agentSource
    ? await one(mind, "SELECT agent_id, display_name, channel, host, status, last_seen_at FROM AgentRegistry WHERE agent_id = ? LIMIT 1", agentSource) ||
      (agentKey ? await one(mind, "SELECT agent_id, display_name, channel, host, status, last_seen_at FROM AgentRegistry WHERE lower(agent_id) = ? LIMIT 1", agentKey) : null)
    : null;

  const source = {
    sourceType,
    sourceId,
    agentSource,
    agent: agentInfo
      ? { agentId: agentInfo.agent_id, displayName: agentInfo.display_name, channel: agentInfo.channel, host: agentInfo.host, status: agentInfo.status, lastSeenAt: agentInfo.last_seen_at }
      : null,
    resolved,
    /** 来源类型 → 人类可读解释 */
    interpretation: interpretSource(sourceType, resolved?.kind),
  };

  // ---------- 2. 使用: 注入 / 认领 ----------
  const injRows = await q(
    mind,
    "SELECT sourceType, sourceId, sourceTitle, createdAt FROM FlywheelEvent WHERE stage='CONTEXT_INJECTED' AND sourceTitle LIKE ? ORDER BY createdAt DESC LIMIT 30",
    `%${id}%`
  );
  const injections = injRows.map((e) => {
    const p = parseInjection(e.sourceTitle);
    return { taskId: e.sourceId, agentId: p.agentId, count: p.ids.length || p.count, kinds: p.kinds, at: e.createdAt, contains: p.ids.includes(id) };
  });
  const taskIds = Array.from(new Set(injections.map((i) => i.taskId).filter(Boolean))).slice(0, 10);
  const usedByTasks = taskIds
    .map((tid) => one(mind, "SELECT id, title, status, assignedAgent, theme, completedAt FROM Task WHERE id = ? LIMIT 1", tid))
    .filter(Boolean);

  const usage = {
    usageCount: num((row as any).usageCount ?? (row as any).totalUsageCount ?? (row as any).accessCount),
    lastUsedAt: (row as any).lastUsedAt ?? (row as any).lastAccessed ?? null,
    injectionEvents: injections.length,
    injections,
    usedByTasks,
  };

  // ---------- 3. 派生产物 (谁用了我) ----------
  const derived: any[] = [];
  for (const at of ARTIFACT_TYPES) {
    const titleCol = artifactTitleCol(at);
    const rows = await q(
      mind,
      `SELECT id, ${titleCol} title, sourceType, qualityScore, createdAt FROM ${at} WHERE sourceId = ? ORDER BY createdAt DESC LIMIT 10`,
      id
    );
    for (const d of rows) derived.push({ table: at, id: d.id, title: d.title, sourceType: d.sourceType, qualityScore: d.qualityScore, createdAt: d.createdAt });
  }
  derived.sort((a, b) => num(b.createdAt) - num(a.createdAt));

  // ---------- 4. 相关事件流 / 时间线 ----------
  const events = await q(
    mind,
    "SELECT stage, sourceType, sourceId, sourceTitle, targetStage, targetId, taskId, createdAt FROM FlywheelEvent " +
      "WHERE sourceId = ? OR targetId = ? ORDER BY createdAt DESC LIMIT 60",
    id, id
  );

  const timeline: { at: number; kind: string; title: string; desc?: string }[] = [];
  if ((row as any).createdAt) timeline.push({ at: num((row as any).createdAt), kind: "create", title: `${type} 创建`, desc: (row as any).title || (row as any).name || id });
  for (const e of events) {
    timeline.push({
      at: num(e.createdAt), kind: "event", title: e.stage,
      desc: `来源类型=${e.sourceType} · 目标阶段=${e.targetStage}${e.taskId ? " · 任务=" + e.taskId : ""}`,
    });
  }
  for (const inj of injections) {
    timeline.push({ at: num(inj.at), kind: "use", title: "被认领注入", desc: `智能体=${inj.agentId || "-"} · 注入 ${inj.count} 条 · 任务 ${inj.taskId || "-"}` });
  }
  for (const d of derived) {
    timeline.push({ at: num(d.createdAt), kind: "derive", title: `派生 ${d.table}`, desc: d.title });
  }
  timeline.sort((a, b) => b.at - a.at);

  // ---------- 5. 质量 / 验证 ----------
  const quality = {
    qualityScore: (row as any).qualityScore ?? null,
    reinforceCount: (row as any).reinforceCount ?? null,
    stale: (row as any).stale ?? null,
    supersededBy: (row as any).supersededBy ?? null,
    verification: (row as any).verification ?? null,
    humanConfirmed: (row as any).humanConfirmed ?? null,
    confidence: (row as any).confidence ?? null,
    level: (row as any).level ?? null,
  };

  // 关联 Agent 产出提交 (AGENT_OUTPUT_INGESTED 中指向本条产物的记录)
  const submitEvents = await q(
    mind,
    "SELECT sourceTitle, createdAt FROM FlywheelEvent WHERE stage='AGENT_OUTPUT_INGESTED' AND sourceTitle LIKE ? ORDER BY createdAt DESC LIMIT 10",
    `%${id}%`
  );
  const submissions = submitEvents.map((e) => ({ ...parseAgentOutput(e.sourceTitle), createdAt: e.createdAt }));

  safeClose(mind, sess);
  return NextResponse.json({
    asOf: asOf(),
    type, id, found: true,
    warnings,
    title: (row as any).title || (row as any).name || id,
    artifact: row,
    fields,
    source,
    provenance: buildProvenance(sourceType, resolved, submissions, num((row as any).createdAt)),
    usage,
    derived,
    events,
    timeline: timeline.slice(0, 40),
    quality,
    submissions,
  });
}

/** 来源类型的人类可读解释 (不是黑盒 ID) */
function interpretSource(sourceType: string | null, resolvedKind?: string): string {
  const map: Record<string, string> = {
    CLAUDE_CONVERSATION: "来自 Claude 会话提炼 (会话消息 → LLM 抽取)",
    PIPELINE_HERMES: "来自 hermes 渠道会话的流水线提炼",
    PIPELINE_BACKFILL: "来自历史会话回填 (批量补提炼)",
    FLYWHEEL_REFLECTION: "来自飞轮主题反思 (跨会话聚合)",
    FLYWHEEL_STRUCTURED: "来自改进任务执行后的结构化回填",
    BRIDGE: "来自任务产物桥接回写",
    GLOBAL_ORGANIZER: "来自全局整理器 (知识地图/知识点归并)",
    AGENT_OUTPUT: "来自 Agent 主动提交的产出",
    PLATFORM_GUIDE: "平台自带指南内容",
    PLATFORM_SPEC: "平台自带规范内容",
    mcp: "来自 MCP 工具写入",
    LEARNED: "平台学习产物 (由反思/结构化任务合成)",
    MANUAL: "人工录入",
    IMPORTED: "外部导入",
    LEGACY: "历史遗留数据 (迁移导入)",
    UNKNOWN: "来源未标注",
  };
  const base = sourceType ? map[sourceType] || (sourceType.startsWith("PIPELINE_") ? `来自流水线入口 ${sourceType.slice(9).toLowerCase()} 的会话提炼` : `来源类型 ${sourceType}`) : "来源未标注";
  if (resolvedKind === "session") return base + " · 可回溯到具体会话";
  if (resolvedKind === "task") return base + " · 可回溯到改进任务";
  if (resolvedKind === "artifact") return base + " · 由上游产物派生";
  return base;
}

/** 追溯链: 会话 → 提炼 → 产物 → 使用 */
function buildProvenance(sourceType: string | null, resolved: any, submissions: any[], createdAt: number) {
  const chain: { step: string; label: string; value: string; at: number | null }[] = [];
  chain.push({ step: "source", label: "来源", value: sourceType || "未标注", at: null });
  if (resolved) chain.push({ step: "resolved", label: "回溯对象", value: resolved.label, at: null });
  if (submissions.length) {
    chain.push({ step: "submit", label: "智能体提交", value: `${submissions[0].agentId || "-"} 提交 (质量 ${submissions[0].quality ?? "-"})`, at: num(submissions[0].createdAt) });
  }
  chain.push({ step: "create", label: "产物落库", value: new Date(createdAt).toLocaleString("zh-CN", { hour12: false }), at: createdAt });
  return chain;
}
