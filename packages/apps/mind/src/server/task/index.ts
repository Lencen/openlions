// TODO Phase 2 §15.4.3: 抽 task 模块到 packages/modules/task/ 时清理。
// 当前 monorepo 里 ./routers/task 与 ./routers/review 文件并未迁入,
// 这两行 export 引用空目标, 仅暂以 stub 占位避免 typecheck 失败。
export const taskRouter = null as unknown as never;
export const reviewRouter = null as unknown as never;
