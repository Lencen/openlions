// [UI-S6 / 屏06 智能体详情] 服务端取数层 (只读)
// 数据全部来自既有同源 BFF 只读端点, 不新增接口语义、不直连库、不做写操作:
//   /api/agent-list            智能体名册 (含画像 profile / 服务授权 permissions / 当前在办任务)
//   /api/agents-live?agent=…   活跃看板单智能体读数 (在线状态 / 在办任务 / 待开始 / 执行统计 / 产出质量)
//   /api/agent-services?…      业务服务目录 (配置页矩阵左列)
//   /api/session-list?agent_id=… 该智能体的会话档案 (运行页最近会话)
// 取数失败一律返回 null / 空数组, 由页面渲染降级态, 不 500、不白屏。
import { headers } from "next/headers";

export const TIER_LABELS: Record<number, string> = {
  0: "T0 纯文本（只能产出文本）",
  1: "T1 只读查证（可读平台数据核验）",
  2: "T2 提案式写（可建候选、开任务）",
  3: "T3 直接写（可改代码、查库、部署）",
};

export interface AgentPermission {
  service_name: string;
  permissions?: string | null;
  config?: string | null;
  status?: string | null;
  expires_at?: string | null;
}

export interface AgentRow {
  id?: string;
  agent_id: string;
  display_name?: string | null;
  channel?: string | null;
  host?: string | null;
  role?: string | null;
  status?: string | null;
  profile?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  permissions?: AgentPermission[];
  currentTask?: TaskBrief | null;
}

export interface TaskBrief {
  id: string;
  title?: string | null;
  status?: string | null;
  theme?: string | null;
  priority?: string | null;
  improvementType?: string | null;
  updatedAt?: number | null;
  completedAt?: number | null;
  idleMin?: number | null;
}

export interface ServiceRow {
  id?: string;
  name: string;
  display_name?: string | null;
  description?: string | null;
  endpoint?: string | null;
  version?: string | null;
  status?: string | null;
  enabled?: boolean;
  available_perms?: string | null;
}

export interface LiveAgent {
  agentId: string;
  displayName?: string | null;
  channel?: string | null;
  host?: string | null;
  role?: string | null;
  registryRole?: string | null;
  roleLabel?: string | null;
  toolCapable?: boolean;
  registryStatus?: string | null;
  macsStatus?: string | null;
  macsMessages24h?: number | null;
  lastSeenAt?: number | null;
  lastSeenAgoMin?: number | null;
  state?: string | null;
  stateLabel?: string | null;
  stuckReason?: string | null;
  currentTask?: TaskBrief | null;
  assignedPendingCount?: number;
  assignedPending?: TaskBrief[];
  lastTask?: TaskBrief | null;
  taskStats?: { done?: number; failed?: number; running?: number; pending?: number };
  doneByScope?: Record<string, number>;
  taskScopeStats?: Record<string, number>;
  tokenUsage?: { tokens?: number; calls?: number } | null;
  lastExecution?: { id?: string; taskTitle?: string | null; status?: string | null; qualityPassed?: number; completedAt?: number | null } | null;
  execStats?: { n?: number; completed?: number; failed?: number; passed?: number; lastAt?: number | null };
  lastOutput?: { at?: number | null; quality?: number | null } | null;
  outputQuality?: number | null;
}

export interface SessionRow {
  session_uid: string;
  agent_id?: string | null;
  source?: string | null;
  title?: string | null;
  message_count?: number;
  status?: string | null;
  updated_at?: string | null;
  uploaded_at?: string | null;
}

/** 同源 BFF 取数(带状态): 区分「取数失败」与「取到空值」 */
export async function bffGetResult<T>(path: string): Promise<{ ok: boolean; data: T | null }> {
  try {
    const h = headers();
    const host = h.get("host") || `127.0.0.1:${process.env.PORT || 3004}`;
    const res = await fetch(`http://${host}${path}`, { cache: "no-store" });
    if (!res.ok) return { ok: false, data: null };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, data: null };
  }
}

/** 兼容旧调用: 只关心数据, 失败返回 null */
export async function bffGet<T>(path: string): Promise<T | null> {
  return (await bffGetResult<T>(path)).data;
}

export interface AgentLoad { ok: boolean; agent: AgentRow | null }

/** 带「是否成功」的取数结果: 供页面区分「取到空值」与「取数失败」 */
export interface Sourced<T> { ok: boolean; data: T }

/** 名册取数带上「是否成功」: ok=false 表示接口失败(≠ agent 不存在), 供页面区分降级态 */
export async function loadAgent(id: string): Promise<AgentLoad> {
  const r = await bffGetResult<AgentRow[]>("/api/agent-list");
  if (!r.ok) return { ok: false, agent: null };
  const list = Array.isArray(r.data) ? r.data : ((r.data as any)?.items ?? []);   // 76-FZ: 新形状 { asOf, items } 的容错
  return { ok: true, agent: list.find((a) => a?.agent_id === id) ?? null };
}

export async function loadLive(id: string): Promise<Sourced<LiveAgent | null>> {
  const r = await bffGetResult<{ agents?: LiveAgent[] }>(
    `/api/agents-live?agent=${encodeURIComponent(id)}&range=24h`,
  );
  return { ok: r.ok, data: r.data?.agents?.[0] ?? null };
}

export async function loadServices(id: string): Promise<Sourced<ServiceRow[]>> {
  const r = await bffGetResult<ServiceRow[] | { result?: { data?: ServiceRow[] } }>(
    `/api/agent-services?agent_id=${encodeURIComponent(id)}`,
  );
  if (!r.ok) return { ok: false, data: [] };
  const d = r.data;
  if (Array.isArray(d)) return { ok: true, data: d };
  return { ok: true, data: d?.result?.data ?? [] };
}

export async function loadSessions(id: string, pageSize = 15): Promise<Sourced<{ items: SessionRow[]; total: number }>> {
  const r = await bffGetResult<{ result?: { data?: { items?: SessionRow[]; total?: number } } }>(
    `/api/session-list?page=1&pageSize=${pageSize}&agent_id=${encodeURIComponent(id)}`,
  );
  if (!r.ok) return { ok: false, data: { items: [], total: 0 } };
  const data = r.data?.result?.data;
  return { ok: true, data: { items: data?.items ?? [], total: Number(data?.total ?? 0) } };
}

export function parseJson(v: unknown): Record<string, any> {
  if (!v) return {};
  if (typeof v === "object") return v as Record<string, any>;
  try {
    const j = JSON.parse(String(v));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? j.map(String) : [v];
    } catch {
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

const CN_TZ = { timeZone: "Asia/Shanghai" } as const;

/** ISO 字符串 / 毫秒时间戳 -> 本地(上海)展示时间; 不可解析返回 "-" */
export function fmtTime(v?: string | number | null): string {
  if (v === null || v === undefined || v === "") return "-";
  const ms = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) return String(v);
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      ...CN_TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ms));
  } catch {
    return "-";
  }
}

/** 距现在的分钟数 -> 人类可读 ("刚刚" / "N 分钟前" / "N 小时前" / "N 天前") */
export function fmtAgo(v?: string | number | null): string {
  if (v === null || v === undefined || v === "") return "-";
  const ms = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) return "-";
  const diff = Date.now() - ms;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

export function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function pct(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${Math.round(n * 100)}%`;
}
