#!/usr/bin/env node
/**
 * flywheel-business-snapshot.cjs — 飞轮业务看板扩展层（2026-10-27）
 * ==================================================================
 * 定位：**不是第二套口径**，而是 canonical 快照 v1 的“业务维度追加层”。
 *   - 先调 lib/flywheel-snapshot.cjs 的 collectSnapshot() 拿 canonical 快照；
 *   - 只补 v1 没有的业务字段（DONE 按 agent/cron 拆分、验收 source 拆分、token 两层、
 *     never-claimed、14d 日序列、资产全貌、组织、审计分布、数据健康、NO_DATA）；
 *   - canonical 字段原样复制，不重算、不改语义；所有追加字段放在 business 下。
 *
 * 只读：不写任何业务表；gateway token 只读本机 sqlite。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { collectSnapshot, connect, REPO, SCHEMA } = require("./flywheel-snapshot.cjs");

const BUSINESS_SCHEMA = "lions.flywheel.business/v1";
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (a, b) => (b ? Number(((a / b) * 100).toFixed(2)) : null);
const r2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(2)));

// ── regime：调研稿 §2.2；边界按 UTC 自然日（快照窗口本身是 UTC） ─────────────
const REGIMES = [
  { id: "R1", from: null, to: "2026-10-08", label: "旧路径期", note: "THEME_IMPROVE 主导，cron 关单 90%+，agent 认领几乎为 0" },
  { id: "R2", from: "2026-10-09", to: "2026-10-21", label: "新认领循环期", note: "GOAL_GAP 主导，agent 转化 5–17%" },
  { id: "R3", from: "2026-10-22", to: null, label: "交付崩塌期", note: "认领高、交付低、产出低水位；不能与 R2 直接比" },
];
function regimeOf(dateStr) {
  const d = String(dateStr || "").slice(0, 10);
  for (const r of REGIMES) {
    if (r.from && d < r.from) continue;
    if (r.to && d > r.to) continue;
    return r;
  }
  return REGIMES[REGIMES.length - 1];
}

function classifyDone(by) {
  const s = String(by || "");
  if (/^agent[-:]/i.test(s)) return "agent";
  if (/^cron[:]/i.test(s)) return "cron";
  if (/^system[:]/i.test(s)) return "system";
  return s ? "other" : "unknown";
}

// ── token：网关侧（精确总量；只读本机 sqlite） ─────────────────────────────
function openSqlite(file) {
  try {
    const { openSqliteReadonly } = require("./sqlite-external-ro.cjs");
    return openSqliteReadonly(file);
  } catch { return null; }
}

function collectGatewayTokens(window) {
  const sinceMs = Date.parse(window.from);
  const untilMs = Date.parse(window.to);
  const home = os.homedir();
  const byGateway = [];
  let available = false, reason = null;

  // OpenClaw：~/.openclaw/agents/<dir>/agent/openclaw-agent.sqlite
  const root = path.join(home, ".openclaw", "agents");
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "agent", "openclaw-agent.sqlite"))); } catch { /* 无本机网关 */ }
  for (const d of dirs) {
    const db = openSqlite(path.join(root, d, "agent", "openclaw-agent.sqlite"));
    if (!db) { reason = reason || "better-sqlite3 不可用"; continue; }
    try {
      const rows = db.prepare(`
        SELECT n.session_key AS k,
               SUM(COALESCE(json_extract(t.event_json, '$.message.usage.totalTokens'), 0)) AS tk,
               COUNT(*) AS calls
        FROM transcript_events t
        LEFT JOIN session_nodes n ON n.current_session_id = t.session_id
        WHERE t.event_json LIKE '%"usage"%' AND t.created_at >= ? AND t.created_at < ?
        GROUP BY 1`).all(sinceMs, untilMs);
      let tk = 0, calls = 0, taskSessions = 0, taskTokens = 0;
      for (const r of rows) {
        tk += Number(r.tk || 0); calls += Number(r.calls || 0);
        if (/task-/.test(String(r.k || ""))) { taskSessions++; taskTokens += Number(r.tk || 0); }
      }
      if (rows.length) available = true;
      byGateway.push({ gateway: "openclaw", agentDir: d, sessions: rows.length, calls, tokens: tk, taskSessions, taskTokens, exact: true });
    } catch (e) { reason = reason || ("openclaw 读取失败: " + e.message); }
    finally { try { db.close(); } catch { /* ignore */ } }
  }

  // Hermes：~/.hermes/state.db
  const hdb = openSqlite(path.join(home, ".hermes", "state.db"));
  if (hdb) {
    try {
      const r = hdb.prepare(`
        SELECT COUNT(*) n, SUM(input_tokens+output_tokens) tk, SUM(api_call_count) calls,
               SUM(CASE WHEN input_tokens+output_tokens>0 THEN 1 ELSE 0 END) with_tokens
        FROM sessions WHERE started_at >= ? AND started_at < ?`).get(sinceMs / 1000, untilMs / 1000);
      const n = Number(r.n || 0), tk = Number(r.tk || 0), calls = Number(r.calls || 0);
      if (n) available = true;
      byGateway.push({ gateway: "hermes", sessions: n, calls, tokens: tk, sessionsWithTokens: Number(r.with_tokens || 0), exact: true });
    } catch (e) { reason = reason || ("hermes 读取失败: " + e.message); }
    finally { try { hdb.close(); } catch { /* ignore */ } }
  } else {
    reason = reason || "未找到 ~/.hermes/state.db";
  }

  const tokens = byGateway.reduce((a, g) => a + int(g.tokens), 0);
  const calls = byGateway.reduce((a, g) => a + int(g.calls), 0);
  return {
    available: available || tokens > 0,
    exact: true,
    tokens,
    calls,
    byGateway: byGateway.filter((g) => g.tokens > 0 || g.calls > 0),
    note: "网关侧精确总量；与 agent 归因、平台内部调用**不可相加**。",
    reason: available ? null : reason,
  };
}

