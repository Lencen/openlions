/**
 * Flywheel 错误落库 (P2 错误分类落库)
 * 2026-08-21 leo
 *
 * 用途: 让所有飞轮阶段的错误按类型落 FlywheelErrorLog 表, 可历史分析
 *
 * 使用:
 *   import { recordError } from "./error-sink";
 *   await recordError({ errorType: "SCHEMA_INVALID", stage: "extract", ... });
 *
 * 设计:
 *   - 失败容错: 落库失败只 console.error, 不影响主流程
 *   - 消息截断: message ≤ 500, rawError ≤ 5000 (避免 DB 撑爆)
 *   - 自动关联 traceId: 调用 getTraceId() 拿当前 tick
 *   - 不阻塞: fire-and-forget (await optional)
 */
import { prisma } from "@/lib/prisma";
import type { LLMErrorType } from "./cognitive-extractor";
import { getTraceId } from "./logger";

export interface ErrorRecordInput {
  errorType: LLMErrorType | string;
  stage: "scan" | "extract" | "write" | "reflect" | "structure" | "pipeline";
  message: string;
  sourceType?: string;
  sourcePath?: string;
  sessionId?: string;
  rawError?: string;
  httpStatus?: number;
  retried?: number;
}

/**
 * 从错误消息推断错误类型 (用于捕获已有 catch 块抛的非 ClassifiedError 错误)
 */
export function classifyErrorFromMessage(msg: string): LLMErrorType {
  if (!msg) return "UNKNOWN";
  if (/Unterminated|Expected|invalid JSON|JSON\.parse|SyntaxError|Bad escaped|Unexpected token/i.test(msg)) return "SCHEMA_INVALID";
  if (/429|rate limit|Token Plan/i.test(msg)) return "RATE_LIMIT";
  if (/401|403|api key|authentication/i.test(msg)) return "AUTH_ERROR";
  if (/timeout|ETIMEDOUT|aborted/i.test(msg)) return "TIMEOUT";
  if (/network|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg)) return "NETWORK";
  if (/5\d\d/.test(msg)) return "SERVER_ERROR";
  return "UNKNOWN";
}

const MAX_MESSAGE = 500;
const MAX_RAW = 5000;

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "...[truncated]" : s;
}

export async function recordError(input: ErrorRecordInput): Promise<void> {
  try {
    await prisma.flywheelErrorLog.create({
      data: {
        errorType: input.errorType,
        stage: input.stage,
        sourceType: input.sourceType || null,
        sourcePath: input.sourcePath || null,
        sessionId: input.sessionId || null,
        traceId: getTraceId() || null,
        message: trunc(input.message || "unknown error", MAX_MESSAGE),
        rawError: input.rawError ? trunc(input.rawError, MAX_RAW) : null,
        httpStatus: input.httpStatus || null,
        retried: input.retried || 0,
      },
    });
  } catch (e) {
    // 落库失败不阻塞主流程
    console.error(
      "[errorSink] failed to record error:",
      e instanceof Error ? e.message : String(e)
    );
  }
  // P2 修复 2026-08-28: 删除 finally 里的 prisma.$disconnect()
  // 之前每次 recordError 都断开全局共享 PrismaClient (Next.js dev 单例),
  // 导致后续所有 prisma 调用报 "Engine is not yet connected" (mind-dev.log 749 次),
  // 且 FAILED session 的 processing_error 写库也随之中断 (17/17 为空)。
  // PrismaClient 是连接池, 不应在单次操作后手动断开; 进程退出时自动清理。
}

/**
 * Fire-and-forget 版本 (不 await), 用于不想阻塞主流程的场景
 */
export function recordErrorAsync(input: ErrorRecordInput): void {
  recordError(input).catch(() => {});
}