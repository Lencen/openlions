// =====================================================================================
// 2026-10-09 实践遗留落地: extractRelations 的 RELATED_TO 由 Math.random()>0.7 改为确定性规则
// -----------------------------------------------------------------------------------
// 出处(改动前): packages/apps/mind/src/server/routers/knowledge-graph.ts:52-73
//   `if (i < j && Math.random() > 0.7) { relations.push({... RELATED_TO}) }`
//   该函数是 knowledgeGraph.buildFromText mutation 的唯一关系来源, 而 buildFromText 又会
//   真写 KnowledgeRelation —— 即"落 relation"路径上每条 RELATED_TO 都是随机噪音, 同一 text
//   跑两次落库集合不同, 不可复算(现网 KnowledgeRelation 60 行**全部**是 RELATED_TO)。
//
// 本次落地(最小爆炸面):
//   - 把纯逻辑抽到本文件(无 IO / 无 tRPC / 无别名 import, 可被 tsx 直接单测);
//   - RELATED_TO 改用**确定性共现规则**: 两个实体名出现在同一句(sentence segment)才建边;
//     句子切分与实体顺序都确定 -> 同输入同输出, 逐字节可复算;
//   - 显式规则(prisma+database -> USES / scheduler+task -> PART_OF / api+tRPC -> IS_A)原样保留。
//
// **留给下一步 relation 生成重写**(本文件已标注 TODO): 共现只是"去掉随机"的确定性占位规则,
//   真正的语义关系抽取(需要 LLM/embedding)不在本次范围。buildFromText 里实体/关系的 id 仍用
//   `Math.random()` 生成无关的可复算性(集合与类型已确定, 只有代理主键不同), 同样留给重写。
// =====================================================================================

export interface KgEntity {
  name: string;
  type: string;
}

export interface KgRelation {
  source: string;
  target: string;
  type: string;
  /** 可复算证据: 命中的句子(确定性规则)或显式关键词; 仅用于核验/测试, 落库不依赖它 */
  evidence?: string;
}

/** 句子切分: 中英句末标点 / 分号 / 换行。刻意不含 `.`(避免 Node.js 被切开) */
const KG_SENTENCE_SPLIT = /[。！？!?；;\n\r]+/;
/** 单文档关系上限(沿用改动前的 15, 保持落库量级不变) */
export const KG_RELATION_MAX = 15;

// 从文本中提取实体(逻辑与改动前 knowledge-graph.ts:7-49 保持一致)
export function extractEntities(text: string): KgEntity[] {
  const entities: KgEntity[] = [];

  const techTerms = [
    "Prisma", "Next.js", "React", "TypeScript", "Node.js", "tRPC", "SQLite",
    "API", "Router", "Service", "Model", "Controller", "Middleware",
    "Memory", "Knowledge", "Skill", "Practice", "Reflection",
    "Lions-Mind", "Lions-Task", "Hermes", "Claude",
    "database", "schema", "query", "mutation", "subscription",
    "scheduler", "cron", "trigger", "task", "problem",
  ];

  techTerms.forEach(term => {
    if (text.includes(term) && !entities.some(e => e.name === term)) {
      entities.push({ name: term, type: "TOOL" });
    }
  });

  // 概念模式 (XX是YY, XX即YY)
  const conceptPattern = /(?:([A-Z][a-zA-Z]+(?:[A-Z][a-z]*)*)\s+(?:是|即|被称为|称为)\s+([A-Z][a-zA-Z]+(?:[A-Z][a-z]*)*))/g;
  let match: RegExpExecArray | null;
  while ((match = conceptPattern.exec(text)) !== null) {
    if (!entities.some(e => e.name === match![1])) {
      entities.push({ name: match![1], type: "CONCEPT" });
    }
  }

  // 从标签中提取
  const tagMatches = text.match(/([a-z]+(?:-[a-z]+)*)/gi);
  if (tagMatches) {
    tagMatches.forEach(tag => {
      const clean = tag.toLowerCase();
      if (clean.length > 3 && !entities.some(e => e.name.toLowerCase() === clean)) {
        if (["prisma", "scheduler", "task", "api", "database", "bug", "fix"].includes(clean)) {
          entities.push({ name: clean, type: "TOOL" });
        } else if (["problem", "solution", "reflection", "insight"].includes(clean)) {
          entities.push({ name: clean, type: "CONCEPT" });
        }
      }
    });
  }

  return entities.slice(0, 20);
}

/**
 * 把文本切成句子段(只保留非空段; 空文本 -> [])。
 * 切分规则固定、无状态, 因此同一 text 每次得到完全相同的段序列。
 */
export function splitKgSentences(text: string): string[] {
  const raw = String(text == null ? "" : text);
  if (!raw) return [];
  return raw.split(KG_SENTENCE_SPLIT).map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * 确定性 RELATED_TO 规则: 实体对 (i<j) 若出现在**同一句**里, 建一条 RELATED_TO。
 * - 实体顺序 = extractEntities 的输出顺序(固定);
 * - 遍历 j 从 i+1 升序; 共享句取**最小句索引**作为 evidence -> 完全确定;
 * - 无随机、无 IO、无时间依赖 -> 同输入同输出。
 */
export function extractCooccurrenceRelations(
  text: string,
  entities: KgEntity[],
  max: number = KG_RELATION_MAX,
): KgRelation[] {
  const sentences = splitKgSentences(text);
  // 每个实体命中的句索引集合(升序插入 -> 遍历顺序确定)
  const hits: Array<Set<number>> = entities.map(e => {
    const needle = String(e && e.name ? e.name : "").toLowerCase();
    const set = new Set<number>();
    if (!needle) return set;
    for (let idx = 0; idx < sentences.length; idx++) {
      if (sentences[idx].toLowerCase().includes(needle)) set.add(idx);
    }
    return set;
  });

  const relations: KgRelation[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      let shared = -1;
      for (const idx of hits[i]) {
        if (hits[j].has(idx)) { shared = idx; break; }
      }
      if (shared >= 0) {
        relations.push({
          source: entities[i].name,
          target: entities[j].name,
          type: "RELATED_TO",
          evidence: sentences[shared],
        });
      }
    }
  }
  return relations.slice(0, max);
}

// 从文本中提取关系(确定性: RELATED_TO 走共现规则; 显式规则与改动前一致)
export function extractRelations(text: string, entities: KgEntity[]): KgRelation[] {
  const relations: KgRelation[] = extractCooccurrenceRelations(text, entities);

  if (text.includes("prisma") && text.includes("database")) {
    relations.push({ source: "Prisma", target: "database", type: "USES", evidence: "prisma+database" });
  }
  if (text.includes("scheduler") && text.includes("task")) {
    relations.push({ source: "scheduler", target: "task", type: "PART_OF", evidence: "scheduler+task" });
  }
  if (text.includes("api") && text.includes("tRPC")) {
    relations.push({ source: "tRPC", target: "API", type: "IS_A", evidence: "api+tRPC" });
  }

  return relations.slice(0, KG_RELATION_MAX);
}
