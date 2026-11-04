// eslint-disable-next-line
const cron = require("node-cron");

interface ScheduledTask {
  start(): void;
  stop(): void;
}

let scheduledTask: ScheduledTask | null = null;
let lastSyncAt: Date | null = null;
let lastSyncResult: { sessions: number; messages: number } | null = null;
let lastMindSyncAt: Date | null = null;
let lastMindSyncResult: { updated: number; inserted: number; total: number } | null = null;
let isRunning = false;

export function startSyncScheduler(intervalMinutes = 10) {
  if (scheduledTask) {
    scheduledTask.stop();
  }

  scheduleNext(intervalMinutes);

  console.log(`[lions-session] Sync scheduler started (every ${intervalMinutes} min)`);
}

function scheduleNext(intervalMinutes: number) {
  const expression = `*/${intervalMinutes} * * * *`;
  scheduledTask = cron.schedule(expression, () => {
    if (isRunning) {
      console.log(`[lions-session] Sync 上一轮未结束, 跳过本轮`);
      return;
    }
    isRunning = true;
    runSync()
      .catch(e => console.error("[lions-session] runSync err:", e))
      .finally(() => { isRunning = false; });
  });
  scheduledTask?.start();
}

export function stopSyncScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

async function runSync() {
  console.log(`[lions-session] Sync starting at ${new Date().toISOString()}`);
  try {
    const { syncSessions } = await import("@/lib/sync");
    const result = await syncSessions();
    lastSyncAt = new Date();
    lastSyncResult = result;
    console.log(`[lions-session] Hermes sync done: ${result.sessions} new sessions, ${result.messages} new messages`);
  } catch (error) {
    console.error(`[lions-session] Hermes sync failed:`, error);
  }

  try {
    const { syncFromMind } = await import("@/lib/mind-sync");
    const r = await syncFromMind();
    lastMindSyncAt = new Date();
    lastMindSyncResult = r;
    console.log(`[lions-session] Mind sync done: ${r.inserted} inserted, ${r.updated} updated (mind total ${r.total})`);
  } catch (error) {
    console.error(`[lions-session] Mind sync failed:`, error);
  }
}

export function getSyncStatus() {
  return {
    lastSyncAt,
    lastSyncResult,
    lastMindSyncAt,
    lastMindSyncResult,
    isRunning: scheduledTask !== null,
  };
}