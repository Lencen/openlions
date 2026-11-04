// 2026-09-14 全局搜索 (待办 todo_34742fd11df244cb856d):
// 服务端只读检索 —— 一次请求同时返回「页面/功能」与「平台内容实体」两组结果。
//   · 页面组: 来自 config/searchIndex (与左侧导航同源, 保证不丢页面);
//   · 内容组: 直接只读查询 mind 库 (知识/记忆/反思/实践/技能/待办/改进任务/智能体)。
// 约束: 只读 (readonly)、参数化 SQL (防注入)、LIKE 通配符转义、单请求时间预算 + 结果缓存。
import { NextRequest, NextResponse } from 'next/server';
import { openMind, q, safeClose, asOf } from '@/lib/server/lions-db';
import { searchPages } from '@/config/searchIndex';

export const dynamic = 'force-dynamic';

interface Hit {
  id: string;
  title: string;
  snippet: string;
  href: string;
}
interface Group {
  kind: string;
  items: Hit[];
}

interface Spec {
  kind: string;
  /** 物理表 (白名单常量, 不来自请求) */
  table: string;
  /** 主键列 */
  idCol: string;
  /** 匹配表达式 (含 N 个 ? 占位) */
  matchExpr: string;
  /** 标题列表达式 */
  titleExpr: string;
  /** 摘要列表达式 */
  snippetExpr: string;
  /** 结果跳转地址 */
  link: (row: any) => string;
  /** 排序 */
  orderBy: string;
  /** 每类最多返回条数 (默认取 limit) */
  cap?: number;
  /** 额外 WHERE 条件 (AND 到 matchExpr 后)。被撤回/被取代的行不得出现在检索里:
   *  Knowledge/Skill/Practice 有 stale(撤回写 stale=1, supersededBy 保持 NULL, 只挡 supersededBy 挡不住撤回);
   *  Memory/Reflection 只有 supersededBy(被取代即冷库归档链)。见 docs/knowledge-retraction-flow-2026-09-15.md §0.2 F5 */
  whereExtra?: string;
}

const SPECS: Spec[] = [
  {
    kind: 'knowledge',
    table: 'Knowledge',
    idCol: 'id',
    matchExpr: "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')",
    titleExpr: 'title',
    snippetExpr: 'content',
    link: (r) => `/cognitive/knowledge/detail?id=${encodeURIComponent(r.id)}`,
    orderBy: 'createdAt DESC',
    whereExtra: 'COALESCE(stale,0)=0 AND supersededBy IS NULL',
  },
  {
    kind: 'memory',
    table: 'Memory',
    idCol: 'id',
    matchExpr: "((title IS NOT NULL AND title LIKE ? ESCAPE '\\') OR content LIKE ? ESCAPE '\\')",
    titleExpr: "COALESCE(NULLIF(title,''), substr(content,1,60))",
    snippetExpr: 'content',
    link: (r) => `/cognitive/memory/detail?id=${encodeURIComponent(r.id)}`,
    orderBy: 'createdAt DESC',
    whereExtra: 'supersededBy IS NULL',
  },
  {
    kind: 'reflection',
    table: 'Reflection',
    idCol: 'id',
    matchExpr: "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
    titleExpr: 'title',
    snippetExpr: 'description',
    link: (r) => `/cognitive/reflection/detail?id=${encodeURIComponent(r.id)}`,
    orderBy: 'createdAt DESC',
    whereExtra: 'supersededBy IS NULL',
  },
  {
    kind: 'practice',
    table: 'Practice',
    idCol: 'id',
    matchExpr: "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
    titleExpr: 'title',
    snippetExpr: 'description',
    link: (r) => `/cognitive/practice/detail?id=${encodeURIComponent(r.id)}`,
    orderBy: 'createdAt DESC',
    whereExtra: 'COALESCE(stale,0)=0 AND supersededBy IS NULL',
  },
  {
    kind: 'skill',
    table: 'Skill',
    idCol: 'id',
    matchExpr: "(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
    titleExpr: 'name',
    snippetExpr: 'description',
    link: (r) => `/cognitive/skills/detail?id=${encodeURIComponent(r.id)}`,
    orderBy: 'createdAt DESC',
    whereExtra: 'COALESCE(stale,0)=0 AND supersededBy IS NULL',
  },
  {
    kind: 'todo',
    table: 'Todo',
    idCol: 'id',
    matchExpr: "(title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')",
    titleExpr: 'title',
    snippetExpr: 'detail',
    link: () => `/todo`,
    orderBy: 'createdAt DESC',
  },
  {
    kind: 'task',
    table: 'Task',
    idCol: 'id',
    matchExpr: "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
    titleExpr: 'title',
    snippetExpr: 'description',
    link: (r) => `/flywheel/tasks/${encodeURIComponent(r.id)}`,
    orderBy: 'createdAt DESC',
  },
  {
    kind: 'agent',
    table: 'AgentRegistry',
    idCol: 'agent_id',
    matchExpr: "(agent_id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')",
    titleExpr: "COALESCE(NULLIF(display_name,''), agent_id)",
    snippetExpr: "COALESCE(profile, '')",
    link: (r) => `/agents/detail?agentId=${encodeURIComponent(r.id)}`,
    orderBy: 'updated_at DESC',
    cap: 5,
  },
];

