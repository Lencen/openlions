#!/usr/bin/env node
/**
 * flywheel-snapshot.cjs — 飞轮数据产出/消费的**单一事实源**（schema v1，2026-10-26）
 * ============================================================================
 * 为什么需要:
 *   1. 度量口径曾三处复制粘贴（consumption-live / -daily / -attribution），心跳续约口径
 *      修过一次后仍是三份 SQL —— 任何一处漏改就会再次漂移；
 *   2. 归因的 cause 占比只在 top-12 原因上求和，分母却是全部放回 -> 占比天然偏小；
 *   3. 只有"认领/完成"指标，没有"产出质量 + 消费效率"的同屏口径，agent 与人都要跑 4 个脚本；
 *   4. 每条脚本各自拼连接串、各自决定时区，PR 里已经出现过 UTC/本地差 8 小时的事故。
 *
 * 本模块只做三件事: **统一取数（SQL 只写一份）**、**稳定结构（schema 版本化）**、
 * **渲染（text / md / json / digest）**。不做写入、不改任何业务表。
 *
 * 使用:
 *   const { collectSnapshot, renderText, validateSnapshot } = require("./lib/flywheel-snapshot.cjs");
 *   const s = await collectSnapshot({ hours: 24 });
 *
 * CLI 见 scripts/flywheel-report.cjs（唯一推荐入口）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const SCHEMA = "lions.flywheel.snapshot/v1";
const TZ_NOTE = "所有时间在 SQL 会话内固定 UTC；对外输出 ISO-8601 Z。";

// ── 口径常量（改这里 = 改全平台口径，必须同步 bump SCHEMA 或写注释） ─────────────
// 认领口径: 只数真正"进入 IN_PROGRESS"的转移，排除心跳续约(IN_PROGRESS->IN_PROGRESS)。
const CLAIM_WHERE = `"toStatus"='IN_PROGRESS' AND ("fromStatus" IS NULL OR "fromStatus" <> 'IN_PROGRESS')`;
// 放回口径: PENDING / BLOCKED 的转入。
const RELEASE_STATUSES = ["PENDING", "BLOCKED"];
// 证据/通道阶段: 一次取全，避免下游再拼。
const EVENT_STAGES = [
  "SUBMIT_EXTERNAL_FAULT", "SUBMIT_CLAIMS_REJECTED", "SUBMIT_EVIDENCE_REJECTED",
  "SUBMIT_NO_CHANGE_DECLARED", "SUBMIT_NO_COMMIT_IN_WINDOW", "SUBMIT_NOT_OK",
  "TODO_CLOSE_EVIDENCE_REJECTED", "TODO_EVIDENCE_SHA_REQUIRED",
  "ACCEPTANCE_PASS", "ACCEPTANCE_FAIL",
  "CONTEXT_INJECTED", "CONTEXT_USED", "CONTEXT_QUERIED",
  "AGENT_OUTPUT_INGESTED", "CLAIM_SKIPPED", "TASK_REVIVED",
];

// ── 连接 ──────────────────────────────────────────────────────────────────
function readPw() {
  const direct = process.env.MIND_DATABASE_URL || process.env.DATABASE_URL || "";
  // 2026-10-26: 调用方常只给 `postgresql://lions@host/db`（不带密码，例如 check-consumption-guards 的 ENV）。
  // 密码文件仍从 run/pg-password 读，作为 connectionString 的补充；显式 PGPASSWORD 优先。
  let password = process.env.PGPASSWORD || "";
  if (!password) {
    try { password = fs.readFileSync(path.join(REPO, "run", "pg-password"), "utf8").trim(); } catch { /* 无密码文件 */ }
  }
  return { url: direct, password };
}

/** 打开只读 PG 会话（UTC）。调用方负责 end()。 */
async function connect(opts = {}) {
  // 2026-11-04（open 介质）：pnpm workspace 可能把 pg 装在 app 的 node_modules，根目录没有。
  //   与 lions-install 的 pgClient() 同口径，逐路径解析，避免"业务看板在 open 版打不开"。
  const bases = [REPO, path.join(REPO, "packages/apps/console"), path.join(REPO, "packages/apps/selfimproving"), process.cwd()]
    .filter(Boolean);
  let pgMod = null;
  for (const b of bases) {
    try { pgMod = require(require.resolve("pg", { paths: [b] })); break; } catch (_e) { /* 继续 */ }
  }
  if (!pgMod) throw new Error("找不到 pg 模块（业务看板需要 pg）：请先在安装根 pnpm install");
  const { Client } = pgMod;
  const cred = readPw();
  // 手写解析而不是 connectionString：pg 在有 connectionString 时会用 URL 里的 password(可能为 undefined)
  // 覆盖显式 password，导致运行期报 "client password must be a string"（2026-10-26 回归实测）。
  let cfg;
  if (cred.url) {
    const u = new URL(cred.url);
    cfg = {
      host: u.hostname || process.env.PGHOST || "127.0.0.1",
      port: Number(u.port || process.env.PGPORT || 5432),
      user: decodeURIComponent(u.username || "") || process.env.PGUSER || "lions",
      database: (u.pathname || "").replace(/^\//, "") || process.env.PGDATABASE || "lions_mind",
      password: decodeURIComponent(u.password || "") || cred.password || "",
    };
  } else {
    cfg = {
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || "lions",
      database: process.env.PGDATABASE || "lions_mind",
      password: cred.password || "",
    };
  }
  const client = new Client(cfg);
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  // 只读护栏: 本模块承诺不写。任何误写会在这里直接报错。
  await client.query("SET default_transaction_read_only = on").catch(() => {});
  const query = async (sql, params) => {
    try { return (await client.query(sql, params)).rows; }
    catch (e) { e.message = e.message + " [sql] " + String(sql).replace(/\s+/g, " ").slice(0, 220); throw e; }
  };
  return { client, query, end: () => client.end() };
}

// ── 窗口 ──────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, "0"); }
function localDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

/**
 * 三种窗口: 最近 N 小时 / 某个本地日 / 显式 from-to。
 * 返回 UTC ISO；本地日按服务器本地时区换算（与 consumption-daily 旧口径一致）。
 */
function resolveWindow(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  if (opts.from && opts.to) {
    const from = new Date(opts.from), to = new Date(opts.to);
    if (!(from < to)) throw new Error("window: from 必须早于 to");
    return { kind: "explicit", from: from.toISOString(), to: to.toISOString(), hours: +(((to - from) / 3600000).toFixed(2)), label: "显式窗口" };
  }
  if (opts.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error("window: --date 需要 YYYY-MM-DD");
    const start = new Date(opts.date + "T00:00:00");
    const end = new Date(start.getTime() + 86400000);
    return { kind: "day", from: start.toISOString(), to: end.toISOString(), hours: 24, label: "本地自然日 " + opts.date };
  }
  const hours = Number(opts.hours == null ? 24 : opts.hours);
  if (!(hours > 0) || hours > 24 * 90) throw new Error("window: hours 需在 (0, 2160]");
  const to = now;
  const from = new Date(to.getTime() - hours * 3600000);
  return { kind: "rolling", from: from.toISOString(), to: to.toISOString(), hours, label: "最近 " + hours + " 小时" };
}

// ── 取数 ──────────────────────────────────────────────────────────────────
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (a, b) => (b ? Number(((a / b) * 100).toFixed(2)) : null);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2)));