// ── 审计动作 → 五类（展示用，不参与验收） ─────────────────────────────────
const AUDIT_CLASS_RULES = [
  ["access", /ADMIN_READ|GRANT|REVOKE|KEY|PERMISSION|CAPABILITY_TIER|CLEANUP_LEGACY_PLAINTEXT|EXPIRE_STALE_KEYS|CLEANUP_ORPHAN_KEYS/],
  ["decision", /HUMAN_DECISION|APPROVE|REJECT|DEACTIVATE|REACTIVATE|NO_CHANNEL/],
  ["task", /DEPRECATE_SATISFIED|TASK_|MANUAL_CLOSE|FORCE_RELEASE|RELEASE_QUARANTINE|CLAIM_TICKET|TRIAGE_STALE|LEFTOVER_CAPPED/],
  ["asset", /^SET$|RETRACT|MERGE|ARCHIVE|SUPERSEDE|DOWNWEIGHT|ASSET/],
  // PURGE_NO_STEPS 是系统类 E2E 的真实动作（2026-10-26 五类审计），归 system 不归 asset。
  ["system", /PURGE|CLEANUP|REGISTER|EXPIRE|REFRESH|ISSUE_/],
];
function auditClass(action) {
  const a = String(action || "").toUpperCase();
  for (const [k, re] of AUDIT_CLASS_RULES) if (re.test(a)) return k;
  return "other";
}

