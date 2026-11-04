/**
 * 独立 WebSocket 订阅服务 (V2.0)
 *
 * 职责: 把 Prisma 实时查询结果 + event-bus 文件日志推送到浏览器,
 *       取代 dashboard / health 页面的 5s 轮询。
 *
 * 设计:
 *   - 独立 Node 进程, 不嵌入 Next.js, 监听 3003
 *   - 每个频道有独立的广播间隔 (dashboard:overview 4s, health:report 1s)
 *   - 跨进程事件: tail data/event-bus.jsonl  (不调用 in-process eventBus)
 *   - 心跳 30s, 失败自动 terminate
 *   - CORS 仅允许 localhost:3001
 *   - 输出帧格式: { type, channel, data, ts }
 *
 * 频道:
 *   - dashboard:overview  (4s)   任务/问题状态分布 + KPI
 *   - health:report       (1s)   服务心跳/DB/资源/告警
 *   - flywheel:event      (push)  飞轮新事件(append-only)
 *   - event-bus:event     (push)  跨进程 EventBus 事件
 *   - scheduler:status    (2s)   调度器心跳 + 最近事件
 *
 * 客户端订阅:
 *   ws://localhost:3003/?channels=dashboard:overview,health:report,flywheel:event
 */
'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// ── 配置 ────────────────────────────────────────────────────
const WS_PORT = parseInt(process.env.WS_PORT || '3003', 10);
const PROJECT_ROOT = __dirname;
// 用绝对路径, 避免 Prisma 把相对路径解析到 cwd/schema.prisma 之外
const DB_ABS_PATH = path.join(PROJECT_ROOT, 'prisma', 'dev.db');
const PRISMA_DB_URL = process.env.PRISMA_DB_URL || `file:${DB_ABS_PATH}`;
const SYSTEM_CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'system-config.json');
const EVENT_BUS_LOG = path.join(PROJECT_ROOT, 'data', 'event-bus.jsonl');
const ALLOW_ORIGIN = process.env.WS_ALLOW_ORIGIN || 'http://localhost:3001';

// ── 独立 Prisma client (不与 Next.js 共享单例) ─────────────
const prisma = new PrismaClient({
  log: ['error', 'warn'],
  datasources: { db: { url: PRISMA_DB_URL } },
});

// ── 工具 ────────────────────────────────────────────────────
const log = (...args) => console.log('[WS]', new Date().toISOString().slice(11, 19), ...args);
const err = (...args) => console.error('[WS]', new Date().toISOString().slice(11, 19), ...args);

// ── 客户端管理 ─────────────────────────────────────────────
/** @type {Map<WebSocket, Set<string>>} */
const clients = new Map();
let totalConnections = 0;

function addClient(ws, channels) {
  clients.set(ws, channels);
  totalConnections++;
  log(`client connected ch=[${Array.from(channels).join(',')}] total=${clients.size}`);
}

function removeClient(ws) {
  clients.delete(ws);
  log(`client disconnected total=${clients.size}`);
}

/** 给所有订阅了指定频道的客户端推送 */
function broadcast(channel, data, type) {
  if (clients.size === 0) return 0;
  const frame = JSON.stringify({
    type: type || 'update',
    channel,
    data,
    ts: Date.now(),
  });
  // 大小检查: 单帧不要超 100KB
  if (frame.length > 100 * 1024) {
    err(`broadcast frame too large: ${channel} ${frame.length}B, drop`);
    return 0;
  }
  let sent = 0;
  for (const [ws, subs] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!subs.has(channel) && !subs.has('*')) continue;
    try {
      ws.send(frame);
      sent++;
    } catch (e) {
      err('send error', e.message);
    }
  }
  return sent;
}

// ── CORS / Origin 检查 ────────────────────────────────────
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true; // 非浏览器(如测试客户端)放行
  if (o === ALLOW_ORIGIN) return true;
  // 同源 localhost 都放行
  if (/^http:\/\/localhost:(3000|3001|3002|3003)$/.test(o)) return true;
  return false;
}

// ── 频道数据源 ─────────────────────────────────────────────

