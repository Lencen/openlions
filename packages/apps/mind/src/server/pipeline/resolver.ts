/**
 * Cognitive Resolver (轻量版 v1)
 * 输入: CognitiveCandidate 一条候选
 * 输出: { action: CREATE|UPDATE|MERGE|DISCARD, targetId?, reason }
 *
 * 策略(不依赖 embedding):
 *  1. content 过短 (<30 字) 或全为标点空白 → DISCARD
 *  2. contentHash 完全命中同 agent+sourceType 的正式表 → UPDATE (强化, reinforceCount+1)
 *  3. type=knowledge/skill/reflection: title 精确匹配同 agentSource → UPDATE
 *  4. 子串重合度 ≥ 0.85 (Jaccard on 3-gram) → MERGE (标 supersededBy, 新建取代)
 *  5. 其它 → CREATE
 *
 * 决策落表 ResolverDecision, 候选 status → APPLIED/DISCARDED
 */
import { PrismaClient } from "../../../node_modules/.prisma/mind-client";
import { createHash } from "crypto";

export type ResolverAction = "CREATE" | "UPDATE" | "MERGE" | "DISCARD";
export interface ResolverResult {
  action: ResolverAction;
  targetId?: string | null;
  reason: string;
}

const MIN_CONTENT_LEN = 30;
const MERGE_JACCARD_THRESHOLD = 0.85;

export const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf-8").digest("hex");

/** 生成 3-gram 集合(汉字/字母字符) */
function ngrams(text: string, n = 3): Set<string> {
  const s = (text || "").replace(/\s+/g, "").toLowerCase();
  const g = new Set<string>();
  for (let i = 0; i <= s.length - n; i++) g.add(s.slice(i, i + n));
  return g;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  a.forEach((x) => { if (b.has(x)) inter++; });
  return inter / (a.size + b.size - inter);
}

function isJunk(content: string): boolean {
  const trimmed = (content || "").trim();
  if (trimmed.length < MIN_CONTENT_LEN) return true;
  // 全是标点/符号 (ASCII 常见集合 + 中文标点)
  if (/^[\s\W_·。，、；：""''？！（）【】《》…—]+$/.test(trimmed)) return true;
  if (/^(\[反思\]){3,}/.test(trimmed)) return true;
  if (/^(.)\1{20,}/.test(trimmed)) return true;
  return false;
}

/**
 * 主题别名族 (2026-09-14 落地提案 cmtwgdmqu01lu1j768u6qfhag, 挑战 Auto-rotation f-001)
 *
 * 背景: 反思引擎的 `loadThemeProducts(theme)` 与 finding 的产物计数只认**精确 theme 字符串**。
 *   实测: theme='Auto-rotation' 的 Knowledge/Practice 精确计数=0, 但同一主题的产物实际写在
 *   'auto-rot' / 'Auto-rot' / 'Auto-Rot' / '自动轮转' 等别名下 (Knowledge 13 行, Practice 13 行,
 *   FlywheelEvent 里 KNOWLEDGE 阶段 71 条 / PRACTICE 阶段 47 条) -> “0 条”是**主题别名口径**造成的
 *   计数假象, 不是知识空白。这是提案「路径1(计数口径)」的根因。
 *
 * 机制: 声明式登记同义主题; `themeVariants(theme)` 返回"该主题 + 其别名族"的全集,
 *   供读取侧 (反思产物加载 / 挑战任务证据核实) 做**别名感知计数**, 而不是单点精确匹配。
 *   写入侧由 normalizeTheme 把新产物收敛到 canonical, 从源头减少别名分裂。
 * 注意: 这里是**显式白名单**, 不做模糊匹配 —— 计数口径可审计, 不引入新的不可控聚合。
 */
export const THEME_ALIAS_GROUPS: Array<{ canonical: string; pattern: RegExp; variants: string[] }> = [
  {
    canonical: "Auto-rotation",
    pattern: /auto[\s_-]?rot(ation)?|自动轮转/i,
    variants: ["Auto-rotation", "auto-rotation", "Auto-Rotation", "Auto-rot", "auto-rot", "Auto-Rot", "auto-Rot", "自动轮转"],
  },
];

