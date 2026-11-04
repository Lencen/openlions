declare module "node-cron" {
  interface ScheduledTask {
    start(): void;
    stop(): void;
    getStatus(): string;
  }
  function schedule(expression: string, func: () => void | Promise<void>): ScheduledTask;
  export = { schedule };
}