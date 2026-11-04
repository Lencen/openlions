/**
 * tasks-source.ts — 统一定时任务数据源
 * 2026-09-02 v2:
 *   - 重命名 source -> trigger (触发方式: crontab / openclaw-jobs / service-cron / script)
 *   - 新增 business 字段: 业务来源 (项目/业务: LIONS-飞轮管线 / 缠论量化选股 等)
 *   - 字段名更准确, 旧字段名 source 仍保留以兼容已渲染的 tab 标题
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";

export interface Task {
  id: string;
  name: string;
  trigger: "crontab" | "openclaw-jobs" | "service-cron" | "script";  // 触发方式
  type: "cron" | "interval" | "manual";
  business: string;                                                // 业务来源 (项目/业务)
  schedule: string;          // cron 表达式 或 间隔描述
  description: string;       // 任务做什么
  command: string;           // 实际执行的命令
  agent: string;             // 哪个 agent 执行 (or "-" if shell/system)
  agentPlatform: "hermes" | "openclaw" | "dsh" | "node" | "shell";
  enabled: boolean;
  logFile: string | null;
  sessionKey: string | null;
}

interface CrontabEntry {
  raw: string;
  schedule: string;
  command: string;
  business: string;
  description: string;
  agent: string;
  agentPlatform: Task["agentPlatform"];
  logFile: string | null;
  sessionKey: string | null;
}

// ===== 业务来源识别 (从 command / 路径 / 脚本名启发式) =====
function detectBusiness(command: string, hintName?: string): string {
  const c = command.toLowerCase();
  const h = (hintName || "").toLowerCase();
  // 缠论量化选股: stock-screener / chanlun / chanlun-scan
  if (c.includes("stock-screener") || c.includes("chanlun") || c.includes("chanlun-scan") || h.includes("chanlun")) return "缠论量化选股";
  // Learning Hub: pipeline-dev agent + learning-hub
  if (c.includes("learning-hub") || c.includes("projects-learning-hub") || h.includes("learning-hub")) return "Learning-Hub";
  // LIONS-飞轮管线: flywheel cron (lions-flywheel + reflections/structured/improving/reflection-bridge)
  if (c.includes("lions-flywheel-cron") || c.includes("flywheel/") || c.includes("improving-tasks/cron") || c.includes("reflection-bridge/cron")) return "LIONS-飞轮管线";
  // LIONS-平台维护: lions-sync / hermes-db-backup / dsh-session-sync
  if (c.includes("lions-sync-cron") || c.includes("hermes-db-backup") || c.includes("dsh-session-sync") || c.includes("lions-process-registry")) return "LIONS-平台维护";
  // OpenClaw-平台健康: tools-allowlist-health
  if (c.includes("tools-allowlist") || h.includes("tools-allowlist")) return "OpenClaw-平台健康";
  // LIONS-平台健康: selfimproving scheduler (Task Scheduler / Stuck Task / Problem Auto Resolver)
  if (h.includes("task-scheduler") || h.includes("stuck-task") || h.includes("problem-auto-resolver")) return "LIONS-平台健康";
  // session-服务内部: hermes-sync 服务内自循环
  if (h.includes("hermes-sync")) return "session-服务内部";
  return "未分类";
}

function describeTask(command: string): string {
  if (command.includes("lions-flywheel-cron.sh")) return "飞轮管线的核心 cron: scan+run 增量提取, 每小时 :35 触发 sessionRegistry 处理";
  if (command.includes("reflections/cron")) return "反思 cron: 拉主题触发反思 worker";
  if (command.includes("structured/cron")) return "结构化 cron: 碎片化反思内容";
  if (command.includes("improving-tasks/cron")) return "改进任务 cron: 批量执行 pending ImprovingTask";
  if (command.includes("reflection-bridge/cron")) return "反思→任务桥接 cron: 把高优先级反思挂载为 task";
  if (command.includes("dsh-session-sync.py")) return "DSH 会话同步: ~/.dsh/sessions → session 服务 (增量检测, 避开'存在即跳过')";
  if (command.includes("lions-sync-cron.sh")) return "LIONS session 同步: agent-e + agent-operator 增量同步到 session 服务";
  if (command.includes("lions-hermes-db-backup")) return "hermes state.db 日终备份";
  if (command.includes("stock-screener/run-observe")) return "缠论盘中观察扫描 (chanlun-scan.js observe)";
  if (command.includes("stock-screener/run-final")) return "缠论尾盘最终推荐扫描 (推飞书群)";
  return "";
}

function detectPlatform(command: string): Task["agentPlatform"] {
  const c = command.toLowerCase();
  if (c.includes("~/.dsh") || c.includes("dsh-session-sync")) return "dsh";
  if (c.includes(".hermes") || c.includes("hermes_db") || c.includes("hermes-state")) return "hermes";
  if (c.includes(".openclaw") || c.includes("openclaw")) return "openclaw";
  if (c.startsWith("node ") || c.startsWith("/usr/bin/node") || c.includes("/node_modules/")) return "node";
  return "shell";
}

function detectAgent(command: string): string {
  if (command.includes("dsh-session-sync")) return "agent-d";
  if (command.includes("lions-flywheel-cron") || command.includes("flywheel") || command.includes("mind")) return "agent-mix (mind)";
  if (command.includes("openclaw") || command.includes("agent-")) {
    const m = command.match(/agent-([a-z]+)/i);
    if (m) return "agent-" + m[1];
  }
  if (command.includes("stock-screener") || command.includes("chanlun")) return "agent-main (openclaw)";
  if (command.includes("hermes")) return "agent-e/agent-x (hermes)";
  return "-";
}

// ===== 1) 读 crontab =====
function readCrontab(): CrontabEntry[] {
  let raw = "";
  try { raw = execSync("crontab -l 2>/dev/null", { encoding: "utf8" }); } catch { return []; }
  const out: CrontabEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
    if (!m) continue;
    const [, schedule, command] = m;
    const business = detectBusiness(command);
    if (command.includes("~/.local/bin/lions-hermes-db-backup")) {
      out.push({ raw: line, schedule, command, business,
        description: "hermes state.db 日终备份",
        agent: "-", agentPlatform: "shell", logFile: "~/lions/logs/hermes-db-backup.log", sessionKey: null });
      continue;
    }
    if (command.includes("~/.openclaw/workspace/lions-flywheel-cron.sh")) {
      out.push({ raw: line, schedule, command, business,
        description: "飞轮核心 cron: scan+run 增量提取",
        agent: detectAgent(command), agentPlatform: detectPlatform(command),
        logFile: "/tmp/lions-flywheel.log", sessionKey: null });
      continue;
    }
    if (command.includes("~/.local/bin/lions-sync-cron.sh")) {
      out.push({ raw: line, schedule, command, business,
        description: "LIONS session 增量同步 (agent-x/operator/agent-x)",
        agent: "agent-e + agent-operator + agent-d", agentPlatform: detectPlatform(command),
        logFile: "~/lions/logs/lions-sync-cron.log", sessionKey: null });
      continue;
    }
    if (command.includes("flywheel/reflections/cron") || command.includes("flywheel/structured/cron") || command.includes("flywheel/improving-tasks/cron") || command.includes("reflection-bridge/cron")) {
      out.push({ raw: line, schedule, command, business,
        description: describeTask(command),
        agent: detectAgent(command), agentPlatform: "node",
        logFile: "/tmp/lions-flywheel.log", sessionKey: null });
      continue;
    }
    if (command.includes("stock-screener/run-observe") || command.includes("stock-screener/run-final")) {
      out.push({ raw: line, schedule, command, business,
        description: describeTask(command),
        agent: "agent-main (openclaw)", agentPlatform: "openclaw",
        logFile: command.includes("final") ? "/tmp/chanlun-final.log" : "/tmp/chanlun-observe.log",
        sessionKey: null });
      continue;
    }
    out.push({ raw: line, schedule, command, business,
      description: describeTask(command) || t.slice(0, 80),
      agent: detectAgent(command), agentPlatform: detectPlatform(command),
      logFile: null, sessionKey: null });
  }
  return out;
}

interface OpenClawJob {
  id: string; name: string; agentId: string; sessionKey: string;
  enabled: boolean; createdAtMs: number;
  schedule: { kind: string; expr?: string; tz?: string; everyMinutes?: number };
  payload: { kind: string; message?: string; timeoutSeconds?: number };
  delivery?: { mode: string; channel?: string; to?: string };
}

function readOpenClawJobs(): Task[] {
  const p = path.join(process.env.HOME || "~", ".openclaw/cron/jobs.json");
  if (!fs.existsSync(p)) return [];
  let data: { jobs: OpenClawJob[] };
  try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
  return (data.jobs || []).map((j) => {
    let schedule = "";
    if (j.schedule.kind === "cron") schedule = j.schedule.expr || "cron";
    else if (j.schedule.kind === "interval") schedule = `every ${j.schedule.everyMinutes || "?"}min`;
    else schedule = JSON.stringify(j.schedule);
    const desc = (j.payload?.message || "").split("\n").find((l) => l.trim() && !l.startsWith("```") && !l.startsWith("cd ")) || j.payload?.message?.split("\n")[0] || "";
    const business = detectBusiness(j.payload?.message || "", j.name);
    return {
      id: `openclaw-job:${j.id}`,
      name: j.name,
      trigger: "openclaw-jobs",
      type: j.schedule.kind === "cron" ? "cron" : j.schedule.kind === "interval" ? "interval" : "manual",
      business,
      schedule,
      description: desc.slice(0, 200),
      command: (j.payload?.message || "").slice(0, 200),
      agent: j.agentId,
      agentPlatform: "openclaw",
      enabled: j.enabled,
      logFile: `~/.openclaw/cron/runs/${j.id}.jsonl`,
      sessionKey: `cron:${j.id}`,
    } as Task;
  });
}

// ===== 3) 服务内 node-cron (静态清单) =====
const SERVICE_CRON: Task[] = [
  {
    id: "service-cron:session:hermes-sync",
    name: "hermes session 同步",
    trigger: "service-cron",
    type: "interval",
    business: "session-服务内部",
    schedule: "*/10 * * * *",
    description: "session 服务 (port 3002) 自循环: 拉 hermes state.db / scan-sources 增量同步, 写回 mind",
    command: "node-cron @ lib/scheduler.ts:23",
    agent: "-",
    agentPlatform: "node",
    enabled: true,
    logFile: "~/lions/logs/session-dev.log",
    sessionKey: null,
  },
  {
    id: "service-cron:selfimproving:task-scheduler",
    name: "Task Scheduler (consume pending)",
    trigger: "service-cron",
    type: "interval",
    business: "LIONS-平台健康",
    schedule: "*/2 * * * *",
    description: "自我改进服务: 消费 PENDING task + completion trigger + V3 Generator (反思聚类 → task)",
    command: "node-cron @ scheduler.ts:517",
    agent: "-",
    agentPlatform: "node",
    enabled: true,
    logFile: "~/lions/logs/selfimproving-dev.log",
    sessionKey: null,
  },
  {
    id: "service-cron:selfimproving:stuck-task-reset",
    name: "Stuck Task Reset + Cluster Expire",
    trigger: "service-cron",
    type: "interval",
    business: "LIONS-平台健康",
    schedule: "*/1 * * * *",
    description: "清 stuck task + 过期 task cluster, 防 V3 race (5min→1min 修复)",
    command: "node-cron @ scheduler.ts:567",
    agent: "-",
    agentPlatform: "node",
    enabled: true,
    logFile: "~/lions/logs/selfimproving-dev.log",
    sessionKey: null,
  },
  {
    id: "service-cron:selfimproving:problem-resolver",
    name: "Problem Auto Resolver",
    trigger: "service-cron",
    type: "interval",
    business: "LIONS-平台健康",
    schedule: "*/2 * * * *",
    description: "处理 open problems + completion triggers",
    command: "node-cron @ scheduler.ts:632",
    agent: "-",
    agentPlatform: "node",
    enabled: true,
    logFile: "~/lions/logs/selfimproving-dev.log",
    sessionKey: null,
  },
];