/** LIKE 参数: 转义 % _ \ 后再包 % */
function likeArg(s: string): string {
  return '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

function clip(s: any, n = 120): string {
  const v = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
}

/** 关键词最短长度: 中文 1 字即可, 拉丁字母需 2 个 */
function minLen(keyword: string): number {
  return /[\u4e00-\u9fff]/.test(keyword) ? 1 : 2;
}

// —— 结果缓存 (输入过程会反复查同样的前缀; 60s TTL, 最多 200 条) ——
const CACHE = new Map<string, { at: number; groups: Group[] }>();
const CACHE_TTL = 60_000;
const CACHE_MAX = 200;

function cacheGet(key: string): Group[] | null {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL) {
    CACHE.delete(key);
    return null;
  }
  return e.groups;
}
function cacheSet(key: string, groups: Group[]) {
  if (CACHE.size >= CACHE_MAX) {
    const oldest = Array.from(CACHE.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
  CACHE.set(key, { at: Date.now(), groups });
}

async function searchEntities(
  keyword: string,
  limit: number,
): Promise<{ groups: Group[]; failed: string[]; tookMs: number }> {
  const started = Date.now();
  const budgetMs = 500; // 单请求预算: 超时停止后续检索, 已得到的结果照常返回
  const db = openMind();
  const groups: Group[] = [];
  const failed: string[] = [];
  if (!db) return { groups, failed: ['db-unavailable'], tookMs: 0 };
  try {
    for (const spec of SPECS) {
      if (Date.now() - started > budgetMs) break;
      const cap = Math.min(spec.cap ?? limit, limit);
      const args = new Array((spec.matchExpr.match(/LIKE \?/g) || []).length).fill(
        likeArg(keyword),
      );
      const sql = `SELECT ${spec.idCol} AS id, ${spec.titleExpr} AS __title, ${spec.snippetExpr} AS __snippet
        FROM ${spec.table}
        WHERE ${spec.matchExpr}${spec.whereExtra ? ` AND ${spec.whereExtra}` : ''}
        ORDER BY ${spec.orderBy}
        LIMIT ?`;
      let rows: any[];
      try {
        // 不走 lib 的 q(): 它吞掉所有 SQL 异常, 会把"列名/类型错误"伪装成"无结果"。
        // 这里显式上报失败的表, 让 schema 回归能立刻被看见。
        rows = await q(db, sql, ...args, cap);
      } catch {
        failed.push(spec.kind);
        continue;
      }
      if (!rows.length) continue;
      const items: Hit[] = rows.map((r) => ({
        id: String(r.id),
        title: clip(r.__title, 100) || String(r.id),
        snippet: clip(r.__snippet, 120),
        href: spec.link(r),
      }));
      groups.push({ kind: spec.kind, items });
    }
  } finally {
    safeClose(db);
  }
  return { groups, failed, tookMs: Date.now() - started };
}

/** 安全整数参数: NaN / 非数字 -> 默认值, 并夹到 [min,max] */
function intParam(v: string | null, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const keyword = (sp.get('q') || '').trim().slice(0, 100);
  const limit = intParam(sp.get('limit'), 6, 1, 12);
  const pageLimit = intParam(sp.get('pages'), 8, 1, 100);

  const pages = searchPages(keyword, pageLimit);

  if (!keyword || keyword.length < minLen(keyword)) {
    return NextResponse.json({
      q: keyword,
      pages,
      groups: [],
      failed: [],
      asOf: asOf(),
      tookMs: 0,
    });
  }

  const cacheKey = `${limit}:${keyword.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return NextResponse.json({
      q: keyword,
      pages,
      groups: cached,
      failed: [],
      asOf: asOf(),
      cached: true,
    });
  }

  const { groups, failed, tookMs } = await searchEntities(keyword, limit);
  cacheSet(cacheKey, groups);
  return NextResponse.json({ q: keyword, pages, groups, failed, asOf: asOf(), tookMs });
}