// ── 取数 ──────────────────────────────────────────────────────────────────
async function collectBusinessSnapshot(opts = {}) {
  const base = await collectSnapshot(opts);
  const conn = await connect();
  const P = [base.window.from, base.window.to];
  const q = conn.query;
  const one = async (sql, p = []) => (await q(sql, p))[0] || {};
  const many = async (sql, p = []) => q(sql, p);
  try {
    // 1) DONE 按完成者拆分（与 flow.completed 同一 TST 窗口）
    const doneRows = await many(`
      SELECT COALESCE(t."completedBy",'(null)') AS by, COUNT(*)::int n
      FROM "TaskStateTransition" s JOIN "Task" t ON t.id = s."taskId"
      WHERE s."toStatus"='DONE' AND s."createdAt" BETWEEN $1::timestamp AND $2::timestamp
      GROUP BY 1 ORDER BY 2 DESC`, P);
    const doneByClass = { agent: 0, cron: 0, system: 0, other: 0, unknown: 0 };
    const doneByRaw = [];
    for (const r of doneRows) { doneByClass[classifyDone(r.by)] += int(r.n); doneByRaw.push({ by: r.by, n: int(r.n), cls: classifyDone(r.by) }); }

    // 2) 验收：窗口内按 source × verdict；7d 覆盖率
    const avRows = await many(`
      SELECT COALESCE(source,'(null)') AS src, verdict, COUNT(*)::int n, MAX("checkedAt") AS last
      FROM "AcceptanceVerdict"
      WHERE "checkedAt" BETWEEN $1::bigint AND $2::bigint
      GROUP BY 1,2 ORDER BY 1,2`, [Date.parse(base.window.from), Date.parse(base.window.to)]);
    const avAll = await many(`
      SELECT COALESCE(source,'(null)') AS src, verdict, COUNT(*)::int n, MAX("checkedAt") AS last
      FROM "AcceptanceVerdict" GROUP BY 1,2 ORDER BY 1,2`);
    const av = {
      runner: { pass: 0, fail: 0, total: 0, lastAt: null },
      shadow: { pass: 0, fail: 0, total: 0, lastAt: null },
      backfill: { pass: 0, fail: 0, total: 0, lastAt: null },
      other: { pass: 0, fail: 0, total: 0, lastAt: null },
    };
    const putAv = (bucket, r) => {
      const b = /shadow/i.test(r.src) ? bucket.shadow : /backfill/i.test(r.src) ? bucket.backfill : /runner/i.test(r.src) || r.src === "(null)" ? bucket.runner : bucket.other;
      if (String(r.verdict).toUpperCase() === "PASS") b.pass += int(r.n); else b.fail += int(r.n);
      b.total += int(r.n);
      if (r.last != null) { const at = new Date(Number(r.last)).toISOString(); if (!b.lastAt || at > b.lastAt) b.lastAt = at; }
    };
    for (const r of avRows) putAv(av, r);
    const avAllAgg = { runner: 0, shadow: 0, backfill: 0, other: 0 };
    for (const r of avAll) {
      const k = /shadow/i.test(r.src) ? "shadow" : /backfill/i.test(r.src) ? "backfill" : /runner/i.test(r.src) || r.src === "(null)" ? "runner" : "other";
      avAllAgg[k] += int(r.n);
    }
    const cov = await one(`
      SELECT COUNT(*)::int done,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "AcceptanceVerdict" v WHERE v."entityType"='Task' AND v."entityId"=t.id AND COALESCE(v.source,'') NOT IN ('shadow','backfill-ledger')))::int runner,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "AcceptanceVerdict" v WHERE v."entityType"='Task' AND v."entityId"=t.id))::int anyv,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "AcceptanceVerdict" v WHERE v."entityType"='Task' AND v."entityId"=t.id AND v.source='shadow'))::int shadow
      FROM "Task" t
      WHERE t.status='DONE' AND t."completedAt" BETWEEN $1::timestamp - interval '7 days' AND $2::timestamp`, P);

    // 3) 队列：never claimed + 首次认领等待
    const never = await one(`
      SELECT COUNT(*)::int n FROM "Task" t WHERE t.status='PENDING'
        AND NOT EXISTS (SELECT 1 FROM "TaskStateTransition" s WHERE s."taskId"=t.id AND s."toStatus"='IN_PROGRESS')`);
    const wait = await one(`
      WITH c AS (
        SELECT s."taskId", MIN(s."createdAt") AS first_claim
        FROM "TaskStateTransition" s
        WHERE s."toStatus"='IN_PROGRESS' AND COALESCE(s."fromStatus",'')<>'IN_PROGRESS'
          AND s."createdAt" BETWEEN $1::timestamp - interval '14 days' AND $2::timestamp
        GROUP BY 1
      )
      SELECT COUNT(*)::int sample,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.first_claim - t."createdAt"))/3600))::numeric,1) AS p50,
        ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.first_claim - t."createdAt"))/3600))::numeric,1) AS p90
      FROM c JOIN "Task" t ON t.id = c."taskId"`, P);

    // 4) 14d 日序列（UTC 自然日；用于趋势 + regime 标注）
    const histFrom = new Date(Date.parse(base.window.to) - 14 * 86400000).toISOString();
    const HP = [histFrom, base.window.to];
    const outDaily = await many(`
      SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD') d, 'Memory' tbl, COUNT(*)::int n FROM "Memory" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1
      UNION ALL SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD'), 'Knowledge', COUNT(*)::int FROM "Knowledge" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1
      UNION ALL SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD'), 'Practice', COUNT(*)::int FROM "Practice" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1
      UNION ALL SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD'), 'Skill', COUNT(*)::int FROM "Skill" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1`, HP);
    const newDaily = await many(`SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD') d, COUNT(*)::int n FROM "Task" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1`, HP);
    const claimDaily = await many(`SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD') d, COUNT(*)::int n FROM "TaskStateTransition" WHERE "toStatus"='IN_PROGRESS' AND COALESCE("fromStatus",'')<>'IN_PROGRESS' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1`, HP);
    const doneDaily = await many(`
      SELECT to_char(date_trunc('day',s."createdAt"),'YYYY-MM-DD') d,
        CASE WHEN t."completedBy" LIKE 'agent-%' THEN 'agent' WHEN t."completedBy" LIKE 'cron:%' THEN 'cron' WHEN t."completedBy" LIKE 'system:%' THEN 'system' ELSE 'other' END cls,
        COUNT(*)::int n
      FROM "TaskStateTransition" s JOIN "Task" t ON t.id=s."taskId"
      WHERE s."toStatus"='DONE' AND s."createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1,2`, HP);
    const structDaily = await many(`
      SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD') d, COUNT(*)::int n
      FROM (
        SELECT "createdAt" FROM "Memory" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
        UNION ALL SELECT "createdAt" FROM "Knowledge" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
        UNION ALL SELECT "createdAt" FROM "Practice" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
      ) x GROUP BY 1`, HP);

    const dayMap = new Map();
    const dayKey = (d) => String(d).slice(0, 10);
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.parse(histFrom) + i * 86400000).toISOString().slice(0, 10);
      dayMap.set(d, { date: d, newTasks: 0, claims: 0, done: 0, agentDone: 0, cronDone: 0, output: { Memory: 0, Knowledge: 0, Practice: 0, Skill: 0 }, structured: 0, regime: regimeOf(d).id });
    }
    for (const r of outDaily) { const x = dayMap.get(dayKey(r.d)); if (x) x.output[r.tbl] = int(r.n); }
    for (const r of newDaily) { const x = dayMap.get(dayKey(r.d)); if (x) x.newTasks = int(r.n); }
    for (const r of claimDaily) { const x = dayMap.get(dayKey(r.d)); if (x) x.claims = int(r.n); }
    for (const r of doneDaily) { const x = dayMap.get(dayKey(r.d)); if (!x) continue; x.done += int(r.n); if (r.cls === "agent") x.agentDone += int(r.n); if (r.cls === "cron") x.cronDone += int(r.n); }
    for (const r of structDaily) { const x = dayMap.get(dayKey(r.d)); if (x) x.structured = int(r.n); }
    const series = [...dayMap.values()];
    const zeroDays = series.filter((x) => x.newTasks === 0 && x.claims === 0 && x.done === 0).map((x) => x.date);

    // 5) 资产全貌 + 连接密度 + 双反思表
    const assetCount = async (sql) => { try { return int((await one(sql)).n); } catch { return null; } };
    const totals = {
      Memory: await assetCount(`SELECT COUNT(*)::int n FROM "Memory" WHERE "supersededBy" IS NULL`),
      Knowledge: await assetCount(`SELECT COUNT(*)::int n FROM "Knowledge" WHERE "supersededBy" IS NULL AND stale IS NOT TRUE`),
      Practice: await assetCount(`SELECT COUNT(*)::int n FROM "Practice" WHERE "supersededBy" IS NULL AND stale IS NOT TRUE`),
      Skill: await assetCount(`SELECT COUNT(*)::int n FROM "Skill" WHERE "supersededBy" IS NULL AND stale IS NOT TRUE`),
      Reflection: await assetCount(`SELECT COUNT(*)::int n FROM "Reflection" WHERE "supersededBy" IS NULL`),
      FlywheelReflection: await assetCount(`SELECT COUNT(*)::int n FROM "FlywheelReflection"`),
    };
    const linkCount = async (table, col) => { try { return int((await one("SELECT COUNT(DISTINCT \"" + col + "\")::int n FROM \"" + table + "\"")).n); } catch { return null; } };
    const connections = {
      memory: { linked: await linkCount("PracticeUsedMemoryLink", "practiceId"), total: totals.Practice },
      knowledge: { linked: await linkCount("PracticeKnowledgeLink", "practiceId"), total: totals.Practice },
      output: { linked: await linkCount("PracticeOutputLink", "practiceId"), total: totals.Practice },
      skill: { linked: await linkCount("PracticeSkillLink", "practiceId"), total: totals.Practice },
    };
    for (const k of Object.keys(connections)) connections[k].pct = pct(connections[k].linked, connections[k].total);
    const tiers = {}; try { for (const r of await many(`SELECT COALESCE(tier,'(null)') AS tier, COUNT(*)::int n FROM "Memory" WHERE "supersededBy" IS NULL GROUP BY 1 ORDER BY 2 DESC`)) tiers[r.tier] = int(r.n); } catch { /* ignore */ }
    const refStatus = {}; try { for (const r of await many(`SELECT COALESCE(status,'(null)') AS status, COUNT(*)::int n FROM "Reflection" WHERE "supersededBy" IS NULL GROUP BY 1`)) refStatus[r.status] = int(r.n); } catch { /* ignore */ }
    const fwRefStatus = {}; try { for (const r of await many(`SELECT COALESCE(status,'(null)') AS status, COUNT(*)::int n FROM "FlywheelReflection" GROUP BY 1`)) fwRefStatus[r.status] = int(r.n); } catch { /* ignore */ }
    let skillLegacy = null; try { const r = await one(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE legacy IS TRUE)::int legacy FROM "Skill" WHERE "supersededBy" IS NULL`); skillLegacy = { total: int(r.total), legacy: int(r.legacy), pct: pct(int(r.legacy), int(r.total)) }; } catch { /* ignore */ }

    // 6) 审计：动作分布 + 五类（本地墙钟窗口，与 canonical audit 一致）
    let auditByAction = [], auditClasses = { asset: 0, access: 0, decision: 0, task: 0, system: 0, other: 0 };
    try {
      auditByAction = (await many(`
        SELECT action, COUNT(*)::int n, to_char(MAX("createdAt"),'YYYY-MM-DD"T"HH24:MI:SS') AS last
        FROM "AuditLog"
        WHERE "createdAt" BETWEEN ($1::timestamptz AT TIME ZONE 'Asia/Shanghai') AND ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, P)).map((r) => ({ action: r.action, n: int(r.n), last: r.last ? r.last + "+08:00" : null, cls: auditClass(r.action) }));
      for (const r of auditByAction) auditClasses[auditClass(r.action)] += int(r.n);
    } catch { /* AuditLog 可能不可读 */ }

    // 7) 组织：认领/交付/空输出/活跃 agent
    const agentIdOf = (s) => String(s || "").replace(/^agent:/, "").replace(/^agent-/, "");
    let claimsByAgent = [];
    try { claimsByAgent = (await many(`SELECT COALESCE(actor,'(none)') AS agent, COUNT(*)::int n FROM "TaskStateTransition" WHERE "toStatus"='IN_PROGRESS' AND COALESCE("fromStatus",'')<>'IN_PROGRESS' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1 ORDER BY 2 DESC`, P)).map((r) => ({ agent: r.agent, agentId: agentIdOf(r.agent), n: int(r.n) })); } catch { /* ignore */ }
    let activeAgents = [];
    try { activeAgents = (await many(`SELECT agent_id AS id, display_name AS name, status, to_char(last_seen_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen FROM "AgentRegistry" WHERE agent_id LIKE 'agent-%' ORDER BY CASE WHEN status='ACTIVE' THEN 0 ELSE 1 END, last_seen_at DESC`)).map((r) => ({ id: r.id, name: r.name, status: r.status, lastSeenAt: r.last_seen })); } catch { /* ignore */ }

    // 8) LLM 调用按来源 + token 两层
    let llmBySource = [];
    try { llmBySource = (await many(`
      SELECT "sourceType" AS src, COUNT(*)::int calls,
        COUNT(*) FILTER (WHERE "targetStage"='OK')::int ok,
        COUNT(*) FILTER (WHERE "targetStage" LIKE 'FAIL:EMPTY%')::int empty,
        COUNT(*) FILTER (WHERE "targetStage" LIKE 'FAIL:RATE_LIMIT%')::int rate_limit
      FROM "FlywheelEvent" WHERE stage='CALL_LLM' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
      GROUP BY 1 ORDER BY 2 DESC`, P)).map((r) => ({ src: r.src, calls: int(r.calls), ok: int(r.ok), empty: int(r.empty), rateLimit: int(r.rate_limit), emptyPct: pct(int(r.empty), int(r.calls)), rateLimitPct: pct(int(r.rate_limit), int(r.calls)) })); } catch { /* ignore */ }
    const llmTotal = llmBySource.reduce((a, r) => a + r.calls, 0);
    const llmOk = llmBySource.reduce((a, r) => a + r.ok, 0);
    const llmEmpty = llmBySource.reduce((a, r) => a + r.empty, 0);
    const llmRate = llmBySource.reduce((a, r) => a + r.rateLimit, 0);
    let tokenCov = { events: 0, withTokens: 0, coveragePct: null };
    try {
      const r = await one(`
        SELECT COUNT(*)::int n,
          COUNT(*) FILTER (WHERE COALESCE((CASE WHEN left("sourceTitle",1) = '{' THEN ("sourceTitle"::jsonb)->>'tokens' ELSE NULL END)::numeric,0) > 0)::int with_tokens
        FROM "FlywheelEvent" WHERE stage='LLM_USE_REAL' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp`, P);
      tokenCov = { events: int(r.n), withTokens: int(r.with_tokens), coveragePct: pct(int(r.with_tokens), int(r.n)) };
    } catch { /* sourceTitle 可能不是 JSON */ }
    const platformTokens = { tokens: 0, exact: true, note: "平台内部 LLM 调用（CALL_LLM OK 的 tok= 精确值）" };
    try {
      const r = await one(`
        SELECT COALESCE(SUM(CASE WHEN stage='CALL_LLM' AND "targetStage"='OK' AND "sourceTitle" LIKE '%tok=%'
          THEN NULLIF(regexp_replace("sourceTitle", '.*tok=([0-9]+).*', '\\1'), "sourceTitle")::numeric ELSE 0 END),0) AS n
        FROM "FlywheelEvent" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp`, P);
      platformTokens.tokens = int(Math.round(Number(r.n || 0)));
    } catch { /* ignore */ }
    const gatewayTokens = collectGatewayTokens(base.window);

    // 9) 后端作业新鲜度
    let backend = { lastDoneAt: null, processing: 0, failed: 0 };
    try { const r = await one(`SELECT to_char(MAX("completedAt"),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last, COUNT(*) FILTER (WHERE status='PROCESSING')::int processing, COUNT(*) FILTER (WHERE status='FAILED')::int failed FROM "FlywheelJob"`); backend = { lastDoneAt: r.last || null, processing: int(r.processing), failed: int(r.failed) }; } catch { /* ignore */ }
    let extraction = { lastAt: null, ageHours: null };
    try { const r = await one(`SELECT MAX("extractedAt") AS last FROM "SessionExtractionState"`); const ms = r.last == null ? null : Number(r.last); if (ms) extraction = { lastAt: new Date(ms).toISOString(), ageHours: Number(((Date.now() - ms) / 3600000).toFixed(1)) }; } catch { /* ignore */ }

    const nowRegime = regimeOf(base.window.to);
    const regSeries = series.map((x) => x.regime);

    const business = {
      schema: BUSINESS_SCHEMA,
      generatedAt: new Date().toISOString(),
      sourceSnapshot: { schema: base.schema, generatedAt: base.generatedAt, window: base.window },
      regime: {
        current: nowRegime.id, label: nowRegime.label, since: nowRegime.from, note: nowRegime.note,
        boundaries: REGIMES.map((r) => ({ ...r })),
        windowRegimes: Array.from(new Set(regSeries)),
        comparable: new Set(regSeries).size <= 1,
      },
      delivery: {
        doneBy: doneByClass,
        doneByRaw,
        agentDone: doneByClass.agent,
        cronDone: doneByClass.cron,
        agentConversionPct: pct(doneByClass.agent, base.flow.claims),
        cronDonePct: pct(doneByClass.cron, base.flow.completed),
        acceptanceCoverage: {
          windowDays: 7, done: int(cov.done), runner: int(cov.runner), any: int(cov.anyv), shadow: int(cov.shadow),
          runnerPct: pct(int(cov.runner), int(cov.done)), anyPct: pct(int(cov.anyv), int(cov.done)),
          note: "正式验收=不含影子验收/历史回填；任一验收=含影子；两者不可混说。",
        },
      },
      acceptance: {
        window: av,
        allTime: avAllAgg,
        runner: { ...av.runner, note: "有否决权的验收；当前窗口 0 PASS 需单独说" },
        shadow: { ...av.shadow, note: "诊断；不改任务状态；是否进质量指标未定" },
        backfill: { ...av.backfill, note: "历史回填账本，不代表窗口内验收" },
        coverage: { windowDays: 7, done: int(cov.done), runner: int(cov.runner), any: int(cov.anyv), shadow: int(cov.shadow), runnerPct: pct(int(cov.runner), int(cov.done)), anyPct: pct(int(cov.anyv), int(cov.done)) },
      },
      queue: {
        neverClaimed: int(never.n),
        neverClaimedPct: pct(int(never.n), base.queue.PENDING),
        pending: base.queue.PENDING,
        age3dPct: pct(int(base.queue.ageBuckets["3-7d"]) + int(base.queue.ageBuckets[">7d"]), base.queue.PENDING),
        firstClaimWait: { p50Hours: wait.p50 == null ? null : Number(wait.p50), p90Hours: wait.p90 == null ? null : Number(wait.p90), sample: int(wait.sample) },
      },
      history: { days: 14, from: histFrom, to: base.window.to, series, zeroEventDays: zeroDays, note: "UTC 自然日；14 天内 R3 为主，跨 regime 不直接比。" },
      assets: {
        totals, tiers, connections,
        reflection: { legacy: totals.Reflection, topic: totals.FlywheelReflection, legacyStatus: refStatus, topicStatus: fwRefStatus, canonical: "undecided", note: "Reflection 与 FlywheelReflection 双表都在写；看板并列展示，不合并。" },
        skillLegacy,
        knowledgeStale: base.hygiene.staleFlagged.Knowledge,
        note: "总量为当前存量（未撤回、非 stale）；与调研稿 16:10 的数字不可直接对比（资产表被清理过）。",
      },
      cost: {
        gateway: gatewayTokens,
        platform: platformTokens,
        agent: { ...tokenCov, note: "responder 逐调用上报；上游常不返回 usage；只做归因参考，不与 gateway 相加。" },
        llm: { total: llmTotal, ok: llmOk, empty: llmEmpty, rateLimit: llmRate, okPct: pct(llmOk, llmTotal), emptyPct: pct(llmEmpty, llmTotal), rateLimitPct: pct(llmRate, llmTotal), bySource: llmBySource },
        unitPriceCny: null,
        note: "总 token 只取 gateway（通道级精确）；平台内部单列；agent 归因不相加；未配单价，不出精确 CNY。",
      },
      org: {
        claimsByAgent, activeAgents,
        activeCount: activeAgents.filter((a) => a.status === "ACTIVE").length,
        inactiveCount: activeAgents.filter((a) => a.status !== "ACTIVE").length,
        doneByAgent: doneByRaw.filter((r) => r.cls === "agent"),
        emptyOutputByAgent: llmBySource.filter((r) => String(r.src).startsWith("agent:")).map((r) => ({ agent: r.src, agentId: agentIdOf(r.src), calls: r.calls, empty: r.empty, emptyPct: r.emptyPct, rateLimit: r.rateLimit })),
        orphanRecoveries: base.delivery.taskRevived,
        claimSkipped: base.delivery.claimSkipped,
        note: "注册状态=心跳，不等于在工作；以近 1h 有交付/认领为准（当前 agent 交付 0）。孤儿回收用 TASK_REVIVED 作代理；公平性按任务类型×描述体量分层才可判。",
      },
      canonicalWarnings: [
        { field: "closedLoop.accepted/rejected", issue: "权威快照把影子验收计入窗口验收（本窗口 通过 11 / 失败 10 含 20 条影子验收）", use: "业务扩展 · 正式验收（0 通过 / 1 失败）", verify: "node scripts/flywheel-business-report.cjs --format=json" },
        { field: "flow.completed", issue: "完成含定时任务自动关单（本窗口 10/10 为定时任务）", use: "业务扩展 · 完成者拆分", verify: "node scripts/flywheel-business-report.cjs" },
        { field: "flow.conversionPct", issue: "总转化把定时任务计入分子，不等于智能体交付", use: "业务扩展 · 智能体转化", verify: "node scripts/flywheel-business-report.cjs" },
        { field: "consumption.usedOverInjectedPct", issue: "记使用只在提交成功时记，不是阅读率", use: "读报告人数 + 实时引用", verify: "node scripts/flywheel-report.cjs" },
      ],
      audit: {
        events: base.audit.events, highRisk: base.audit.highRisk, lastAt: base.audit.lastAt,
        byAction: auditByAction, classes: auditClasses,
        timezone: "Asia/Shanghai",
        note: "AuditLog 历史为本地墙钟（Asia/Shanghai）；与业务表 UTC 分开看，不迁移、不混算。",
      },
      freshness: {
        structuredLastAt: base.output.freshness.structuredLastAt,
        structuredAgeHours: base.output.freshness.structuredAgeHours,
        sessionExtractLastAt: base.output.freshness.sessionExtractLastAt,
        sessionExtractAgeHours: base.output.freshness.sessionExtractAgeHours,
        extractionLastAt: extraction.lastAt,
        extractionAgeHours: extraction.ageHours,
        verdictLastAt: base.closedLoop.verdictLastAt,
        verdictAgeHours: base.closedLoop.verdictAgeHours,
        backendLastDoneAt: backend.lastDoneAt,
        backendProcessing: backend.processing,
        backendFailed: backend.failed,
      },
      backend,
    };

    business.health = computeHealth(base, business);

    const noData = [];
    if (!gatewayTokens.available) noData.push({ key: "cost.gateway", label: "网关 token", reason: gatewayTokens.reason || "本机未找到网关 sqlite", verify: "node scripts/gateway-token-report.cjs --days=1 --json" });
    if (!tokenCov.events) noData.push({ key: "cost.agent", label: "逐 agent token 归因", reason: "窗口内无 LLM_USE_REAL 事件", verify: "node scripts/check-token-coverage.cjs" });
    else if ((tokenCov.coveragePct || 0) < 95) noData.push({ key: "cost.agent", label: "逐 agent token 归因", reason: "覆盖率 " + tokenCov.coveragePct + "% <95%（上游不返回 usage）", verify: "node scripts/check-token-coverage.cjs" });
    if (!av.shadow.total) noData.push({ key: "acceptance.shadow", label: "验收 shadow", reason: "窗口内无 shadow verdict", verify: "node scripts/acceptance/shadow-sweep.cjs --days=7 --limit=20" });
    if (!base.consumption.citations || !base.consumption.citations.events) noData.push({ key: "consumption.citations", label: "引用", reason: "窗口内无 ASSET_CITED 事件", verify: "node scripts/flywheel-report.cjs --format=json" });
    if (!wait.sample) noData.push({ key: "queue.firstClaimWait", label: "首次认领等待", reason: "14d 内无认领样本", verify: "node scripts/flywheel-report.cjs" });
    if (!auditByAction.length) noData.push({ key: "audit.byAction", label: "审计动作分布", reason: "窗口内无审计记录", verify: "node scripts/audit-report.cjs --days=1" });
    if (!extraction.lastAt) noData.push({ key: "freshness.extraction", label: "抽取账本", reason: "SessionExtractionState 无最后写入", verify: "node scripts/flywheel-report.cjs" });
    if ([connections.memory.linked, connections.knowledge.linked, connections.output.linked, connections.skill.linked].some((x) => x == null)) noData.push({ key: "assets.connections", label: "资产连接密度", reason: "连接表缺失或不可读", verify: "select count(*) from PracticeUsedMemoryLink" });
    business.noData = noData;

    return { ...base, business };
  } finally {
    await conn.end().catch(() => {});
  }
}