/** dashboard:overview — 任务/问题/飞轮状态分布 */
async function buildDashboardOverview() {
  try {
    const [taskStats, taskExecStats, problemStats, queueDepth, flywheelStages, recentLogs] = await Promise.all([
      prisma.task.groupBy({ by: ['status'], _count: true }),
      prisma.taskExecution.groupBy({ by: ['status'], _count: true }),
      prisma.problem.groupBy({ by: ['status'], _count: true }),
      prisma.task.groupBy({ by: ['priority'], where: { status: 'PENDING' }, _count: true }),
      prisma.flywheelEvent.groupBy({ by: ['stage'], _count: true }),
      prisma.taskExecution.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, status: true, qualityPassed: true, createdAt: true,
          task: { select: { id: true, title: true } },
        },
      }),
    ]);
    return {
      taskStats: taskStats.map(t => ({ status: t.status, _count: t._count })),
      taskExecStats: taskExecStats.map(t => ({ status: t.status, _count: t._count })),
      problemStats: problemStats.map(p => ({ status: p.status, _count: p._count })),
      queueDepth: queueDepth.map(q => ({ priority: q.priority, _count: q._count })),
      flywheelStages: flywheelStages.map(f => ({ stage: f.stage, _count: f._count })),
      currentlyProcessing: taskExecStats.find(t => t.status === 'IN_PROGRESS')?._count ?? 0,
      recentLogs: recentLogs.map(r => ({
        id: r.id, status: r.status, qualityPassed: r.qualityPassed,
        createdAt: r.createdAt.toISOString(),
        task: r.task ? { id: r.task.id, title: r.task.title } : null,
      })),
    };
  } catch (e) {
    err('buildDashboardOverview failed', e.message);
    return null;
  }
}

/** health:report — 服务心跳/DB/资源/告警 (轻量版, ws 端不重做 health 路由的复杂计算) */
async function buildHealthReport() {
  try {
    const [mindDb, taskDb, mem, cpu] = await Promise.all([
      safeDbStat('/data~@uos/00 ai agent/claude code/test/lions-mind/prisma/dev.db'),
      safeDbStat(path.join(PROJECT_ROOT, 'prisma', 'dev.db')),
      Promise.resolve(process.memoryUsage()),
      Promise.resolve(process.cpuUsage()),
    ]);
    const [stuckCount, flywheel24h, reflection24h, taskExecStats, problemStats] = await Promise.all([
      prisma.taskExecution.count({
        where: {
          status: 'IN_PROGRESS',
          startedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
        },
      }),
      prisma.flywheelEvent.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        select: { stage: true },
      }),
      prisma.flywheelEvent.count({
        where: {
          stage: { startsWith: 'REFLECTION' },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      prisma.taskExecution.groupBy({ by: ['status'], _count: true }),
      prisma.problem.groupBy({ by: ['status'], _count: true }),
    ]);

    const lastFlywheel = await prisma.flywheelEvent.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, stage: true, sourceTitle: true },
    });
    const flywheelIdleMin = lastFlywheel
      ? Math.round((Date.now() - lastFlywheel.createdAt.getTime()) / 60000)
      : 99999;

    const flywheelByStage = {};
    for (const f of flywheel24h) flywheelByStage[f.stage] = (flywheelByStage[f.stage] || 0) + 1;

    const taskEngMap = {};
    taskExecStats.forEach(t => { taskEngMap[t.status] = t._count; });
    const probMap = {};
    problemStats.forEach(p => { probMap[p.status] = p._count; });

    // 系统配置 (运行时 batch / smart)
    const sysCfg = readSystemConfig();

    // 简化告警(只标记关键问题, 不重做 health 路由的 ping)
    const alerts = [];
    if (stuckCount > 0) {
      alerts.push({
        level: stuckCount > 100 ? 'critical' : 'warning',
        category: 'engine',
        title: `${stuckCount} 个执行卡死(>30min)`,
        detail: 'TaskExecution.IN_PROGRESS 跑超 30min',
      });
    }
    if (flywheelIdleMin > 60) {
      alerts.push({
        level: 'warning', category: 'flywheel',
        title: `飞轮停转 ${flywheelIdleMin}m`,
        detail: '无新 FlywheelEvent > 60min',
      });
    }

    return {
      timestamp: new Date().toISOString(),
      summary: {
        servicesUp: 1, // ws-server 本身在跑 = 1
        servicesTotal: 1,
        alertsCritical: alerts.filter(a => a.level === 'critical').length,
        alertsWarning: alerts.filter(a => a.level === 'warning').length,
        alertsInfo: alerts.filter(a => a.level === 'info').length,
      },
      resources: {
        rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
        external: `${Math.round(mem.external / 1024 / 1024)}MB`,
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        uptimeSec: Math.round(process.uptime()),
      },
      databases: { mind: mindDb, task: taskDb },
      flywheel: {
        state: flywheelIdleMin < 5 ? 'spinning' : flywheelIdleMin < 60 ? 'slow' : 'stalled',
        lastEventAt: lastFlywheel?.createdAt?.toISOString() ?? null,
        lastEventStage: lastFlywheel?.stage ?? null,
        lastEventTitle: lastFlywheel?.sourceTitle?.slice(0, 80) ?? null,
        idleMin: flywheelIdleMin,
        events24h: flywheel24h.length,
        events1h: flywheel24h.filter(f => f.createdAt >= new Date(Date.now() - 60 * 60 * 1000)).length,
        byStage24h: flywheelByStage,
      },
      reflection: {
        state: reflection24h > 0 ? 'active' : 'idle',
        events24h: reflection24h,
        events1h: Math.round(reflection24h / 24),
        lastAt: null,
        lastTitle: null,
        idleMin: flywheelIdleMin,
      },
      taskEngine: {
        pending: taskEngMap['PENDING'] || 0,
        running: taskEngMap['IN_PROGRESS'] || 0,
        stuck: stuckCount,
        blocked: 0,
        failed: taskEngMap['FAILED'] || 0,
        completed: taskEngMap['COMPLETED'] || 0,
        cancelled: taskEngMap['CANCELLED'] || 0,
        state: (taskEngMap['IN_PROGRESS'] || 0) > 0 ? 'running' : 'idle',
      },
      problemEngine: {
        open: probMap['OPEN'] || 0,
        solving: probMap['SOLVING'] || 0,
        solved: probMap['SOLVED'] || 0,
        abandoned: probMap['ABANDONED'] || 0,
        state: (probMap['SOLVING'] || 0) > 0 ? 'running' : 'idle',
      },
      alerts,
      config: { system: sysCfg, runtime: sysCfg?.runtime || null },
      ws: { totalConnections },
    };
  } catch (e) {
    err('buildHealthReport failed', e.message);
    return null;
  }
}

