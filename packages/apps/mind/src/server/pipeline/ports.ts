/**
 * ports.ts — 飞轮可替换模块的端口契约 v1（2026-10-27）
 *
 * 只定义能力边界，不引入实现。现有实现通过 adapter 适配：
 *   Ingest      -> scripts/session-extract.ts
 *   AssetStore  -> prisma Memory/Knowledge/Practice/Skill
 *   Retrieval   -> server/pipeline/context-seed.ts
 *   Task        -> server/pipeline/task-lease.ts + flywheel API
 *   Verdict     -> scripts/acceptance/runner.cjs + shadow
 *   Audit       -> scripts/lib/audit-log.cjs + AuditLog
 *
 * 约束：Task/Verdict/Audit 是飞轮内核，不允许外部实现绕过证据闸门/验收/审计。
 */

export type AssetKind = "memory" | "knowledge" | "practice" | "skill";

export interface AssetRef {
  kind: AssetKind;
  id: string;
}

export interface SessionInput {
  sessionUid: string;
  agentId: string | null;
  messages: Array<{ role: string; content: string; at?: string }>;
}

export interface IngestResult {
  sessionUid: string;
  extracted: number;
  skipped: number;
  errors: Array<{ key: string; message: string }>;
}

export interface AssetInput {
  title: string;
  content: string;
  theme?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  qualityScore?: number | null;
  contentHash?: string | null;
}

export interface Asset extends AssetInput {
  kind: AssetKind;
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievalQuery {
  query?: string;
  theme?: string;
  kinds?: AssetKind[];
  limit?: number;
  agentId?: string | null;
  scopeSql?: string;
}

export interface ContextHit {
  kind: AssetKind;
  id: string;
  title: string;
  snippet: string;
  score: number | null;
  source: string | null;
  theme: string | null;
}

export type TaskStatus = "PENDING" | "PROCESSING" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "DEPRECATED";

export interface TaskSpec {
  title: string;
  description: string;
  improvementType?: string | null;
  priority?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskRef {
  id: string;
  status: TaskStatus;
}

export interface ClaimFilter {
  types?: string[];
  excludeTypes?: string[];
  leaseMs?: number;
}

export interface Task extends TaskRef {
  title: string;
  assignedAgent: string | null;
  retryCount: number;
  createdAt: string;
}

export interface ReleaseResult {
  ok: boolean;
  reason?: string;
  quarantined?: boolean;
}

export interface Verdict {
  entityType: "Task" | "Todo";
  entityId: string;
  verdict: "PASS" | "FAIL";
  specType?: string | null;
  fails?: string[];
  source: "runner" | "shadow";
}

export interface AuditEvent {
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  actorType?: "human" | "agent" | "system";
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditRow extends AuditEvent {
  id: string;
  createdAt: string;
}

/** 采集：会话 -> 原始事件 */
export interface IngestPort {
  ingestSession(input: SessionInput): Promise<IngestResult>;
}

/** 资产：统一读写；不负责验收 */
export interface AssetStorePort {
  upsert(kind: AssetKind, asset: AssetInput): Promise<AssetRef>;
  get(kind: AssetKind, id: string): Promise<Asset | null>;
  archive(kind: AssetKind, id: string, reason: string): Promise<void>;
  link(from: AssetRef, to: AssetRef, role: string): Promise<void>;
}

/** 检索：任务上下文注入；scope 过滤由实现保证 */
export interface RetrievalPort {
  search(q: RetrievalQuery): Promise<ContextHit[]>;
}

/** 任务：状态机 + 租约 + 路由；所有转换必须写 transition */
export interface TaskPort {
  create(spec: TaskSpec): Promise<TaskRef>;
  get(taskId: string): Promise<Task | null>;
  claim(agentId: string, filter: ClaimFilter): Promise<Task | null>;
  release(taskId: string, agentId: string, reason: string): Promise<ReleaseResult>;
  transition(taskId: string, to: TaskStatus, reason: string): Promise<void>;
}

/** 验收：唯一裁判；不得外包给 AssetStore/Retrieval */
export interface VerdictPort {
  evaluate(task: Task, output: string): Promise<Verdict>;
  write(v: Verdict): Promise<void>;
}

/** 审计：五类动作留痕 */
export interface AuditPort {
  record(e: AuditEvent): Promise<void>;
  query(f: Partial<AuditEvent>): Promise<AuditRow[]>;
}