let _cache: { ts: number; data: Task[] } | null = null;
const CACHE_MS = 30000;

export function getAllTasks(): Task[] {
  if (_cache && Date.now() - _cache.ts < CACHE_MS) return _cache.data;
  const tasks: Task[] = [];
  for (const e of readCrontab()) {
    // 2026-09-02 修复: crontab ID 含空格/斜杠, 详情页 URL 匹配失败 → 404.
    // 改用 8 位 hash (基于 raw 整行) 保持唯一性 + URL 安全
    // no-require-imports: 改为顶部 `import { createHash } from "crypto"`, 与 require("crypto") 同一个模块、同一个函数
    const idHash = createHash("md5").update(e.raw).digest("hex").slice(0, 8);
    const slug = e.command.split("/").pop() || e.command.slice(0, 20);
    tasks.push({
      id: `crontab:${idHash}-${slug.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 30)}`,
      name: e.description || e.command.split("/").pop() || e.command.slice(0, 60),
      trigger: "crontab",
      type: "cron",
      business: e.business,
      schedule: e.schedule,
      description: e.description,
      command: e.command,
      agent: e.agent,
      agentPlatform: e.agentPlatform,
      enabled: true,
      logFile: e.logFile,
      sessionKey: e.sessionKey,
    });
  }
  tasks.push(...readOpenClawJobs());
  tasks.push(...SERVICE_CRON);
  _cache = { ts: Date.now(), data: tasks };
  return tasks;
}