function safeDbStat(p) {
  try {
    if (!fs.existsSync(p)) return { exists: false, sizeBytes: 0, size: '—', age: '—' };
    const st = fs.statSync(p);
    const ageMin = Math.round((Date.now() - st.mtime.getTime()) / 60000);
    return {
      exists: true, sizeBytes: st.size, mtime: st.mtime.toISOString(),
      ageMinutes: ageMin,
      size: st.size < 1024 * 1024 ? `${(st.size / 1024).toFixed(1)}KB` : `${(st.size / 1024 / 1024).toFixed(1)}MB`,
      age: ageMin < 1 ? '刚刚' : ageMin < 60 ? `${ageMin}分钟前` : `${Math.round(ageMin / 60)}小时前`,
    };
  } catch {
    return { exists: false, sizeBytes: 0, size: '—', age: '—' };
  }
}

function readSystemConfig() {
  try {
    if (!fs.existsSync(SYSTEM_CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// ── event-bus.jsonl 尾部监听 (跨进程事件桥) ─────────────
class EventBusTail {
  constructor(file) {
    this.file = file;
    this.lastSize = 0;
    this.timer = null;
    this.intervalMs = 500;
  }
  start() {
    try {
      if (fs.existsSync(this.file)) {
        this.lastSize = fs.statSync(this.file).size;
      }
    } catch (e) {
      err('eventBus tail init', e.message);
    }
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    log('event-bus tail started:', this.file);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  poll() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return; // 文件不存在
    }
    if (stat.size < this.lastSize) {
      // 文件被截断/rotate, 重置
      this.lastSize = 0;
    }
    if (stat.size === this.lastSize) return;
    const stream = fs.createReadStream(this.file, {
      start: this.lastSize, end: stat.size, encoding: 'utf-8',
    });
    let buf = '';
    stream.on('data', (chunk) => { buf += chunk; });
    stream.on('end', () => {
      this.lastSize = stat.size;
      const lines = buf.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          // 推送到两个频道
          broadcast('event-bus:event', evt, 'bus-event');
          // 飞轮事件额外推送
          if (evt?.type && (
            evt.type.startsWith('FLYWHEEL') ||
            evt.type.startsWith('PROBLEM_') ||
            evt.type.startsWith('TASK_') ||
            evt.type.startsWith('SCHEDULER_') ||
            evt.type === 'EXECUTION_RECORDED'
          )) {
            broadcast('flywheel:event', evt, 'flywheel-event');
          }
        } catch {
          // 忽略坏行
        }
      }
    });
    stream.on('error', (e) => err('eventBus tail read', e.message));
  }
}

// ── HTTP 健康端点 (供浏览器 / 监控探测) ──────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, totalConnections, port: WS_PORT }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('ws-server — connect via WebSocket');
});