function computeHealth(base, b) {
  // 2026-10-27: 从“二元违规”改为“违规率”，避免同一件事（测试污染）在完整性和唯一性里各扣满一次。
  // 规则是建议分，不是验收口径；红线仍封顶 60。
  const items = [];
  const add = (key, label, weight, rate, detail, verify) => {
    const r = Math.max(0, Math.min(1, Number(rate) || 0));
    items.push({ key, label, weight, rate: Number(r.toFixed(2)), violation: r > 0, status: r > 0 ? "warn" : "ok", detail, verify });
  };
  const freshChecks = [
    (b.freshness.structuredAgeHours || 0) > 24,
    (b.freshness.extractionAgeHours || 0) > 24,
    (b.freshness.verdictAgeHours || 0) > 24,
    (b.freshness.backendProcessing || 0) > 0 && (b.freshness.backendLastDoneAt ? (Date.now() - Date.parse(b.freshness.backendLastDoneAt)) / 3600000 > 24 : true),
  ];
  add("freshness", "新鲜度", 30, freshChecks.filter(Boolean).length / freshChecks.length, "结构化 " + b.freshness.structuredAgeHours + "h / 账本 " + b.freshness.extractionAgeHours + "h / 验收 " + b.freshness.verdictAgeHours + "h / 后端最后成功 " + (b.freshness.backendLastDoneAt || "无"), "node scripts/flywheel-report.cjs");
  const nullHash = int(base.hygiene.nullContentHash.Memory) + int(base.hygiene.nullContentHash.Knowledge);
  const pollution = Object.values(base.hygiene.testPollution).reduce((a, x) => a + int(x), 0);
  add("completeness", "完整性", 20, (nullHash > 0 ? 0.5 : 0) + (pollution > 0 ? 0.5 : 0), "空指纹 " + nullHash + " / 测试污染 " + pollution, "node scripts/flywheel-report.cjs --format=json");
  add("consistency", "一致性", 20, b.assets.reflection.canonical !== "decided" ? 0.5 : 0, "反思双表未收口（Reflection / FlywheelReflection）", "node scripts/flywheel-report.cjs");
  add("uniqueness", "唯一性", 10, int(base.hygiene.duplicateHashGroups.Knowledge) > 0 ? 1 : (pollution > 0 ? 0.5 : 0), "重复组 " + base.hygiene.duplicateHashGroups.Knowledge + " / 污染 " + pollution, "node scripts/flywheel-report.cjs");
  const covPct = b.delivery.acceptanceCoverage.runnerPct;
  add("validity", "有效性", 20, covPct == null ? 1 : Math.max(0, 1 - covPct / 90), "近 7 天正式验收覆盖 " + (covPct == null ? "无数据" : covPct + "%") + "（目标 ≥90%）", "node scripts/check-flywheel-business.cjs");
  const raw = Math.round(100 - items.reduce((a, it) => a + it.weight * it.rate, 0));
  const redlines = [];
  // 2026-10-27: 0 条与 0.70% 在业务上都是“验收没接上”；红线按 <10% 判，避免“有 2 条就绿灯”的假安全。
  if (b.delivery.acceptanceCoverage.done > 0 && (covPct == null || covPct < 10)) redlines.push("近 7 天完成 " + b.delivery.acceptanceCoverage.done + " 条，正式验收覆盖 " + (covPct == null ? "无数据" : covPct + "%") + " <10%");
  if (int(base.hygiene.duplicateHashGroups.Knowledge) > 0) redlines.push("产物池有重复组 " + base.hygiene.duplicateHashGroups.Knowledge);
  if ((b.cost.agent.coveragePct || 0) < 95) redlines.push("逐智能体词元归因覆盖率 " + (b.cost.agent.coveragePct || 0) + "% <95%");
  if (b.assets.reflection.canonical !== "decided") redlines.push("反思权威表未定（双表）");
  const score = Math.max(0, Math.min(100, redlines.length ? Math.min(60, raw) : raw));
  return { score, raw, capped: redlines.length > 0, items, redlines, note: "建议分（v1 规则，按违规率扣分）；有红线时封顶 60。它衡量“数字能不能信”，不是业务 KPI。" };
}