export function getTaskById(id: string): Task | null {
  return getAllTasks().find((t) => t.id === id) || null;
}

export interface ExecutionRecord {
  ts: number;
  status: "ok" | "error" | "running" | "unknown";
  durationMs?: number;
  summary: string;
  detail: string;
  source: "log" | "session";
}

export function getExecutionRecords(task: Task, limit = 20): ExecutionRecord[] {
  // D-16 (2026-09-07): sessionKey 任务改走异步 getCronSessionRecordsAsync (调用方已用);
  //   同步 stub 已删除, 此处只处理 logFile 任务, 避免误导
  if (task.logFile && fs.existsSync(task.logFile)) {
    return getLogTailRecords(task.logFile, limit);
  }
  return [];
}

function getLogTailRecords(file: string, limit: number): ExecutionRecord[] {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(stat.size - limit * 800, 0);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean).slice(-limit);
    return lines.map((line) => {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
      let ts = Date.now();
      let summary = line;
      let status: ExecutionRecord["status"] = "unknown";
      if (m) {
        ts = new Date(m[1].replace(" ", "T") + "+08:00").getTime();
        summary = m[2];
      }
      const lower = line.toLowerCase();
      if (lower.includes("error") || lower.includes("[err]") || lower.includes("failed") || lower.includes("fail")) status = "error";
      else if (lower.includes("done") || lower.includes("完成") || lower.includes("200")) status = "ok";
      else if (lower.includes("start") || lower.includes("syncing")) status = "running";
      return { ts, status, summary: summary.slice(0, 200), detail: line.slice(0, 500), source: "log" };
    });
  } catch { return []; }
}

import { prisma } from "./prisma";

export async function getCronSessionRecordsAsync(sessionKey: string, limit = 20): Promise<ExecutionRecord[]> {
  const sourceId = sessionKey;
  try {
    const session = await prisma.session.findFirst({
      where: { sourceId },
      select: { id: true },
    });
    if (!session) return [];
    const messages = await prisma.message.findMany({
      where: { sessionId: session.id, role: "tool" },
      orderBy: { timestamp: "desc" },
      take: limit,
      select: { timestamp: true, content: true, toolName: true },
    });
    return messages.map((m) => {
      const ts = m.timestamp?.getTime() || Date.now();
      const line = m.content || "";
      const lower = line.toLowerCase();
      let status: ExecutionRecord["status"] = "unknown";
      if (lower.includes("error") || lower.includes("error:") || lower.includes("failovererror") || lower.includes("failed")) status = "error";
      else if (lower.includes("ok") || line.startsWith("[cron run ok]")) status = "ok";
      return {
        ts,
        status,
        summary: line.split("\n")[0].slice(0, 200),
        detail: line.slice(0, 500),
        source: "session",
      };
    });
  } catch { return []; }
}