/**
 * 返回某主题的"别名族"——用于把 `where: { theme }` 升级为 `where: { theme: { in: themeVariants(theme) } }`。
 * 始终包含传入主题自身; 命中登记族时并入 canonical 与全部 variants; 未登记主题只返回自身(行为不变)。
 */
export function themeVariants(theme: string | null | undefined): string[] {
  const raw = String(theme ?? "");
  const t = raw.trim();
  if (!t) return [];
  const out = new Set<string>([t]);
  // 2026-10-09 round 67-D 修复: 本函数的契约是"**始终包含传入主题自身**"(见上方 JSDoc)。
  //   原实现把入参 trim 后就只返回 trim 结果 —— 而入参形态**就是**待查表的 theme 值, 库里的 theme
  //   带尾随/前导空格时 (实测 66 个主题 531 行: 'Console ' / 'API Key ' / 'Next.js ' 等), 查询变成
  //   `theme IN ('Console')` -> **一条都查不到** -> loadThemeProducts 返回 M=0 K=0 P=0 ->
  //   reflectWorker 走"无会话无产物 -> SKIPPED"快路径 -> 该主题**永远不被反思**。
  //   实测证据: theme="Console " 库内 M=14/K=10/P=13 全为 live, 反射日志却是 products: M=0 K=0 P=0 R=0。
  //   修法: 入参原样值也并入候选(trim 值仍保留, 兼容历史上的已归一主题)。
  if (raw !== t) out.add(raw);
  for (const g of THEME_ALIAS_GROUPS) {
    if (g.pattern.test(t)) {
      out.add(g.canonical);
      for (const v of g.variants) out.add(v);
    }
  }
  return [...out];
}

/**
 * O3: 主题归一化 -- 把同义词主题映射到标准主题
 * 规则: 关键词匹配, 优先匹配最长的规则
 */
const THEME_RULES: Array<{ pattern: RegExp; normalized: string }> = [
  // 自动轮转 (2026-09-14 新增): 实测 auto-rotation 有 6 种别名写法, 收敛到 canonical 减少计数口径分裂
  { pattern: /auto[\s_-]?rot(ation)?|自动轮转/i, normalized: "Auto-rotation" },
  // 任务管理大类
  { pattern: /任务.*(调度|监控|巡检|卡住|状态|管理)|卡住任务|(cron|定时).*(任务|调度)/i, normalized: "任务管理" },
  // 配置大类
  { pattern: /(环境|系统|数据库|服务).*(配置|设置)|配置管理/i, normalized: "环境配置" },
  // 数据大类
  { pattern: /数据.*(初始化|迁移|模型|结构|架构|清理|同步)|数据库.*(结构|迁移)/i, normalized: "数据管理" },
  // 验证大类
  { pattern: /(功能|测试).*(验证|验收|方法)|验证方法/i, normalized: "功能验证" },
  // 进程/端口
  { pattern: /(进程|端口|服务).*(管理|监控|启动|检查)/i, normalized: "进程管理" },
  // API/认证
  { pattern: /(API|接口|SDK).*(认证|鉴权|授权|key|密钥)/i, normalized: "API认证" },
  // 错误/日志
  { pattern: /(错误|异常|日志|报错).*(处理|分类|修复|监控)/i, normalized: "错误处理" },
  // 并发
  { pattern: /(并发|线程|锁|竞态)/i, normalized: "并发安全" },
  // 文档
  { pattern: /(文档|笔记|知识|手册).*(管理|编写|生成)/i, normalized: "文档管理" },
  // Pipeline
  { pattern: /pipeline|流水线|飞轮/i, normalized: "Pipeline" },
];

export function normalizeTheme(rawTheme: string | null | undefined): string | null {
  if (!rawTheme || rawTheme.trim().length === 0) return rawTheme ?? null;
  const t = rawTheme.trim();
  for (const rule of THEME_RULES) {
    if (rule.pattern.test(t)) return rule.normalized;
  }
  return t; // 没匹配到规则, 保持原样
}

/**
 * 判定并落 ResolverDecision + 更新候选 status.
 * 返回决策,由调用方决定是否 CREATE 到正式表.
 */