function validateBusinessSnapshot(s) {
  const p = [];
  if (!s || s.schema !== SCHEMA) p.push("schema 不是 " + SCHEMA);
  if (!s.business || s.business.schema !== BUSINESS_SCHEMA) p.push("缺少 business.schema=" + BUSINESS_SCHEMA);
  const b = s.business || {};
  const d = b.delivery || {};
  if (d.doneBy) {
    const sum = Object.values(d.doneBy).reduce((a, x) => a + int(x), 0);
    if (sum !== int(s.flow && s.flow.completed)) p.push("doneBy 合计 " + sum + " ≠ flow.completed " + (s.flow && s.flow.completed));
  }
  if (b.history && Array.isArray(b.history.series)) {
    if (b.history.series.length !== 14) p.push("history.series 应为 14 天，实际 " + b.history.series.length);
    const bad = b.history.series.find((x) => !x.date || x.regime == null);
    if (bad) p.push("history.series 有缺日期/regime 的行");
  }
  if (b.cost && b.cost.gateway && b.cost.gateway.tokens != null && b.cost.gateway.tokens < 0) p.push("gateway token 为负");
  if (b.health && (b.health.score < 0 || b.health.score > 100)) p.push("health.score 越界");
  if (b.acceptance && b.acceptance.coverage) {
    const c = b.acceptance.coverage;
    if (c.runner > c.done || c.any > c.done) p.push("acceptance.coverage 分子大于分母");
  }
  return p;
}

module.exports = { collectBusinessSnapshot, validateBusinessSnapshot, BUSINESS_SCHEMA, REGIMES, regimeOf, classifyDone, auditClass };
