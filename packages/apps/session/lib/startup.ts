import { startSyncScheduler } from "./scheduler";

// Start scheduler when module loads
let started = false;

function ensureStarted() {
  if (!started) {
    const interval = parseInt(process.env.SYNC_INTERVAL_MINUTES || "10");
    startSyncScheduler(interval);
    started = true;
    console.log("[lions-session] Scheduler initialized");
  }
}

export { ensureStarted };