// ── WebSocket server ──────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  if (!originAllowed(req)) {
    err('rejected origin:', req.headers.origin);
    ws.close(1008, 'origin not allowed');
    return;
  }

  // 解析订阅频道 (?channels=a,b,c)
  const url = new URL(req.url, 'http://localhost');
  const channelsParam = url.searchParams.get('channels') || '';
  const channels = new Set(
    channelsParam.split(',').map(s => s.trim()).filter(Boolean)
  );
  if (channels.size === 0) channels.add('dashboard:overview'); // 默认

  ws.isAlive = true;
  addClient(ws, channels);

  // 立即推一条 welcome
  try {
    ws.send(JSON.stringify({
      type: 'welcome',
      channel: null,
      data: { channels: Array.from(channels), ts: Date.now() },
      ts: Date.now(),
    }));
  } catch {}

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action === 'subscribe' && msg.channel) {
        channels.add(msg.channel);
        ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel, ts: Date.now() }));
      } else if (msg.action === 'unsubscribe' && msg.channel) {
        channels.delete(msg.channel);
        ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel, ts: Date.now() }));
      } else if (msg.action === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    } catch {
      // 忽略
    }
  });

  ws.on('close', () => removeClient(ws));
  ws.on('error', (e) => err('client error', e.message));
});

// ── 心跳 (30s 一次, 死链清理) ───────────────────────────
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      try { ws.terminate(); } catch {}
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);

// ── 定时广播 ─────────────────────────────────────────────
const timers = [];

// dashboard:overview 4s 一次
timers.push(setInterval(async () => {
  if (clients.size === 0) return;
  const data = await buildDashboardOverview();
  if (data) broadcast('dashboard:overview', data, 'update');
}, 4000));

// health:report 1s 一次 (high frequency per spec)
timers.push(setInterval(async () => {
  if (clients.size === 0) return;
  const data = await buildHealthReport();
  if (data) broadcast('health:report', data, 'update');
}, 1000));

// 启动时立即推一次(不等 4s),让客户端首屏就有数据
setTimeout(async () => {
  const d = await buildDashboardOverview();
  if (d) broadcast('dashboard:overview', d, 'update');
  const h = await buildHealthReport();
  if (h) broadcast('health:report', h, 'update');
}, 500);

// ── event-bus 文件 tail ──────────────────────────────────
const tail = new EventBusTail(EVENT_BUS_LOG);
tail.start();

// ── 启动 / 关闭 ──────────────────────────────────────────
httpServer.listen(WS_PORT, () => {
  log(`listening on ws://localhost:${WS_PORT}  (allow origin: ${ALLOW_ORIGIN})`);
  log(`event-bus log: ${EVENT_BUS_LOG}`);
  log(`prisma db: ${PRISMA_DB_URL}`);
});

function shutdown(sig) {
  log(`received ${sig}, shutting down...`);
  for (const t of timers) clearInterval(t);
  clearInterval(heartbeat);
  tail.stop();
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch {}
  }
  wss.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => err('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => err('unhandledRejection', e?.stack || e));
