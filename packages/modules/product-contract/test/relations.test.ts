/**
 * extractKnowledgeRelations 单测 (round 72-D 遗留项)
 * 运行: cd packages/modules/product-contract && ../../../node_modules/.bin/tsx --test test/relations.test.ts
 * 零依赖: 只用 node:test + node:assert。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractKnowledgeRelations,
  extractKnowledgeHeadings,
  extractKnowledgeLinks,
  splitKnowledgeTags,
  knowledgeTagOverlap,
  knowledgeHeadingSlug,
  knowledgeRelationObserveLine,
  knowledgeRelationObserveLineFromCounts,
  KNOWLEDGE_RELATION_MAX,
  knowledgeEntityKey,
  buildKnowledgeEntityIndex,
  resolveKnowledgeEntity,
  knowledgeRelationEdgeKey,
  isSymmetricKnowledgeRelation,
  planKnowledgeRelationWrites,
  knowledgeRelationPlanObserveLine,
  knowledgeRelationWriteMode,
  applyKnowledgeRelationPlan,
} from "../src/index";

test("空输入: node=null, 零候选, missing=true", () => {
  const r = extractKnowledgeRelations({});
  assert.equal(r.node, null);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.stats.missing, true);
  assert.equal(knowledgeRelationObserveLine([r]), "[cognitive-gate/relation] missing=1/total=1");
});

test("① 小标题: ## 抽出, H1 不算, 文档 -> PART_OF 标题", () => {
  const content = [
    "# 大标题(不收)",
    "正文",
    "## 根因",
    "### 细节",
    "##  带空格标题  ",
    "## 根因", // 重复标题 -> 去重
  ].join("\n");
  const r = extractKnowledgeRelations({ title: "调度卡死复盘", content });
  const headingEdges = r.candidates.filter((c) => c.rule === "heading");
  assert.deepEqual(
    headingEdges.map((e) => [e.source, e.target, e.type, e.weight]),
    [
      ["调度卡死复盘", "根因", "PART_OF", 0.5],
      ["调度卡死复盘", "细节", "PART_OF", 0.5],
      ["调度卡死复盘", "带空格标题", "PART_OF", 0.5],
    ],
  );
  assert.equal(r.stats.headings, 4); // 原始小标题 4 个(含重复), 边去重后 3 条
});

test("② markdown 内链: 外链不算, 内链 -> RELATED_TO, #anchor 对上小标题 -> PART_OF", () => {
  const content = [
    "## 修复步骤",
    "## 根因",
    "见 [官网](https://example.com/x) 和 [邮件](mailto:a@b.c)。",
    "参考 [另一篇](./other.md) 与 [根因](#根因) 还有 [死链](#不存在)。",
  ].join("\n");
  const r = extractKnowledgeRelations({ title: "内链测试", content });
  const links = r.candidates.filter((c) => c.rule === "md-link");
  // 注: `[根因](#根因)` 与 ① 的小标题边 (内链测试 -PART_OF-> 根因) 同 source/target/type,
  //     被去重 -> md-link 只剩 2 条; 但 ① 里已有 `根因 PART_OF` 边(见 heading 断言)。
  assert.deepEqual(
    links.map((e) => [e.target, e.type, e.weight]),
    [
      ["另一篇", "RELATED_TO", 0.9],
      ["不存在", "RELATED_TO", 0.9],
    ],
  );
  assert.ok(
    r.candidates.some((c) => c.target === "根因" && c.type === "PART_OF" && c.rule === "heading"),
    "anchor 命中的 PART_OF 边应由 heading 规则产出",
  );
});

test("③ 标签: 文档 -> RELATED_TO 标签, 中英标点混合去重", () => {
  const r = extractKnowledgeRelations({
    title: "标签测试",
    content: "正文",
    tags: "Prisma, prisma，SQLite、调度 ;#轮询| sqlite",
  });
  const tagEdges = r.candidates.filter((c) => c.rule === "tag");
  assert.deepEqual(tagEdges.map((e) => e.target), ["Prisma", "SQLite", "调度", "轮询"]);
  for (const e of tagEdges) assert.equal(e.type, "RELATED_TO");
  assert.equal(r.stats.tags, 4);
});

test("④ 标签重叠: 重叠比 >= 阈值 -> SIMILAR_TO 兄弟文档, weight=重叠比", () => {
  const own = { title: "A", content: "x", tags: "prisma,sqlite,调度" };
  const peers = [
    { title: "B", tags: "prisma,sqlite,无关" }, // 2/3 = 0.667 >= 0.5
    { title: "C", tags: "prisma" }, // 1/1 = 1.0 >= 0.5 (重叠系数按较短集合)
    { title: "D", tags: "prisma,调度,别的,更多" }, // 2/3 = 0.667
    { title: "E", tags: "完全,不同" }, // 0
  ];
  const r = extractKnowledgeRelations(own, { peers });
  const sim = r.candidates.filter((c) => c.rule === "tag-overlap");
  assert.deepEqual(
    sim.map((c) => [c.source, c.target, c.type, c.weight]),
    [
      ["A", "B", "SIMILAR_TO", 0.667],
      ["A", "C", "SIMILAR_TO", 1],
      ["A", "D", "SIMILAR_TO", 0.667],
    ],
  );
  assert.equal(sim[0].evidence, "shared:prisma,sqlite");
});

test("阈值可调: tagOverlapMin=0.8 时只剩完全包含的 peer", () => {
  const r = extractKnowledgeRelations(
    { title: "A", tags: "prisma,sqlite,调度" },
    { peers: [{ title: "B", tags: "prisma,sqlite,无关" }, { title: "C", tags: "prisma" }], tagOverlapMin: 0.8 },
  );
  assert.deepEqual(r.candidates.filter((c) => c.rule === "tag-overlap").map((c) => c.target), ["C"]);
});

test("确定性: 同输入两次深比较相等 (对照 knowledge-graph.ts 的 Math.random 造边)", () => {
  const input = {
    title: "确定性",
    content: "## A\n## B\n[c](./d.md)\n",
    tags: "t1,t2",
  };
  const opts = { peers: [{ title: "P", tags: "t1" }] };
  assert.deepEqual(extractKnowledgeRelations(input, opts), extractKnowledgeRelations(input, opts));
});

test("候选上限 maxCandidates 生效, 且 weight 全在 0-1", () => {
  const content = Array.from({ length: 80 }, (_, i) => `## h${i}`).join("\n");
  const r = extractKnowledgeRelations({ title: "上限", content }, { maxCandidates: 5 });
  assert.equal(r.candidates.length, 5);
  assert.equal(r.stats.byRule.heading, 5);
  for (const c of r.candidates) assert.ok(c.weight > 0 && c.weight <= 1, `weight ${c.weight}`);
  const def = extractKnowledgeRelations({ title: "上限", content });
  assert.equal(def.candidates.length, KNOWLEDGE_RELATION_MAX);
});

test("子解析器: headings / links / tags / slug / overlap 各自独立可测", () => {
  assert.deepEqual(extractKnowledgeHeadings("## a\n# b\n###### c").map((h) => [h.text, h.level]), [["a", 2], ["c", 6]]);
  assert.equal(extractKnowledgeLinks("[x](http://a)").length, 0);
  assert.equal(extractKnowledgeLinks("[x](./a.md)").length, 1);
  assert.deepEqual(splitKnowledgeTags(["a", "A", "b"]), ["a", "b"]);
  assert.equal(knowledgeHeadingSlug("根因 & 修复!"), "根因-修复");
  assert.deepEqual(knowledgeTagOverlap(["a", "b"], ["b", "c"]), { ratio: 0.5, shared: ["b"] });
  assert.deepEqual(knowledgeTagOverlap([], ["b"]), { ratio: 0, shared: [] });
});

test("observe 汇总行: missing/total 与逐条 missing 一致", () => {
  const hit = extractKnowledgeRelations({ title: "有关系", content: "## h" });
  const miss = extractKnowledgeRelations({ title: "没关系", content: "平铺正文" });
  assert.equal(knowledgeRelationObserveLine([hit, miss, miss]), "[cognitive-gate/relation] missing=2/total=3");
  assert.equal(knowledgeRelationObserveLine([]), "[cognitive-gate/relation] missing=0/total=0");
  // store 侧累计计数用同口径(避免两处格式漂移)
  assert.equal(knowledgeRelationObserveLineFromCounts(0, 0), "[cognitive-gate/relation] missing=0/total=0");
  assert.equal(knowledgeRelationObserveLineFromCounts(7, 20), "[cognitive-gate/relation] missing=7/total=20");
  assert.equal(knowledgeRelationObserveLineFromCounts(-1, NaN as unknown as number), "[cognitive-gate/relation] missing=0/total=0");
});

// =====================================================================================
// 2026-10-09 round 72-D 遗留项(落库): 候选 -> KnowledgeRelation 计划/执行 单测
// =====================================================================================

const ENTITIES = [
  { id: "e1", name: "Prisma", aliases: "Prisma DB, 数据层" },
  { id: "e2", name: "SQLite" },
  { id: "e3", name: "React" },
];

test("name->id 映射: 归一 name/aliases/大小写/空白都命中同一实体", () => {
  const idx = buildKnowledgeEntityIndex(ENTITIES as never);
  assert.equal(knowledgeEntityKey("  #Prisma  "), "prisma");
  assert.equal(knowledgeEntityKey("Prisma。"), "prisma");
  const a = resolveKnowledgeEntity("PRISMA", idx);
  assert.equal(a.resolved, true);
  assert.equal(a.resolved && a.entity.id, "e1");
  const b = resolveKnowledgeEntity("prisma db", idx);
  assert.equal(b.resolved && b.entity.id, "e1");
  const c = resolveKnowledgeEntity("  数据层 ", idx);
  assert.equal(c.resolved && c.entity.id, "e1");
  assert.equal(resolveKnowledgeEntity("不存在", idx).resolved, false);
});

test("撞名不猜: 归一后同 key 的两个实体 -> entity_ambiguous(不落库)", () => {
  const idx = buildKnowledgeEntityIndex([{ id: "a", name: "Alpha" }, { id: "b", name: "alpha" }] as never);
  const r = resolveKnowledgeEntity("ALPHA", idx);
  assert.equal(r.resolved, false);
  assert.equal(r.resolved === false && r.reason, "entity_ambiguous");
  const plan = planKnowledgeRelationWrites(
    { node: "Alpha", candidates: [{ source: "Alpha", target: "Alpha!", type: "RELATED_TO", weight: 0.6, rule: "tag", evidence: "tag:Alpha" }], stats: { headings: 0, links: 0, tags: 1, missing: false, byRule: { heading: 0, "md-link": 0, tag: 1, "tag-overlap": 0 } } },
    idx,
    { projection: "direct" },
  );
  assert.equal(plan.writes.length, 0);
  assert.ok(plan.unresolved.some((u) => u.reason === "entity_ambiguous"));
});

test("direct 投影: 只有两端都映射到实体才成边(文档 title 不是实体 -> 0 边)", () => {
  const both = extractKnowledgeRelations({ title: "Prisma", content: "正文", tags: "SQLite" });
  const plan = planKnowledgeRelationWrites(both, ENTITIES as never, { projection: "direct" });
  assert.equal(plan.writes.length, 1);
  assert.deepEqual(
    [plan.writes[0].sourceId, plan.writes[0].targetId, plan.writes[0].relationType, plan.writes[0].weight],
    ["e1", "e2", "RELATED_TO", 0.6],
  );
  assert.equal(plan.writes[0].action, "insert");

  const docOnly = extractKnowledgeRelations({ title: "调度复盘", content: "正文", tags: "SQLite" });
  const plan2 = planKnowledgeRelationWrites(docOnly, ENTITIES as never, { projection: "direct" });
  assert.equal(plan2.writes.length, 0);
  assert.ok(plan2.unresolved.some((u) => u.name === "调度复盘" && u.side === "source" && u.reason === "entity_missing"));
});

test("cooccur 投影: 文档内已解析概念两两 RELATED_TO, 对称边 (A,B)/(B,A) 归一去重", () => {
  const ex = extractKnowledgeRelations({ title: "共现文档", content: "正文", tags: "Prisma,SQLite,无关" });
  const plan = planKnowledgeRelationWrites(ex, ENTITIES as never, { projection: "cooccur" });
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].relationType, "RELATED_TO");
  assert.equal(plan.writes[0].weight, 0.6);
  assert.equal(plan.writes[0].evidence[0], "cooccur@共现文档");
  // 对称 key 归一: (e1,e2) 与 (e2,e1) 同 key
  assert.equal(
    knowledgeRelationEdgeKey("e1", "e2", "RELATED_TO"),
    knowledgeRelationEdgeKey("e2", "e1", "RELATED_TO"),
  );
  assert.notEqual(knowledgeRelationEdgeKey("e1", "e2", "PART_OF"), knowledgeRelationEdgeKey("e2", "e1", "PART_OF"));
  assert.equal(isSymmetricKnowledgeRelation("RELATED_TO"), true);
  assert.equal(isSymmetricKnowledgeRelation("PART_OF"), false);
});

test("@@unique 冲突策略: 已存在同 weight -> skip; 更低 -> update; 反向对称边 -> skip; 不同 type -> insert", () => {
  const ex = extractKnowledgeRelations({ title: "Prisma", content: "正文", tags: "SQLite" });
  const base = { projection: "direct" as const };
  const skip = planKnowledgeRelationWrites(ex, ENTITIES as never, {
    ...base,
    existingRelations: [{ sourceId: "e1", targetId: "e2", relationType: "RELATED_TO", weight: 0.6 }],
  });
  assert.equal(skip.writes[0].action, "skip");
  assert.equal(skip.writes[0].reason, "existing_weight_ge");
  assert.deepEqual([skip.stats.insert, skip.stats.update, skip.stats.skip], [0, 0, 1]);

  const up = planKnowledgeRelationWrites(ex, ENTITIES as never, {
    ...base,
    existingRelations: [{ sourceId: "e1", targetId: "e2", relationType: "RELATED_TO", weight: 0.3 }],
  });
  assert.equal(up.writes[0].action, "update");
  assert.equal(up.writes[0].reason, "weight_upgrade");

  const rev = planKnowledgeRelationWrites(ex, ENTITIES as never, {
    ...base,
    existingRelations: [{ sourceId: "e2", targetId: "e1", relationType: "RELATED_TO", weight: 0.6 }],
  });
  assert.equal(rev.writes[0].action, "skip", "对称边反向也应命中 @@unique 冲突策略");

  const other = planKnowledgeRelationWrites(ex, ENTITIES as never, {
    ...base,
    existingRelations: [{ sourceId: "e1", targetId: "e2", relationType: "PART_OF", weight: 0.6 }],
  });
  assert.equal(other.writes[0].action, "insert", "不同 relationType 不受唯一键影响");
});

test("@@unique 冲突策略(反向对称边需权重升级): update 必须回传库中原方向", async () => {
  const ex = extractKnowledgeRelations({ title: "Prisma", content: "正文", tags: "SQLite" });
  // 库里已存在**反向** RELATED_TO(e2->e1) 且 weight 更低 -> 计划判 update
  const plan = planKnowledgeRelationWrites(ex, ENTITIES as never, {
    projection: "direct",
    existingRelations: [{ sourceId: "e2", targetId: "e1", relationType: "RELATED_TO", weight: 0.3 }],
  });
  assert.equal(plan.writes[0].action, "update");
  // 计划里的规范方向仍是 e1->e2
  assert.deepEqual([plan.writes[0].sourceId, plan.writes[0].targetId], ["e1", "e2"]);
  // 但必须带上库中那一行的原方向, 否则适配器精确匹配 UPDATE 0 行
  assert.deepEqual([plan.writes[0].existingSourceId, plan.writes[0].existingTargetId], ["e2", "e1"]);
  const seen: Array<[string, string]> = [];
  const adapter = {
    nextRelationId: () => "kr_x",
    insertRelation: () => {},
    updateRelationWeight: (r: { sourceId: string; targetId: string }) => { seen.push([r.sourceId, r.targetId]); },
  };
  const res = await applyKnowledgeRelationPlan(plan, adapter, { mode: "write" });
  assert.deepEqual([res.updated, res.failed, seen], [1, 0, [["e2", "e1"]]], "update 必须命中已存在反向边原方向");
  // 同向时原方向 == 规范方向, 行为不变
  const same = planKnowledgeRelationWrites(ex, ENTITIES as never, {
    projection: "direct",
    existingRelations: [{ sourceId: "e1", targetId: "e2", relationType: "RELATED_TO", weight: 0.3 }],
  });
  assert.deepEqual([same.writes[0].existingSourceId, same.writes[0].existingTargetId], ["e1", "e2"]);
});

test("自环(别名解析到同一实体)被丢弃; maxEdges 截断; 同输入计划确定", () => {
  const selfLoop = {
    node: "Prisma",
    candidates: [
      { source: "Prisma", target: "prisma db", type: "RELATED_TO" as const, weight: 0.6, rule: "tag" as const, evidence: "tag:prisma db" },
    ],
    stats: { headings: 0, links: 0, tags: 1, missing: false, byRule: { heading: 0, "md-link": 0, tag: 1, "tag-overlap": 0 } },
  };
  const p = planKnowledgeRelationWrites(selfLoop, ENTITIES as never, { projection: "direct" });
  assert.equal(p.writes.length, 0);
  assert.equal(p.stats.dropsSelfLoop, 1);

  const many = extractKnowledgeRelations({ title: "共现", tags: "Prisma,SQLite,React" });
  const capped = planKnowledgeRelationWrites(many, ENTITIES as never, { projection: "cooccur", maxEdges: 1 });
  assert.equal(capped.writes.length, 1);
  assert.ok(capped.stats.dropsCapped >= 2);
  assert.deepEqual(planKnowledgeRelationWrites(many, ENTITIES as never, { projection: "cooccur" }), planKnowledgeRelationWrites(many, ENTITIES as never, { projection: "cooccur" }));
});

test("观察行与写模式开关", () => {
  const ex = extractKnowledgeRelations({ title: "Prisma", content: "正文", tags: "SQLite" });
  const plan = planKnowledgeRelationWrites(ex, ENTITIES as never, { projection: "direct" });
  assert.equal(knowledgeRelationPlanObserveLine(plan), "[cognitive-gate/relation-plan] insert=1 update=0 skip=0 unresolved=0/1");
  const saved = process.env.KNOWLEDGE_RELATION_WRITE;
  delete process.env.KNOWLEDGE_RELATION_WRITE;
  assert.equal(knowledgeRelationWriteMode(), "write", "默认 write: 加性旁路落库(不阻断 Knowledge)");
  process.env.KNOWLEDGE_RELATION_WRITE = "write";
  assert.equal(knowledgeRelationWriteMode(), "write");
  process.env.KNOWLEDGE_RELATION_WRITE = "enforce";
  assert.equal(knowledgeRelationWriteMode(), "write");
  process.env.KNOWLEDGE_RELATION_WRITE = "observe";
  assert.equal(knowledgeRelationWriteMode(), "observe", "显式 observe 才回到只出计划不写");
  process.env.KNOWLEDGE_RELATION_WRITE = "off";
  assert.equal(knowledgeRelationWriteMode(), "observe");
  process.env.KNOWLEDGE_RELATION_WRITE = "0";
  assert.equal(knowledgeRelationWriteMode(), "observe");
  if (saved === undefined) delete process.env.KNOWLEDGE_RELATION_WRITE;
  else process.env.KNOWLEDGE_RELATION_WRITE = saved;
});

test("applyKnowledgeRelationPlan: observe 零调用; write 真写; 单条失败不抛出只计 failed", async () => {
  const ex = extractKnowledgeRelations({ title: "Prisma", content: "正文", tags: "SQLite" });
  const insertPlan = planKnowledgeRelationWrites(ex, ENTITIES as never, { projection: "direct" });
  const upPlan = planKnowledgeRelationWrites(ex, ENTITIES as never, {
    projection: "direct",
    existingRelations: [{ sourceId: "e1", targetId: "e2", relationType: "RELATED_TO", weight: 0.1 }],
  });
  let inserts = 0;
  let updates = 0;
  let ids = 0;
  const adapter = {
    nextRelationId: () => `kr_${++ids}`,
    insertRelation: () => { inserts++; },
    updateRelationWeight: () => { updates++; },
  };
  const dry = await applyKnowledgeRelationPlan(insertPlan, adapter, { mode: "observe" });
  assert.deepEqual([dry.mode, dry.inserted, inserts], ["observe", 1, 0]);
  const wet = await applyKnowledgeRelationPlan(insertPlan, adapter, { mode: "write" });
  assert.deepEqual([wet.inserted, wet.failed, inserts], [1, 0, 1]);
  const wet2 = await applyKnowledgeRelationPlan(upPlan, adapter, { mode: "write" });
  assert.deepEqual([wet2.updated, updates], [1, 1]);
  const boom = {
    nextRelationId: () => "kr_x",
    insertRelation: () => { throw new Error("db down"); },
    updateRelationWeight: () => { throw new Error("db down"); },
  };
  const failed = await applyKnowledgeRelationPlan(insertPlan, boom, { mode: "write" });
  assert.deepEqual([failed.inserted, failed.failed], [0, 1], "旁路写入失败必须吞掉(不阻断 Knowledge 落库)");
});