/** 最近一次真认领时间（用于 attribution 的"活跃窗口"自动识别）。 */
async function latestClaimAt() {
  const conn = await connect();
  try {
    // 列是 timestamp without time zone（存 UTC 墙钟）；node-pg 会按进程时区解析 -> 偏 8h。
    // 用 to_char 输出墙钟 UTC，调用方按 ::timestamp 传参即可严格对齐。
    const rows = await conn.query('SELECT to_char(MAX("createdAt"), \'YYYY-MM-DD"T"HH24:MI:SS.MS\') AS t FROM "TaskStateTransition" WHERE ' + CLAIM_WHERE);
    return rows[0] && rows[0].t ? rows[0].t + "Z" : null;
  } finally { await conn.end().catch(() => {}); }
}

const VIEW_LOG = path.join(REPO, "logs", "flywheel-report-views.jsonl");

/** 读取"谁看过这份数据"的消费日志（CLI --as 写入；纯文件，不写库）。 */
function readReportViews() {
  try {
    return fs.readFileSync(VIEW_LOG, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

async function collectSnapshot(opts = {}) {
  const window = resolveWindow(opts);
  const P = [window.from, window.to];
  const conn = await connect();
  const q = conn.query;
  try {
    const one = async (sql, p = []) => (await q(sql, p))[0] || {};
    const many = async (sql, p = []) => q(sql, p);

    // 1) 流: 认领/完成/放回/新增
    const flowRow = await one(`
      SELECT
        COUNT(*) FILTER (WHERE ${CLAIM_WHERE})::int AS claims,
        COUNT(DISTINCT "taskId") FILTER (WHERE ${CLAIM_WHERE})::int AS distinct_tasks,
        COUNT(*) FILTER (WHERE "toStatus"='DONE')::int AS done,
        COUNT(*) FILTER (WHERE "toStatus"='PENDING')::int AS to_pending,
        COUNT(*) FILTER (WHERE "toStatus"='BLOCKED')::int AS to_blocked
      FROM "TaskStateTransition" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp`, P);
    const created = int((await one('SELECT COUNT(*)::int c FROM "Task" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp', P)).c);

    // 2) 队列现状（窗口无关）+ 年龄结构 + 描述体量（可执行性代理指标）
    const queueRows = await many('SELECT status, COUNT(*)::int n FROM "Task" GROUP BY 1');
    const queue = { PENDING: 0, IN_PROGRESS: 0, BLOCKED: 0, DONE: 0, FAILED: 0, DEPRECATED: 0, DROPPED: 0 };
    for (const r of queueRows) queue[r.status] = int(r.n);
    const ageRows = await many(`
      SELECT CASE
        WHEN now()-"createdAt" < interval '1 day' THEN '<1d'
        WHEN now()-"createdAt" < interval '3 days' THEN '1-3d'
        WHEN now()-"createdAt" < interval '7 days' THEN '3-7d'
        ELSE '>7d' END AS bucket, COUNT(*)::int n
      FROM "Task" WHERE status='PENDING' GROUP BY 1`);
    const age = { "<1d": 0, "1-3d": 0, "3-7d": 0, ">7d": 0 };
    for (const r of ageRows) age[r.bucket] = int(r.n);
    const descRow = await one(`
      SELECT COUNT(*)::int n, ROUND(AVG(LENGTH(description)))::int avg_len,
             COUNT(*) FILTER (WHERE COALESCE(LENGTH(description),0)=0)::int empty,
             COUNT(*) FILTER (WHERE description ~ '(^|\n)\\s*([0-9]+[.、)]|[-*])')::int numbered
      FROM "Task" WHERE status='PENDING' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp`, P).catch(() => ({}));
    const pendingDesc = {
      sampled: int(descRow.n), avgChars: int(descRow.avg_len), empty: int(descRow.empty), numberedItems: int(descRow.numbered),
    };

    // 3) 归因: 对**全部**放回行分类（旧脚本只对 top-12 求和 -> 占比偏小）
    const causeRows = await many(`
      SELECT "toStatus" AS st,
        CASE
          WHEN COALESCE(reason,'') LIKE '[external-fault]%' THEN 'externalFault'
          WHEN COALESCE(reason,'') LIKE '%大脑通道不可用%' THEN 'brain'
          WHEN COALESCE(reason,'') LIKE '%租约%' OR COALESCE(reason,'') LIKE '%lease%' THEN 'leaseTtl'
          ELSE 'other' END AS cause,
        COUNT(*)::int n
      FROM "TaskStateTransition"
      WHERE "toStatus" IN ('PENDING','BLOCKED') AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
      GROUP BY 1,2 ORDER BY 3 DESC`, P);
    const causes = { brain: 0, leaseTtl: 0, externalFault: 0, other: 0 };
    // 2026-10-26 校正: 交接文的口径是「外部故障类 **BLOCKED** 占比」；旧 attribution 却用
    //   brain/(PENDING+BLOCKED) —— 标签与公式不一致，同一个数字能被读成 0% 或 33%。
    //   这里把两个分母都明确给出，verdict 用**BLOCKED 分母**（按标签），另出放回分母供排障。
    const blockedCauses = { brain: 0, leaseTtl: 0, externalFault: 0, other: 0 };
    for (const r of causeRows) {
      const target = r.st === 'BLOCKED' ? blockedCauses : causes;
      target[r.cause] = int(r.n);
    }
    const causeTotal = Object.values(causes).reduce((a, b) => a + b, 0) + Object.values(blockedCauses).reduce((a, b) => a + b, 0);
    const allCauses = Object.keys(causes).reduce((o, k) => (o[k] = causes[k] + blockedCauses[k], o), {});
    const causePct = Object.fromEntries(Object.entries(allCauses).map(([k, v]) => [k, pct(v, causeTotal)]));
    const blockedTotal = Object.values(blockedCauses).reduce((a, b) => a + b, 0);
    const blockedChannel = blockedCauses.brain + blockedCauses.externalFault;
    const blockedPct = {
      total: blockedTotal,
      channel: blockedChannel,
      channelPct: pct(blockedChannel, blockedTotal),
      byCause: Object.fromEntries(Object.entries(blockedCauses).map(([k, v]) => [k, pct(v, blockedTotal)])),
    };
    const releasePct = {
      total: causeTotal,
      channel: allCauses.brain + allCauses.externalFault,
      channelPct: pct(allCauses.brain + allCauses.externalFault, causeTotal),
    };
    const extPrefixRow = await one('SELECT COUNT(*)::int c FROM "TaskStateTransition" WHERE "toStatus" IN (\'PENDING\',\'BLOCKED\') AND reason LIKE \'[external-fault]%\' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp', P);
    const byAgentRows = await many(`
      SELECT COALESCE(("metadata"::jsonb)->>'beforeOwner','(none)') AS agent, COUNT(*)::int n
      FROM "TaskStateTransition"
      WHERE "toStatus" IN ('PENDING','BLOCKED') AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, P);
    const extBreakRows = await many(`
      SELECT CASE
        WHEN reason LIKE '%429%' OR reason LIKE '%用量上限%' OR reason LIKE '%quota%' THEN 'rateLimit'
        WHEN reason LIKE '%超时%' OR reason LIKE '%timeout%' THEN 'timeout'
        WHEN reason LIKE '%空输出%' THEN 'emptyOutput'
        WHEN reason LIKE '%仓库写锁%' THEN 'repoLock'
        WHEN reason LIKE '%HTTP%' THEN 'httpError'
        ELSE 'other' END AS t,
        COUNT(*)::int n
      FROM "TaskStateTransition"
      WHERE "toStatus" IN ('PENDING','BLOCKED') AND reason LIKE '[external-fault]%'
        AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
      GROUP BY 1 ORDER BY 2 DESC`, P);
    const topReasons = await many(`
      SELECT LEFT(COALESCE(reason,'?'),120) AS reason, COUNT(*)::int n
      FROM "TaskStateTransition"
      WHERE "toStatus" IN ('PENDING','BLOCKED') AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, P);

    // 4) 交付通道/闸门事件（一次取全窗口计数）
    const evRows = await many(`
      SELECT stage, COUNT(*)::int n FROM "FlywheelEvent"
      WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp AND stage = ANY($3::text[])
      GROUP BY 1`, [window.from, window.to, EVENT_STAGES]);
    const stages = Object.fromEntries(EVENT_STAGES.map((s) => [s, 0]));
    for (const r of evRows) stages[r.stage] = int(r.n);

    // 5) 验收: 新鲜度（AcceptanceVerdict.checkedAt 是 epoch ms bigint）
    const av = await one(`
      SELECT COUNT(*) FILTER (WHERE verdict='PASS' AND "checkedAt" BETWEEN $1::bigint AND $2::bigint)::int pass,
             COUNT(*) FILTER (WHERE verdict='FAIL' AND "checkedAt" BETWEEN $1::bigint AND $2::bigint)::int fail,
             MAX("checkedAt") AS last_ms,
             (SELECT verdict FROM "AcceptanceVerdict" ORDER BY "checkedAt" DESC LIMIT 1) AS last_verdict
      FROM "AcceptanceVerdict"`, [Date.parse(window.from), Date.parse(window.to)]);
    const lastMs = av.last_ms == null ? null : Number(av.last_ms);
    const staleH = lastMs ? Math.round((Date.now() - lastMs) / 3600000) : null;

    // 5b) 人类决策时延（Todo 是 bigint ms；2026-10-26 补：此前判为"未回放"，其实 SQL 直接可算）
    const hd = await one(`
      SELECT
        COUNT(*) FILTER (WHERE status='OPEN')::int open,
        COUNT(*) FILTER (WHERE status='DOING')::int doing,
        COUNT(*) FILTER (WHERE status='DONE')::int done,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ("doneAt"-"createdAt"))/3600000.0)::numeric, 1) AS p50_h,
        ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ("doneAt"-"createdAt"))/3600000.0)::numeric, 1) AS p90_h,
        to_char(to_timestamp((MAX("doneAt")/1000)::double precision), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_done
      FROM "Todo"
      WHERE source LIKE 'human-decision%' AND status IN ('OPEN','DOING','DONE')
        AND ("doneAt" IS NULL OR "doneAt" > 0)`);
    const humanDecision = {
      open: int(hd.open), doing: int(hd.doing), done: int(hd.done),
      p50Hours: hd.p50_h == null ? null : Number(hd.p50_h),
      p90Hours: hd.p90_h == null ? null : Number(hd.p90_h),
      lastDoneAt: hd.last_done || null,
    };

    // 6) 产出: 窗口内新增资产（按表 × sourceType），以及 FLYWHEEL_STRUCTURED 新鲜度
    const outputRows = await many(`
      SELECT 'Memory' AS tbl, COALESCE("sourceType",'(null)') AS src, COUNT(*)::int n FROM "Memory" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1,2
      UNION ALL
      SELECT 'Knowledge', COALESCE("sourceType",'(null)'), COUNT(*)::int FROM "Knowledge" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1,2
      UNION ALL
      SELECT 'Practice', COALESCE("sourceType",'(null)'), COUNT(*)::int FROM "Practice" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1,2
      UNION ALL
      SELECT 'Skill', COALESCE("source",'(null)'), COUNT(*)::int FROM "Skill" WHERE "createdAt" BETWEEN $1::timestamp AND $2::timestamp GROUP BY 1,2
      ORDER BY 1, 3 DESC`, P);
    const outputBySource = outputRows.map((r) => ({ table: r.tbl, sourceType: r.src, n: int(r.n) }));
    const outputTotals = outputBySource.reduce((o, r) => (o[r.table] = (o[r.table] || 0) + r.n, o), {});
    const fresh = await one(`
      SELECT
        to_char((SELECT MAX("createdAt") FROM "Memory" WHERE "sourceType"='FLYWHEEL_STRUCTURED'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS mem,
        to_char((SELECT MAX("createdAt") FROM "Knowledge" WHERE "sourceType"='FLYWHEEL_STRUCTURED'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS kn,
        to_char((SELECT MAX("createdAt") FROM "Practice" WHERE "sourceType"='FLYWHEEL_STRUCTURED'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pr,
        to_char((SELECT MAX("createdAt") FROM "Memory" WHERE "sourceType"='SESSION_EXTRACT'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sx`);
    const ageOf = (d) => (d ? Number(((Date.now() - new Date(d).getTime()) / 3600000).toFixed(1)) : null);
    const structuredLast = [fresh.mem, fresh.kn, fresh.pr].filter(Boolean).sort().pop() || null;

    // 7) 产出格式合规（近 24h；与 check-product-format.cjs 的 NORMAL 阈值同源）
    const MD = `(^|\\n)(#{1,6} |[-*] |[0-9]+\\. |\\*\\*)`;
    const EVASIVE = '(对话提到|暗示|未记录|无对应|未明确)';
    const fmt = async (sql) => (await one(sql, [])) || {};
    const kFmt = await fmt(`SELECT COUNT(*)::int n,
        COUNT(*) FILTER (WHERE LENGTH(title)>30)::int title_long,
        COUNT(*) FILTER (WHERE content !~ '${MD}')::int no_md,
        COUNT(*) FILTER (WHERE content ~ '${EVASIVE}' AND LENGTH(content)>=30)::int evasive,
        COUNT(*) FILTER (WHERE LENGTH(content)<50 AND content !~ '${MD}')::int short_empty
      FROM "Knowledge" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND (stale IS NOT TRUE) AND "createdAt" > now() - interval '24 hours'`);
    const mFmt = await fmt(`SELECT COUNT(*)::int n,
        COUNT(*) FILTER (WHERE content !~ '${MD}')::int no_md,
        COUNT(*) FILTER (WHERE content ~ '${EVASIVE}' AND LENGTH(content)>=50)::int evasive,
        COUNT(*) FILTER (WHERE LENGTH(content)<50 AND content !~ '${MD}')::int short_empty
      FROM "Memory" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "createdAt" > now() - interval '24 hours'`);
    const pFmt = await fmt(`SELECT COUNT(*)::int n,
        COUNT(*) FILTER (WHERE LENGTH(title)>30)::int title_long,
        COUNT(*) FILTER (WHERE description !~ '${MD}')::int no_md,
        COUNT(*) FILTER (WHERE description ~ '${EVASIVE}' AND LENGTH(description)>=30)::int evasive,
        COUNT(*) FILTER (WHERE LENGTH(description)<50 AND description !~ '${MD}')::int short_empty
      FROM "Practice" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND (stale IS NOT TRUE) AND "createdAt" > now() - interval '24 hours'`);
    const fmtRow = (r) => ({
      n: int(r.n), sampleAdequate: int(r.n) >= 10,
      titleLong: int(r.title_long), noMarkdown: int(r.no_md), evasive: int(r.evasive), shortEmpty: int(r.short_empty),
      titleLongPct: pct(int(r.title_long), int(r.n)), noMarkdownPct: pct(int(r.no_md), int(r.n)),
    });
    const format = { windowHours: 24, Knowledge: fmtRow(kFmt), Memory: fmtRow(mFmt), Practice: fmtRow(pFmt) };

    // 7b) 产物质量（与 fw-quality-guard 同口径：24h FLYWHEEL_STRUCTURED 的 avg/unscored/low + 全历史重复组）
    const qRows = await many(`
      SELECT 'Memory' AS tbl, COUNT(*)::int n, AVG("qualityScore")::float avg_q,
             COUNT(*) FILTER (WHERE "qualityScore" IS NULL OR "qualityScore"=0)::int unscored,
             COUNT(*) FILTER (WHERE "qualityScore" < 0.4)::int low
      FROM "Memory" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "createdAt" > now() - interval '24 hours'
      UNION ALL
      SELECT 'Knowledge', COUNT(*), AVG("qualityScore")::float,
             COUNT(*) FILTER (WHERE "qualityScore" IS NULL OR "qualityScore"=0),
             COUNT(*) FILTER (WHERE "qualityScore" < 0.4)
      FROM "Knowledge" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "createdAt" > now() - interval '24 hours'
      UNION ALL
      SELECT 'Practice', COUNT(*), AVG("qualityScore")::float,
             COUNT(*) FILTER (WHERE "qualityScore" IS NULL OR "qualityScore"=0),
             COUNT(*) FILTER (WHERE "qualityScore" < 0.4)
      FROM "Practice" WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "createdAt" > now() - interval '24 hours'`);
    const dupRows = await many(`
      SELECT t, COUNT(*)::int groups FROM (
        SELECT 'Memory' AS t, theme, "contentHash" FROM "Memory"
          WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "supersededBy" IS NULL AND "contentHash" IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1
        UNION ALL
        SELECT 'Knowledge', theme, "contentHash" FROM "Knowledge"
          WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "supersededBy" IS NULL AND "contentHash" IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1
        UNION ALL
        SELECT 'Practice', theme, "contentHash" FROM "Practice"
          WHERE "sourceType"='FLYWHEEL_STRUCTURED' AND "supersededBy" IS NULL AND "contentHash" IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1
      ) x GROUP BY 1`);
    const quality = { windowHours: 24, dupGroups: {}, byTable: {} };
    for (const r of qRows) quality.byTable[r.tbl] = {
      n: int(r.n), avg: r.avg_q == null ? null : Number(Number(r.avg_q).toFixed(3)),
      unscored: int(r.unscored), belowFloor: int(r.low),
    };
    for (const r of dupRows) quality.dupGroups[r.t] = int(r.groups);
    quality.totalN = Object.values(quality.byTable).reduce((a, t) => a + t.n, 0);
    quality.avg = quality.totalN
      ? Number((Object.values(quality.byTable).reduce((a, t) => a + (t.avg || 0) * t.n, 0) / quality.totalN).toFixed(3))
      : null;
    quality.dupTotal = Object.values(quality.dupGroups).reduce((a, b) => a + b, 0);

    // 8) 卫生: 测试污染 / 空指纹 / 重复组 / stale —— 产出可信度的底线
    const hyg = await one(`
      SELECT
        (SELECT COUNT(*)::int FROM "Knowledge" WHERE (title LIKE '自检%' OR theme IN ('t','test','smoke'))) AS k_test,
        (SELECT COUNT(*)::int FROM "Memory" WHERE (title LIKE '自检%' OR theme IN ('t','test','smoke'))) AS m_test,
        (SELECT COUNT(*)::int FROM "Skill" WHERE (name LIKE '自检%' OR theme IN ('t','test','smoke'))) AS s_test,
        (SELECT COUNT(*)::int FROM "Practice" WHERE (title LIKE '自检%' OR theme IN ('t','test','smoke'))) AS p_test,
        (SELECT COUNT(*)::int FROM "Memory" WHERE "contentHash" IS NULL AND "supersededBy" IS NULL) AS m_nohash,
        (SELECT COUNT(*)::int FROM "Knowledge" WHERE "contentHash" IS NULL AND "supersededBy" IS NULL) AS k_nohash,
        (SELECT COUNT(*)::int FROM (SELECT "contentHash" FROM "Knowledge" WHERE "contentHash" IS NOT NULL AND "supersededBy" IS NULL GROUP BY 1 HAVING COUNT(*)>1) d) AS k_dup_groups,
        (SELECT COUNT(*)::int FROM "Knowledge" WHERE stale IS TRUE) AS k_stale,
        (SELECT COUNT(*)::int FROM "Practice" WHERE stale IS TRUE) AS p_stale`);
    const hygiene = {
      testPollution: { Knowledge: int(hyg.k_test), Memory: int(hyg.m_test), Skill: int(hyg.s_test), Practice: int(hyg.p_test) },
      nullContentHash: { Memory: int(hyg.m_nohash), Knowledge: int(hyg.k_nohash) },
      duplicateHashGroups: { Knowledge: int(hyg.k_dup_groups) },
      staleFlagged: { Knowledge: int(hyg.k_stale), Practice: int(hyg.p_stale) },
    };
    const testTotal = Object.values(hygiene.testPollution).reduce((a, b) => a + b, 0);

    // 9) 消费: 注入 vs 使用（CONTEXT_USED 只在提交成功时记 -> 必须与注入并列展示，不能当"阅读率"）
    const injected = stages.CONTEXT_INJECTED;
    const used = stages.CONTEXT_USED;
    const views = readReportViews().filter((v) => v.at >= window.from && v.at < window.to);
    // 2026-10-26: 引用（ASSET_CITED）与审计（AuditLog）也进快照 —— 北极星前置 + 风险可见。
    const cite = await one(`
      SELECT COUNT(*)::int events, COUNT(DISTINCT "sourceId")::int tasks,
             COUNT(*) FILTER (WHERE "sourceType"='submit')::int live,
             COUNT(*) FILTER (WHERE "sourceType"='backfill')::int backfill
      FROM "FlywheelEvent" WHERE stage='ASSET_CITED' AND "createdAt" BETWEEN $1::timestamp AND $2::timestamp`, P);
    const auditRow = await one(`
      SELECT COUNT(*)::int events,
             COUNT(*) FILTER (WHERE action ~* '(MERGE|ARCHIVE|SUPERSEDE|DELETE|RETIRE|RELEASE|POLICY|HUMAN_DECISION|GRANT|REVOKE|PURGE)')::int high_risk,
             to_char(MAX("createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS"+08:00') AS last_at
      FROM "AuditLog" WHERE "createdAt" BETWEEN ($1::timestamptz AT TIME ZONE 'Asia/Shanghai') AND ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')`, P);
    const consumption = {
      injected, used, queried: stages.CONTEXT_QUERIED,
      usedOverInjectedPct: pct(used, injected),
      citations: { events: int(cite.events), tasks: int(cite.tasks), live: int(cite.live), backfill: int(cite.backfill) },
      reportViews: views.length,
      reportViewers: Array.from(new Set(views.map((v) => v.actor).filter(Boolean))).slice(0, 20),
      note: "used 仅在提交成功时计入（submit 一次性把本次注入的全部 id 记使用），因此它不是阅读率，只反映'注入后走完提交'的比例；reportViews 才是'这份数据被谁读过'。",
    };

    // 10) 判定（与 handoff 的四条验收一致；新增数据卫生为"提示"不参与 PASS/FAIL）
    const totalRelease = flowRow.to_pending + flowRow.to_blocked;
    const conversion = pct(flowRow.done, flowRow.claims);
    const churn = flowRow.distinct_tasks ? r2(flowRow.claims / flowRow.distinct_tasks) : null;
    const verdict = {
      conversion30: conversion != null && conversion >= 30,
      churn12: churn != null ? churn <= 1.2 : true,
      // 口径 = 交接文标签: 外部故障类在 **BLOCKED** 中的占比（不是全部放回）
      externalBlocked10: blockedTotal ? blockedPct.channelPct <= 10 : true,
      growth: flowRow.claims > 0 ? flowRow.done >= created : false,
      active: flowRow.claims > 0,
    };
    verdict.passed = verdict.active && verdict.conversion30 && verdict.churn12 && verdict.externalBlocked10 && verdict.growth;
    const notes = [];
    if (!verdict.active) notes.push("窗口内 0 认领：停摆/额度/通道问题，四条验收均不可判定（不挑窗口、不补数据）。");
    if (conversion != null && conversion < 30) notes.push("转化率 " + conversion + "% < 30%：瓶颈在交付链路，不是认领机制。");
    if (churn != null && churn > 1.2) notes.push("churn " + churn + " > 1.2：同一任务被重复认领。");
    if (blockedPct.channelPct != null && blockedPct.channelPct > 10) notes.push("外部故障类占 BLOCKED " + blockedPct.channelPct + "% > 10%（交接口径不达标）。");
    if (releasePct.channelPct != null && releasePct.channelPct > 10) notes.push("通道类放回占**全部放回** " + releasePct.channelPct + "%（≠ BLOCKED 口径）：这部分是交付通道浪费，先修通道。");
    if (testTotal > 0) notes.push("测试污染 " + testTotal + " 行仍在资产表（自检前缀/theme=t），会拉低检索质量。");
    if (structuredLast && ageOf(structuredLast) > 24) notes.push("结构化产物停更 " + ageOf(structuredLast) + " 小时（最后 " + structuredLast + "）。");
    if (quality.totalN > 0 && quality.avg != null && quality.avg < 0.55) notes.push("产物质量均分 " + quality.avg + " < 0.55（24h FLYWHEEL_STRUCTURED）。");
    if (quality.dupTotal > 0) notes.push("产物池全历史有 " + quality.dupTotal + " 组同 theme+contentHash 重复（非 superseded）。");

    return {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      window: { ...window, timezone: "UTC" },
      source: { kind: "postgres", database: process.env.PGDATABASE || "lions_mind", readOnly: true },
      queue: { ...queue, ageBuckets: age, pendingDescription: pendingDesc },
      flow: {
        claims: flowRow.claims, distinctTasks: flowRow.distinct_tasks, churn,
        completed: flowRow.done, conversionPct: conversion,
        released: { toPending: flowRow.to_pending, toBlocked: flowRow.to_blocked, total: totalRelease },
        newTasks: created, netGrowth: created - flowRow.done,
      },
      causes: {
        counts: allCauses, pct: causePct, total: causeTotal,
        blocked: { counts: blockedCauses, pct: blockedPct.byCause, total: blockedTotal, channelPct: blockedPct.channelPct },
        releaseShare: releasePct,
        externalFaultPrefix: int(extPrefixRow.c),
        externalBreakdown: Object.fromEntries(extBreakRows.map((r) => [r.t, int(r.n)])),
        byAgent: byAgentRows.map((r) => ({ agent: r.agent, n: int(r.n) })),
        topReasons: topReasons.map((r) => ({ reason: r.reason, n: int(r.n) })),
      },
      closedLoop: {
        // 以 AcceptanceVerdict 表为准（事件流 ACCEPTANCE_* 只作旁证，二者可能不同步）
        accepted: int(av.pass), rejected: int(av.fail),
        eventPass: stages.ACCEPTANCE_PASS, eventFail: stages.ACCEPTANCE_FAIL,
        lastVerdict: av.last_verdict || null,
        verdictLastAt: lastMs ? new Date(lastMs).toISOString() : null,
        verdictAgeHours: staleH,
        status: lastMs == null ? "no-data" : staleH > 24 ? "stale" : "fresh",
        humanDecision,
      },
      delivery: {
        submitExternalFaults: stages.SUBMIT_EXTERNAL_FAULT,
        claimsRejected: stages.SUBMIT_CLAIMS_REJECTED,
        evidenceRejected: stages.SUBMIT_EVIDENCE_REJECTED,
        noChangeDeclared: stages.SUBMIT_NO_CHANGE_DECLARED,
        noCommitInWindow: stages.SUBMIT_NO_COMMIT_IN_WINDOW,
        todoEvidenceRejected: stages.TODO_CLOSE_EVIDENCE_REJECTED,
        todoShaRequired: stages.TODO_EVIDENCE_SHA_REQUIRED,
        claimSkipped: stages.CLAIM_SKIPPED,
        taskRevived: stages.TASK_REVIVED,
      },
      output: {
        totals: outputTotals,
        bySource: outputBySource,
        freshness: {
          structuredLastAt: structuredLast,
          structuredAgeHours: ageOf(structuredLast),
          sessionExtractLastAt: fresh.sx,
          sessionExtractAgeHours: ageOf(fresh.sx),
        },
        format,
        quality,
      },
      consumption,
      audit: { events: int(auditRow.events), highRisk: int(auditRow.high_risk), lastAt: auditRow.last_at || null },
      hygiene,
      verdict,
      notes,
      meta: { tzNote: TZ_NOTE, claimDefinition: "进入 IN_PROGRESS 且非心跳续约", releaseDefinition: "转入 PENDING/BLOCKED", causeDefinition: "对全部放回行分类（非 top-N 求和）" },
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

// ── 校验 ──────────────────────────────────────────────────────────────────
/** 返回 problems: [] 表示结构/算术自洽。供 CI 与 CLI --check 用。 */
function validateSnapshot(s) {
  const p = [];
  if (!s || s.schema !== SCHEMA) p.push("schema 不是 " + SCHEMA);
  for (const k of ["generatedAt", "window", "queue", "flow", "causes", "closedLoop", "delivery", "output", "consumption", "hygiene", "verdict"]) {
    if (s == null || s[k] == null) p.push("缺字段 " + k);
  }
  if (!s || s.flow == null) return p;
  const f = s.flow;
  if (!(f.claims >= f.distinctTasks)) p.push("claims(" + f.claims + ") 应 >= distinctTasks(" + f.distinctTasks + ")");
  if (s.causes && s.causes.blocked && s.flow.released && Number(s.causes.blocked.total) !== Number(s.flow.released.toBlocked)) {
    p.push("causes.blocked.total(" + s.causes.blocked.total + ") != released.toBlocked(" + s.flow.released.toBlocked + ")");
  }
  if (s.causes && s.causes.releaseShare && Number(s.causes.releaseShare.total) !== Number(s.causes.total)) {
    p.push("causes.releaseShare.total != causes.total");
  }
  if (f.distinctTasks) {
    const churn = Number((f.claims / f.distinctTasks).toFixed(2));
    if (f.churn !== churn) p.push("churn=" + f.churn + " 与 claims/distinct=" + churn + " 不一致");
  }
  if (f.claims) {
    const conv = Number(((f.completed / f.claims) * 100).toFixed(2));
    if (f.conversionPct !== conv) p.push("conversionPct=" + f.conversionPct + " 与 completed/claims=" + conv + " 不一致");
  }
  const total = s.causes && s.causes.total;
  if (total) {
    const sum = Object.values(s.causes.pct).reduce((a, b) => a + (b || 0), 0);
    if (Math.abs(sum - 100) > 0.5) p.push("causes.pct 合计 " + sum + "% != 100%");
    const cnt = Object.values(s.causes.counts).reduce((a, b) => a + b, 0);
    if (cnt !== total) p.push("causes.counts 合计 " + cnt + " != total " + total);
  }
  if (s.closedLoop && s.closedLoop.status === "stale" && !(s.closedLoop.verdictAgeHours > 24)) p.push("closedLoop.status=stale 但 age<=24h");
  if (s.closedLoop && s.closedLoop.status === "fresh" && s.closedLoop.verdictAgeHours > 24) p.push("closedLoop.status=fresh 但 age>24h");
  if (s.verdict && s.verdict.active && f.claims === 0) p.push("verdict.active=true 但 claims=0");
  // 递归找 NaN/Infinity（JSON 里会变成 null，静默丢信息）
  const walk = (v, at) => {
    if (typeof v === "number" && !Number.isFinite(v)) p.push("非有限数 " + at);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, at + "[" + i + "]"));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], at + "." + k);
  };
  walk(s, "snapshot");
  return p;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────
const nz = (v, d = "-") => (v == null ? d : String(v));

function renderText(s) {
  const f = s.flow, q = s.queue, c = s.causes, d = s.delivery;
  const L = [];
  L.push("== 飞轮快照 · " + s.window.label + " · " + s.generatedAt + " ==");
  L.push("认领 " + f.claims + " / " + f.distinctTasks + " 任务 | churn " + (f.churn == null ? "-" : Number(f.churn).toFixed(2)) + " | 完成 " + f.completed + " | 转化率 " + (f.conversionPct == null ? "-" : f.conversionPct + "%"));
  L.push("放回 待认领 " + f.released.toPending + " / 隔离 " + f.released.toBlocked + " | 新增 " + f.newTasks + " | 净增 " + f.netGrowth);
  L.push("队列 PENDING " + q.PENDING + "（<1d " + q.ageBuckets["<1d"] + " / 1-3d " + q.ageBuckets["1-3d"] + " / 3-7d " + q.ageBuckets["3-7d"] + " / >7d " + q.ageBuckets[">7d"] + "）| 进行中 " + q.IN_PROGRESS + " | 隔离 " + q.BLOCKED + " | 已停用 " + q.DEPRECATED);
  L.push("放回归因 " + (c.total ? Object.entries(c.pct).map(([k, v]) => k + " " + v + "%(" + c.counts[k] + ")").join(" / ") : "-"));
  if (c.blocked) {
    L.push("外部故障占比 BLOCKED " + nz(c.blocked.channelPct) + "%（" + c.blocked.total + " 条隔离）| 全部放回 " + nz(c.releaseShare.channelPct) + "%（" + c.releaseShare.total + " 条）");
  }
  const eb = s.causes.externalBreakdown || {};
  L.push("交付通道 外部故障 " + d.submitExternalFaults + " | 认领被拒 " + d.claimsRejected + " | 证据驳回 " + d.evidenceRejected + " | 无改动声明 " + d.noChangeDeclared);
  L.push("外部故障构成 " + (Object.keys(eb).length ? Object.entries(eb).map(([k, v]) => k + " " + v).join(" / ") : "-"));
  L.push("验收新鲜度 " + s.closedLoop.status + "：窗口内 PASS " + s.closedLoop.accepted + " / FAIL " + s.closedLoop.rejected + " | 最后一次判定 " + nz(s.closedLoop.lastVerdict) + " @ " + nz(s.closedLoop.verdictLastAt) + "（" + nz(s.closedLoop.verdictAgeHours) + "h 前）");
  if (s.closedLoop.humanDecision) {
    const h = s.closedLoop.humanDecision;
    L.push("人工决策 未决 " + (h.open + h.doing) + "（OPEN " + h.open + " / DOING " + h.doing + "）| DONE " + h.done + " | 时延 p50 " + nz(h.p50Hours) + "h / p90 " + nz(h.p90Hours) + "h | 最后 " + nz(h.lastDoneAt));
  }
  L.push("产出 窗口内 " + Object.entries(s.output.totals).map(([k, v]) => k + " " + v).join(" / ") + " | 结构化停更 " + nz(s.output.freshness.structuredAgeHours) + "h | 会话提炼停更 " + nz(s.output.freshness.sessionExtractAgeHours) + "h");
  const kf = s.output.format.Knowledge;
  L.push("格式(24h FLYWHEEL_STRUCTURED) Knowledge n=" + kf.n + (kf.sampleAdequate ? "" : "(小样本)") + " title>30 " + kf.titleLong + " 无md " + kf.noMarkdown + " 逃避式 " + kf.evasive + " | Memory n=" + s.output.format.Memory.n + " | Practice n=" + s.output.format.Practice.n);
  const qy = s.output.quality || {};
  L.push("产物质量(24h) n=" + nz(qy.totalN) + " 均分=" + nz(qy.avg) + " 未打分=" + Object.values(qy.byTable || {}).reduce((a, t) => a + t.unscored, 0) + " 重复组=" + nz(qy.dupTotal));
  L.push("消费 注入 " + s.consumption.injected + " / 记使用 " + s.consumption.used + "（" + nz(s.consumption.usedOverInjectedPct) + "%）| 主动检索 " + s.consumption.queried + " | 读本报告 " + s.consumption.reportViews + (s.consumption.reportViewers.length ? "（" + s.consumption.reportViewers.join(",") + "）" : ""));
  if (s.consumption.citations) {
    const c = s.consumption.citations;
    L.push("引用 " + c.tasks + " 任务 / " + c.events + " 条（live " + c.live + " / backfill " + c.backfill + "）");
  }
  if (s.audit) L.push("审计 " + s.audit.events + " 条（高危 " + s.audit.highRisk + "）| 最后 " + nz(s.audit.lastAt) + "（本地）");
  L.push("卫生 测试污染 " + Object.values(s.hygiene.testPollution).reduce((a, b) => a + b, 0) + " | 空指纹 M/K " + s.hygiene.nullContentHash.Memory + "/" + s.hygiene.nullContentHash.Knowledge + " | K 重复组 " + s.hygiene.duplicateHashGroups.Knowledge);
  L.push("验收四条 " + JSON.stringify(s.verdict) + (s.verdict.passed ? "  ✅" : "  ❌"));
  for (const n of s.notes) L.push("! " + n);
  return L.join("\n");
}

function renderMarkdown(s) {
  const f = s.flow, q = s.queue, c = s.causes, d = s.delivery, o = s.output;
  const row = (k, v) => "| " + k + " | " + nz(v) + " |";
  const L = [];
  L.push("# 飞轮快照（" + s.window.label + "）");
  L.push("");
  L.push("> schema: `" + s.schema + "` ｜ 生成: " + s.generatedAt + " ｜ 窗口: " + s.window.from + " → " + s.window.to + "（UTC）");
  L.push("");
  L.push("## 一、结论");
  L.push("");
  L.push(row("四条验收", JSON.stringify(s.verdict)));
  L.push(row("通过", s.verdict.passed ? "是" : "否"));
  for (const n of s.notes) L.push("> ⚠ " + n);
  L.push("");
  L.push("## 二、流量与队列");
  L.push("");
  L.push("| 指标 | 值 |");
  L.push("|---|---|");
  L.push(row("认领次数 / 去重任务", f.claims + " / " + f.distinctTasks));
  L.push(row("churn", f.churn));
  L.push(row("完成 / 转化率", f.completed + " / " + (f.conversionPct == null ? "-" : f.conversionPct + "%")));
  L.push(row("放回（待认领 / 隔离）", f.released.toPending + " / " + f.released.toBlocked));
  L.push(row("新增 / 净增", f.newTasks + " / " + f.netGrowth));
  L.push(row("队列 PENDING（<1d / 1-3d / 3-7d / >7d）", q.PENDING + "（" + q.ageBuckets["<1d"] + " / " + q.ageBuckets["1-3d"] + " / " + q.ageBuckets["3-7d"] + " / " + q.ageBuckets[">7d"] + "）"));
  L.push("");
  L.push("## 三、放回归因（全量分类）");
  L.push("");
  L.push("| 原因 | 条数 | 占比 |");
  L.push("|---|---|---|");
  for (const k of Object.keys(c.counts)) L.push("| " + k + " | " + c.counts[k] + " | " + nz(c.pct[k]) + "% |");
  L.push("");
  L.push("## 四、交付通道与验收");
  L.push("");
  L.push("| 指标 | 值 |");
  L.push("|---|---|");
  L.push(row("SUBMIT_EXTERNAL_FAULT", d.submitExternalFaults));
  L.push(row("SUBMIT_CLAIMS_REJECTED", d.claimsRejected));
  L.push(row("SUBMIT_EVIDENCE_REJECTED", d.evidenceRejected));
  L.push(row("SUBMIT_NO_CHANGE_DECLARED", d.noChangeDeclared));
  L.push(row("外部故障构成", Object.entries(s.causes.externalBreakdown || {}).map(([k, v]) => k + " " + v).join(" / ") || "-"));
  L.push(row("外部故障占比（BLOCKED 口径，交接验收）", nz(s.causes.blocked && s.causes.blocked.channelPct) + "%（" + nz(s.causes.blocked && s.causes.blocked.total) + " 条）"));
  L.push(row("通道类放回占全部放回（排障口径）", nz(s.causes.releaseShare && s.causes.releaseShare.channelPct) + "%（" + nz(s.causes.releaseShare && s.causes.releaseShare.total) + " 条）"));
  L.push(row("验收状态 / 最后判定", s.closedLoop.status + " / " + nz(s.closedLoop.verdictLastAt)));
  if (s.closedLoop.humanDecision) {
    const h = s.closedLoop.humanDecision;
    L.push(row("人工决策（未决 / DONE / p50 / p90）", (h.open + h.doing) + " / " + h.done + " / " + nz(h.p50Hours) + "h / " + nz(h.p90Hours) + "h"));
  }
  L.push("");
  L.push("## 五、产出质量与消费");
  L.push("");
  L.push("| 指标 | 值 |");
  L.push("|---|---|");
  L.push(row("窗口内产出", Object.entries(o.totals).map(([k, v]) => k + " " + v).join(" / ")));
  L.push(row("结构化新鲜度", nz(o.freshness.structuredAgeHours) + "h"));
  L.push(row("K 格式（n / title>30 / 无md / 逃避式）", o.format.Knowledge.n + " / " + o.format.Knowledge.titleLong + " / " + o.format.Knowledge.noMarkdown + " / " + o.format.Knowledge.evasive));
  L.push(row("产物质量（n / 均分 / 未打分 / 重复组）", nz(s.output.quality.totalN) + " / " + nz(s.output.quality.avg) + " / " + Object.values(s.output.quality.byTable).reduce((a, t) => a + t.unscored, 0) + " / " + nz(s.output.quality.dupTotal)));
  L.push(row("注入 / 记使用 / 比例", s.consumption.injected + " / " + s.consumption.used + " / " + nz(s.consumption.usedOverInjectedPct) + "%"));
  L.push(row("读本报告（次数 / 读者）", s.consumption.reportViews + " / " + (s.consumption.reportViewers.join(",") || "-")));
  L.push(row("引用（任务 / 条数 / live / backfill）", s.consumption.citations ? s.consumption.citations.tasks + " / " + s.consumption.citations.events + " / " + s.consumption.citations.live + " / " + s.consumption.citations.backfill : "-"));
  L.push(row("审计（窗口内 / 高危）", s.audit ? s.audit.events + " / " + s.audit.highRisk : "-"));
  L.push(row("测试污染（K/M/S/P）", Object.values(s.hygiene.testPollution).join(" / ")));
  L.push("> " + s.consumption.note);
  L.push("");
  return L.join("\n");
}

/** 给 agent/prompt 用的一行摘要（≤ 420 字符，不含换行）。 */
function renderDigest(s) {
  const f = s.flow;
  const d = [
    "飞轮[" + s.window.label + "]",
    "认领" + f.claims + "/完成" + f.completed + (f.conversionPct == null ? "" : "(" + f.conversionPct + "%)"),
    "churn" + (f.churn == null ? "-" : Number(f.churn).toFixed(2)),
    "待认领" + s.queue.PENDING + "/隔离" + s.queue.BLOCKED,
    "放回归因" + (s.causes.total ? Object.entries(s.causes.pct).map(([k, v]) => k + v + "%").join(",") : "-"),
    "外部故障" + s.delivery.submitExternalFaults,
    "验收" + s.closedLoop.status,
    "注入" + s.consumption.injected + "/用" + s.consumption.used,
    s.verdict.passed ? "达标" : "未达标",
  ].join(" | ");
  return d.slice(0, 420);
}

module.exports = {
  SCHEMA, REPO, connect, resolveWindow, latestClaimAt, collectSnapshot, validateSnapshot,
  renderText, renderMarkdown, renderDigest,
};
