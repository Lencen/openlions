// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

import { createHash } from "crypto";
// 2026-09-29 round 16: 引入 PRODUCT_RULES (单一来源) 的 isCompliant
const PRODUCT_RULES = require("./lib/product-format-rules.cjs");

// 2026-09-29 round 11 (agent-d): inline 简化版 normalizeFlywheelTitle,
// 避免 cross-module import 依赖。与 flywheel-prompt-constraints.ts:normalizeFlywheelTitle 同口径。
function normalizeFlywheelTitle(raw: unknown, maxTitle = 30): string {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= maxTitle) return t;
  return t.slice(0, maxTitle);
}

type PrismaClient = any;

export class PrismaMemoryStore {
  constructor(private prisma: PrismaClient) {}

  async list(opts: any = {}): Promise<{items: any[]; total: number; page: number; pageSize: number}> {
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 20;
    const where: any = {};
    if (opts.tier) where.tier = opts.tier;
    if (opts.domain) where.domain = opts.domain;
    if (opts.search) where.OR = [
      { title: { contains: opts.search } },
      { content: { contains: opts.search } },
    ];
    const [items, total] = await Promise.all([
      this.prisma.memory.findMany({ where, skip: (page-1)*pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.memory.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
  async get(input: any): Promise<any> {
    return this.prisma.memory.findUnique({ where: { id: input.id || input } });
  }
  async create(data: any): Promise<any> {
    // 单点出口 (2026-08-27 fix): contentHash 缺失时基于 content 自动计算
    // 根因: reflect.ts 曾假设"内部算 hash"但本方法裸透传, 导致 1276+ 条 FLYWHEEL_REFLECTION 空 hash
    // 架构决策: hash 逻辑放此处 (唯一 Memory 写入出口), 所有调用方 (reflect/execute-task/未来) 自动受益
    if (!data.contentHash && data.content) {
      data = { ...data, contentHash: createHash("sha256").update(String(data.content)).digest("hex") };
    }
    // 2026-09-29 (agent-d, 休假期间) V3 五件套软验证 (round 11):
    //   本方法是 modules/memory 的"单点出口", 所有 Memory 写入 (reflect/execute-task/db-writer)
    //   都经过这里 -> 在此处接 V3 软验证即可覆盖所有 Memory 写入路径。
    //   之前 round 7/8 改 db-writer.ts 是错位置 (主产线走的是 modules/memory 这条),
    //   现在回归正确位置: 用 normalizeFlywheelTitle 把 title 截断到 30 (V3 标准),
    //   不合规内容直接拒绝 (return null, 调用方需处理)。
const _title = String(data.title ?? "");
    const _content = String(data.content ?? "");
    // 2026-09-29 round 16: 改用 isCompliant 综合判据 (含 isShortEmpty, 防"标题有,内容空"逃避式逃过)
    // 2026-10-08 round 55: 写入侧 single-exit 闸, 在 V3 验证**之前**做受控投影 (a) 即使 V3 拒绝(返回 null), 投影在内存 data 上已完成(无副作用);
    //   (b) 后续 V3/normalize 抛错时本行不影响(catch 在 store 内部); (c) 真正落库时 domain 已是受控值。
    const { projectDomain, calcQualityScore } = require("@lions/product-contract");
    const _domain = projectDomain(data.domain);
    if (_domain !== null) data = { ...data, domain: _domain };
    // round 56a: qualityScore 兜底(只在缺失/0 时填, 不覆盖有效分数); 走 product-contract 的同一天平, 不再有第二套.
    if (data.qualityScore == null || data.qualityScore === 0) {
      data = { ...data, qualityScore: calcQualityScore({ type: "memory", content: data.content || "", title: data.title, theme: data.theme, tags: data.tags, valueScore: data.valueScore ?? data.importance, reinforceCount: 0 }) };
    }
    // 2026-10-08 round 58(人类裁决): 标题超长**不再拒绝**, 改为归一(去模板前缀 + 保头保尾压缩) -> 一条不丢;
    //   内容类规则(逃避式/短而空)仍拦截, 但改为**显式记数 + 日志**(不再静默丢弃, 便于守门与人工发现).
    const { normalizeProductTitle } = require("@lions/product-contract");
    const _titleNorm = normalizeProductTitle(_title, { max: 30 }) || normalizeFlywheelTitle(_title, 30);
    const _check = PRODUCT_RULES.isCompliant({ title: _titleNorm, content: _content, kind: "memory" });
    if (!_check.ok) {
      try { const g = globalThis as any; g.__lionsContentRejectCount = (g.__lionsContentRejectCount || 0) + 1; } catch (e) {}
      console.warn("[PrismaMemoryStore] reject(内容不合规, 非标题) Memory: " + _titleNorm.slice(0, 60) + " — " + _check.reason);
      return null;
    }
    data = { ...data, title: _titleNorm };
    // ===== 2026-10-09 round 72-D 认知闸(人类裁决的"定义"). observe=只记不拦; enforce=真拦 =====
    //   为什么先 observe: 生产者还没全部升级(实测 Memory 的 summary 只 37%、scenario 0%),
    //   直接 enforce 会拒掉大部分新产物。切换: COGNITIVE_GATE_MODE=enforce
    try {
      const _g = require("@lions/product-contract");
      const _v = _g.checkMemoryCompleteness(data);
      if (!_v.ok) {
        // 2026-10-09 round 72-I: 前缀区分 observe/reject —— 切 enforce 后"被拒了多少条"是唯一能
        //   衡量切档代价的数字, 与"观察档的告警"必须能分开 grep。
        const _enforce = typeof _g.cognitiveGateMode === "function" && _g.cognitiveGateMode() === "enforce";
        console.warn("[cognitive-gate:" + (_enforce ? "reject" : "observe") + "] memory " + _v.reason);
        if (_enforce) {
          return null; // 调用方需处理(与 V3 闸同语义)
        }
      }
    } catch (_e) { /* 闸自身异常绝不阻断写入 */ }
    return this.prisma.memory.create({ data });
  }
  async getTierDistribution(): Promise<any> {
    const rows = await this.prisma.$queryRaw`SELECT tier, COUNT(*) as count FROM "Memory" GROUP BY tier`;
    const result: any = {};
    for (const r of rows) result[r.tier] = Number(r.count);
    return result;
  }
  async getDomainDistribution(): Promise<any> {
    const rows = await this.prisma.$queryRaw`SELECT domain, COUNT(*) as count FROM "Memory" GROUP BY domain`;
    const result: any = {};
    for (const r of rows) result[r.domain] = Number(r.count);
    return result;
  }
}

export const __PLACEHOLDER__ = true;