export async function resolveCandidate(
  prisma: PrismaClient,
  candidate: {
    id: string;
    type: string; // memory | knowledge | reflection | practice | skill
    content: string;
    title?: string | null;
    contentHash?: string | null;
    agentSource?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    theme?: string | null;  // O3: 归一化后的主题
  }
): Promise<ResolverResult> {
  const { id, type, content, title, contentHash, agentSource, sourceType, theme } =
    candidate;

  // 1. 垃圾直接 discard
  if (isJunk(content)) {
    return { action: "DISCARD", reason: "content too short or garbage" };
  }

  const hash = contentHash || sha256(content);

  // 2. hash 完全命中 (memory/knowledge/reflection/practice) → UPDATE 强化
  let hashHit: { id: string } | null = null;
  if (type === "memory") {
    hashHit = await prisma.memory.findFirst({
      where: { contentHash: hash, agentSource: agentSource ?? undefined, supersededBy: null },
      select: { id: true },
    });
  } else if (type === "knowledge") {
    hashHit = await prisma.knowledge.findFirst({
      // 2026-09-15 撤回流程: 被撤回(stale=1)的知识不得再作为"强化"目标 —— 否则一条被推翻的结论
      //   会被后续同名/同 hash 产物反复 reinforce, 撤回等于没撤(通道有 stale, 流程里没有它)。
      where: { contentHash: hash, agentSource: agentSource ?? undefined, supersededBy: null, stale: false },
      select: { id: true },
    });
  } else if (type === "reflection") {
    hashHit = await prisma.reflection.findFirst({
      where: { contentHash: hash, agentSource: agentSource ?? undefined, supersededBy: null },
      select: { id: true },
    });
  } else if (type === "practice") {
    hashHit = await prisma.practice.findFirst({
      // 2026-10-25 撤回流程补漏: Practice 也有 stale 列(同 Knowledge) —— 原实现漏了 stale:false,
      //   被撤回的实践行仍会被当成"强化"目标, 撤回等于没撤。
      where: { contentHash: hash, agentSource: agentSource ?? undefined, supersededBy: null, stale: false },
      select: { id: true },
    });
  }
  if (hashHit) {
    return {
      action: "UPDATE",
      targetId: hashHit.id,
      reason: "identical contentHash — reinforce existing",
    };
  }

  // 3. Knowledge/Skill/Reflection: title 精确匹配 → UPDATE
  if (title && (type === "knowledge" || type === "reflection")) {
    let titleHit: { id: string } | null = null;
    if (type === "knowledge") {
      titleHit = await prisma.knowledge.findFirst({
        where: { title, agentSource: agentSource ?? undefined, supersededBy: null, stale: false },
        select: { id: true },
      });
    } else if (type === "reflection") {
      titleHit = await prisma.reflection.findFirst({
        where: { title, agentSource: agentSource ?? undefined, supersededBy: null },
        select: { id: true },
      });
    }
    if (titleHit) {
      return {
        action: "UPDATE",
        targetId: titleHit.id,
        reason: "same title (agent+active) — reinforce",
      };
    }
  }

  // 3.5 O2: 同主题容量限制 -- 同 theme + type + agent 超过 50 条就不再 CREATE
  //   防止"任务调度"等高频主题无限膨胀到 3000+ 条
  // P0-2 (2026-09-01): 主题容量 50 -> 200 (软阈值), 配合相似度保真恢复积累
  //   原 50 导致全主题饱和 -> 96% 候选 reinforce 丢弃 (先提炼后丢弃悖论)
  const THEME_CAPACITY = 200;
  if (theme) {
    const themeWhere = { theme, agentSource: agentSource ?? undefined, supersededBy: null };
    let themeCount = 0;
    let themeHit: { id: string; valueScore?: number | null } | null = null;
    if (type === "memory") {
      themeCount = await prisma.memory.count({ where: themeWhere });
      if (themeCount >= THEME_CAPACITY) {
        themeHit = await prisma.memory.findFirst({
          where: themeWhere, orderBy: { valueScore: "desc" }, select: { id: true, valueScore: true, content: true },
        });
      }
    } else if (type === "knowledge") {
      // 2026-09-15: 容量统计与"reinforce 最高置信行"都只看活性(stale=false)行, 撤回行不计入也不被选中
      const knActive = { ...themeWhere, stale: false };
      themeCount = await prisma.knowledge.count({ where: knActive });
      if (themeCount >= THEME_CAPACITY) {
        themeHit = await prisma.knowledge.findFirst({
          where: knActive, orderBy: { confidence: "desc" }, select: { id: true, confidence: true, content: true },
        });
      }
    } else if (type === "reflection") {
      themeCount = await prisma.reflection.count({ where: themeWhere });
      if (themeCount >= THEME_CAPACITY) {
        themeHit = await prisma.reflection.findFirst({
          where: themeWhere, orderBy: { priority: "desc" }, select: { id: true, priority: true, description: true },
        });
      }
    } else if (type === "practice") {
      // 2026-10-25 撤回流程补漏: Practice 也有 stale 列 —— 容量统计与"reinforce 最高质量行"
      //   都必须只认活行, 否则被撤回的实践既占容量又会被 reinforce(撤回等于没撤)。
      const prActive = { ...themeWhere, stale: false };
      themeCount = await prisma.practice.count({ where: prActive });
      if (themeCount >= THEME_CAPACITY) {
        themeHit = await prisma.practice.findFirst({
          where: prActive, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, description: true },
        });
      }
    }
    if (themeHit) {
      // P0-4 (2026-09-01) 提取-丢弃治理: 容量饱和时先算内容相似度,
      //   内容差异大 (sim < 0.5) 则 CREATE 新记录 (真实积累), 否则才 reinforce
      // Reflection/Practice 用 description, Memory/Knowledge 用 content
      const hitContent: string = (themeHit as any).content ?? (themeHit as any).description ?? "";
      let sim = 0;
      if (hitContent && content) {
        const a = ngrams(content, 3);
        const b = ngrams(hitContent, 3);
        if (a.size >= 3 && b.size >= 3) sim = jaccard(a, b);
      }
      if (sim < 0.5) {
        return {
          action: "CREATE",
          reason: `theme="${theme}" capacity ${themeCount}>=${THEME_CAPACITY} but content diff (sim=${sim.toFixed(2)}) - create new`,
        };
      }
      return {
        action: "UPDATE",
        targetId: themeHit.id,
        reason: `theme="${theme}" capacity ${themeCount} >= ${THEME_CAPACITY} sim=${sim.toFixed(2)} - reinforce top record`,
      };
    }
  }

  // 4. Jaccard 3-gram 子串重合 (只在同 agent+同 type 最近 200 条中扫)
  const cand3 = ngrams(content, 3);
  if (cand3.size >= 5) {
    let recent: Array<{ id: string; content: string }> = [];
    if (type === "memory") {
      recent = await prisma.memory.findMany({
        where: { agentSource: agentSource ?? undefined, supersededBy: null },
        select: { id: true, content: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
    } else if (type === "knowledge") {
      const rows = await prisma.knowledge.findMany({
        where: { agentSource: agentSource ?? undefined, supersededBy: null, stale: false },
        select: { id: true, content: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      recent = rows;
    }
    for (const r of recent) {
      const other = ngrams(r.content || "", 3);
      if (other.size < 5) continue;
      const sim = jaccard(cand3, other);
      if (sim >= MERGE_JACCARD_THRESHOLD) {
        return {
          action: "MERGE",
          targetId: r.id,
          reason: `jaccard 3-gram sim ${sim.toFixed(3)} ≥ ${MERGE_JACCARD_THRESHOLD} — supersede old`,
        };
      }
    }
  }

  // 5. 默认 CREATE
  return { action: "CREATE", reason: "no similar record found" };
}

/**
 * 落 ResolverDecision 审计行.
 */
export async function recordDecision(
  prisma: PrismaClient,
  params: {
    candidateId: string;
    type: string;
    action: ResolverAction;
    targetId?: string | null;
    reason: string;
    finalId?: string | null; // CREATE 后正式表 id
  }
): Promise<void> {
  await prisma.resolverDecision.create({
    data: {
      candidateId: params.candidateId,
      resolverType: params.type,
      action: params.action,
      targetId: params.targetId ?? params.finalId ?? null,
      reason: params.reason,
      status: "APPLIED",
    },
  });
}
