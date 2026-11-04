// 🟡 最小 logger (agent-e 2026-07-29)
type LogFn = (msg: string, ...args: any[]) => void;

class Logger {
  info: LogFn = console.log;
  warn: LogFn = console.warn;
  error: LogFn = console.error;
  debug: LogFn = (() => {});
  
  child(opts: any = {}): Logger {
    const childLogger = new Logger();
    const prefix = opts.service || opts.name || '';
    if (prefix) {
      childLogger.info = (msg: string, ...args: any[]) => console.log(`[${prefix}] ${msg}`, ...args);
      childLogger.warn = (msg: string, ...args: any[]) => console.warn(`[${prefix}] ${msg}`, ...args);
      childLogger.error = (msg: string, ...args: any[]) => console.error(`[${prefix}] ${msg}`, ...args);
      childLogger.debug = (msg: string, ...args: any[]) => {};
    }
    return childLogger;
  }
}

export const logger = new Logger();
export default logger;
