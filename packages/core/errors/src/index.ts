// 🟡 最小 errors (agent-e 2026-07-29)
export class LionsError extends Error { constructor(msg: string, public code?: string) { super(msg); } }
export class NotFoundError extends LionsError { constructor(msg: string) { super(msg, 'NOT_FOUND'); } }
export class ValidationError extends LionsError { constructor(msg: string) { super(msg, 'VALIDATION'); } }
export { LionsError as AppError };
