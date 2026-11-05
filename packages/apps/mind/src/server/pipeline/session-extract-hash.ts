/**
 * session-extract-hash.ts — session-extract 写入契约里 **contentHash 的唯一实现** (round 77)
 *
 * 为什么单独一个文件: 脚本(`scripts/session-extract.ts`, 由 systemd timer 经 tsx 直接跑)与
 * mind 侧应用层(`session-extract-apply.ts`, 跑在 Next 里)**必须**用同一个公式算 contentHash,
 * 否则"同一份写入契约两套实现"的老问题原样复发。本文件只依赖 `crypto`, **不 import 任何 store /
 * Prisma / product-contract** —— 所以脚本 import 它不会把 modules 的 dist 拉进 tsx 进程。
 *
 * 公式(与旧直写 SQL 逐字一致, 见 session-extract.ts 旧 `sha256(c.title + c.content)`):
 *   contentHash = sha256(<行对象里的原始 title> + <正文列>)
 *   正文列: Memory/Knowledge/Skill = `content`;Practice = `description`(旧脚本的 c.content 落这一列)。
 *   title 用**原始候选名**(skill 用 `title` 而不是归一后的 `name`)—— 这样对历史行仍能命中去重。
 */
import { createHash } from "crypto";

export type ProductKind = "memory" | "knowledge" | "practice" | "skill" | "reflection";

/** 脚本侧批次行对象: 字段名与旧直写 SQL 的列语义一致(便于与 direct 模式对拍) */
export interface ExtractRow {
  [k: string]: any;
}

export interface SessionExtractBatch {
  /** 会话 uid(写入 sourceId 与幂等上下文) */
  sessionUid: string;
  /** 被代表的会话所属 agent(仅作元数据登记, 不参与鉴权 —— 鉴权是 service key) */
  agentId?: string | null;
  products?: {
    memory?: ExtractRow[];
    knowledge?: ExtractRow[];
    practice?: ExtractRow[];
    skill?: ExtractRow[];
    reflection?: ExtractRow[];
  };
  links?: {
    practiceUsedMemory?: ExtractRow[];
    practiceKnowledge?: ExtractRow[];
    practiceSkill?: ExtractRow[];
  };
  /** 遗留项 -> 改进任务(PENDING) */
  tasks?: ExtractRow[];
  /** 观测事件(FlywheelEvent), 含单会话去重事件与轮次事件 */
  events?: ExtractRow[];
  /** 会话内显式推翻 -> 撤回既有 Knowledge(stale + REJECTED + AuditLog + FlywheelEvent) */
  retractions?: Array<{ knowledgeId: string; reason: string }>;
}

/** 通用公式: sha256(title + content) */
export function productContentHash(title: unknown, content: unknown): string {
  return createHash("sha256").update(String(title ?? "") + String(content ?? ""), "utf-8").digest("hex");
}

/** 按产物类型取正文列后复算 contentHash(唯一实现) */
export function productHashForRow(kind: ProductKind, row: ExtractRow): string {
  const body = kind === "practice" || kind === "reflection" ? (row.description ?? row.content) : row.content;
  return productContentHash(row.title, body);
}

/** 新建一个空批次(轮次事件这种"只有 events"的批次也走同一契约) */
export function emptyBatch(sessionUid: string, agentId?: string | null): SessionExtractBatch {
  return {
    sessionUid,
    agentId: agentId ?? null,
    products: { memory: [], knowledge: [], practice: [], skill: [], reflection: [] },
    links: { practiceUsedMemory: [], practiceKnowledge: [], practiceSkill: [] },
    tasks: [],
    events: [],
    retractions: [],
  };
}
