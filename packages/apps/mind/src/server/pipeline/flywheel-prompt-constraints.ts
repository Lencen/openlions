/**
 * flywheel-prompt-constraints.ts
 * 飞轮 LLM 产 Knowledge/Memory/Practice 的 V3 五件套硬约束 (2026-09-29)
 *
 * 为什么单独建这个文件 (根因):
 *   todo_0aa1ea6d28a049fba44d 守门数据暴露:
 *   - Knowledge 24h 117 条: 94% 长 title (>30字) / 100% 无 markdown 结构 / 5.1% 逃避式条目
 *     (例如 "对话提到X但无对应 Knowledge/Practice" / "暂未记录" / "需调研后补")
 *   - Practice 24h 88 条: 96.6% 长 title / 100% 无 markdown / 3.4% 逃避式
 *   - Memory 24h 459 条: 64.7% 无 markdown / 0.7% 逃避式 (Memory 无 title, 该比例低)
 *
 *   结构化产物成了"Markdown 文本压扁到一行的复述/逃避句", FW-QUALITY 被拉低且无任何 prompt
 *   阻止它产出。守门只监测不挡, 治本必须改 prompt 硬约束 + 产出后 post-processing 拒收。
 *
 * 怎么用 (单一权威源, 所有 LLM 产 Knowledge/Memory/Practice 的 prompt 都应拼接 HARD_RULES):
 *   1. EXTRACTION_SYSTEM_PROMPT (cognitive-extractor.ts) - V3.0 主提取入口
 *   2. buildStructurePrompt (structure-fragments.ts)   - 碎片反向整理
 *   3. systemPrompt (global-organizer.ts)              - 跨 session 全局整理
 *
 *   入口三处共享同一段 HARD_RULES, 未来加新产线 (例如 skills/reflection 单独产线) 只需再 import,
 *   不重复定义口径。validateFlywheelProduct() 给产出后 post-processing 用, 不合规返回 reject
 *   + reason, 调用方决定 reject-重试 或 reject-丢弃。
 *
 * 不改的东西 (诚实披露):
 *   - 评分公式 calcQualityScore (db-writer.ts): 本模块不动 OK 指标本身, 只在 prompt 层面
 *     提升"原始产物质量", 让评分有更多 positive evidence 可拿。
 *   - 入库链路 runResolver (db-writer.ts): 不在这里偷偷替换入库流程, 只在 prompt 层 +
 *     调用方 reject 之间夹一道关。
 *   - structure-fragments "belowFloor 仍入库" 的设计: 与本模块不冲突, belowFloor 是"内容
 *     价值分低于门槛", 本模块是"格式不合规", 两者正交。
 */

// === 1. 单一权威硬约束块 (供 3 处 prompt 拼接) ===

/**
 * 拼接后塞进 system prompt 末尾或 user prompt 开头。
 * 不破坏现有结构, 仅追加。Markdown 渲染友好, LLM 直接阅读。
 */
export const V3_FIVE_PIECE_HARD_RULES = `
【V3 五件套硬约束 (强制) — 违反的产物会被守门拒收, 不入库】
本规则适用于 knowledge / memory / practice / reflection / skill 全部 5 类认知产物。每条产物都必须满足以下 5 项, 缺一项视为不合格:

1. **title 长度**: knowledge/practice/reflection title 必须在 4–30 字之间, memory 可无 title (或用 content 前 30 字作 title), skill name 必须 4–20 字动宾短语。
   - 超长 title 一律视为不合格, 不能用堆叠项目符号堆砌 (例如 "[反思] [反思] [反思]" 这种标题会被拒)。

2. **markdown 结构强制**: content/description 必须含至少一个 markdown 结构元素, 三选一即可:
   - \`##\` / \`###\` 二级或三级标题 (推荐, 用于分段)
   - \`- \` 或 \`* \` 开头的 bullet 项 (至少 2 条, 用于罗列要点/步骤/条件)
   - 加粗 \`**关键词**\` 或 \`代码\` 行内排版 (用于突出关键概念/命令/路径)
   纯文本压扁到一行 (无论字数多少) 一律视为不合格。

3. **V3 五件套三选一必含**: 每条 content 必须命中以下三类之一, **否则视为不合格**:
   - **决策规则**: 含 "必须/不要/优先/应/避免/禁止/务必/不能" 等决策词;
   - **经验/根因**: 含 "因为/所以/根因/教训/导致/原因是" 等归因词;
   - **可复现具体性**: 含命令/路径/参数/数字/库名/API 端点/文件名 (例如 \`pnpm test\`、\`/api/v1/...\`、\`>= 30\`)。
   三选一的组合通常高 0.5 倍 (例如 "必须...因为...命令 X")。

4. **逃避式条目 (Evasive) 一律丢弃**: 以下任一模式命中, 即使凑出字数也视为不合格 (违反"如果无 Knowledge 应跳过不写"铁律):
   - \`对话提到\` / \`对话中提到\` / \`对话中明确\`
   - \`对话暗示\` / \`对话中暗示\`
   - \`未明确\` / \`未明确指出\` / \`暂未记录\` / \`未记录\`
   - \`无对应 Knowledge\` / \`无对应知识\` / \`未沉淀为\`
   - \`需调研\` / \`后续补充\` / \`待补\`
   - \`暂无记录\` / \`无法判定\` / \`覆盖度未达标\`
   若无足够信息, **请直接跳过该条目不输出**, 而不是输出逃避式占位文本。

5. **JSON 输出**: 仍然只返回合法 JSON, 不要 markdown 代码块 (\`\`\`json)。其它规则与现有 system prompt 一致。
`;

/**
 * 结构化产物 (structure-fragments 路径) 的简化版硬约束, 因为该路径只产
 * knowledge/memory/practice 三类 (无 reflection/skill), 字段不同。
 */
export const STRUCTURED_OUTPUT_HARD_RULES = `
【V3 五件套硬约束 (强制) — 违反的产物会被守门拒收, 不入库】
每个 output 条目必须满足:
1. **title 简明**: 4–30 字, 严禁"堆叠项目符号作标题" (如 "[反思][反思][反思]" 必须重写为一句具体标题)。
2. **content 完整 markdown**: 必须含 \`##\` 标题 + 至少 2 个 bullet (\`- \` 或 \`* \`) + 至少 1 个加粗/代码 行内排版。三选一即合格, 但建议三项齐备。
3. **V3 五件套三选一必含** (决策规则 / 经验根因 / 可复现具体性): 任一缺失会被计 belowFloor 并拉低 FW-QUALITY。
4. **逃避式条目禁止**: 命中 \`对话提到\`/\`对话暗示\`/\`未明确\`/\`无对应\`/\`需调研\`/\`后续补充\`/\`暂未记录\` 一律视为不合格, 应跳过不写而非凑占位。
5. **valueScore 自评**: 命中决策规则 + 具体性 +0.3 起评; 仅复述现象 0.3 以下; 三选一都缺 0.1。
6. **JSON 输出**: 仍按现有 schema (outputs[]), 严禁 markdown 代码块包裹。
`;

// === 2. 产出后 post-processing 验证 (供 reject-重试 / reject-丢弃) ===

export interface ProductField {
  title?: string | null;
  content?: string | null;
  /** knowledge 的可选 statement / memory 的可选 title 等同义字段 */
  description?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
  /** 仅用于日志的可读摘要, 不参与 OK 判断 */
  hasMarkdown: boolean;
  hasV3Signal: boolean;
  isEvasive: boolean;
}

/**
 * 逃避式正则 — 与 scripts/check-product-format.cjs 保持一致 (单一来源, 改这里就改那里)。
 * 注: 平台已有 scripts/check-product-format.cjs 的 EVASIVE_PATTERNS, 本模块固化相同口径便于
 * 离线 (无 DB) 校验。复算命令: `node scripts/check-product-format.cjs`。
 */
const EVASIVE_PATTERNS: RegExp[] = [
  /对话[提暗]到/,
  /对话[中里]/,
  /未[明记]录/,
  /无对[应象][库知]识[记]?录?/,
  /未明[确确][定记][义录]/,
  /需[调要]研[究究]/,
  /后[续续]补[充充]/,
  /暂[无时]记[录录]/,
  /无法[判确][定认]/,
  /覆盖[度率]未[达标到]?/,
];
const EVASIVE_RE = new RegExp(EVASIVE_PATTERNS.map((p) => p.source).join("|"));

const MARKDOWN_RE = /(^|\n)#{1,6}\s|^[-*]\s|^\d+\.\s|\*\*[^*]+\*\*/;

const V3_SIGNAL_RE =
  /(必须|应该|不要|避免|确保|务必|禁止|一定|不能|需要|教训|经验|原则|模式|规律|发现|导致|因为|所以|根因|原因|\b(npm|pnpm|yarn|git|curl|sqlite3|tsx|node|bash|cron|tRPC|API|MCP|Prisma|SQLite|HTTP)\b|[\/\\]\w+\/\w+|\d{2,})/i;

/**
 * 验证单条产物是否满足 V3 五件套硬约束。
 *
 * 字段名约定 (兼容三类产物):
 *   - knowledge: { title, content }
 *   - memory:    { content } (title 可选)
 *   - practice:  { title, description }
 *   - reflection:{ title, description }
 *
 * 返回 ok=false 时, reasons 数组会列出具体哪些维度不合规, 调用方据此决定 reject 重试 / 丢弃。
 */
/**
 * 2026-09-29 (agent-d 休假期间) V3 title 规范化 —— 单一来源。
 *
 * 为什么需要 (实测根因):
 *   scripts/check-product-format.cjs 报 24h FLYWHEEL_STRUCTURED Knowledge 有 72.7% title > 30 字,
 *   而 V3 五件套硬约束 (本文件 V3_FIVE_PIECE_HARD_RULES 第 1 条) 要求 title 4–30 字。
 *   prompt 层面早已写明, 但**写入侧的代码**才是决定性的一环 —— 实测 execute-improving-task.ts 里
 *     const knowTitle = (finding.what || "").slice(0, 120);
 *   直接给了 120 字上限, 与 prompt 的 30 字约束**互相矛盾**; LLM 就算守规矩, 代码也不会裁。
 *   同类还有 practice 的 pracTitle (同样 slice(0,120))。
 *   即: "prompt 说 ≤30, 代码允许 ≤120" —— 契约在写入侧被放宽, 守门自然长期红。
 *
 * 用法: 所有落 Knowledge/Practice/Reflection title 的地方都应过本函数。
 *   注意: 截断会**丢失 what 的后半段**, 故调用方应把完整 what 放进 content
 *   (见 execute-improving-task.ts 的 knowContent 组装), 而不是直接丢。
 */
export function normalizeFlywheelTitle(raw: unknown, maxTitle = 30): string {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= maxTitle) return t;
  return t.slice(0, maxTitle);
}

export function validateFlywheelProduct(
  product: ProductField,
  opts?: { kind?: "knowledge" | "memory" | "practice" | "reflection" | "skill"; maxTitle?: number }
): ValidationResult {
  const reasons: string[] = [];
  const kind = opts?.kind || "knowledge";
  const maxTitle = opts?.maxTitle ?? 30;

  // 取主文本 (content > description)
  const title = (product.title || "").trim();
  const content = ((product.content || product.description || "") as string).trim();

  // 1. title 长度 (2026-09-29 round 14 修: 原 if (kind !== "memory") 跳过 memory title 检查,
  //    是 design bug —— 结构化产线产 memory 也带 title, 不应豁免。空 title 仍允许 (length=0 -> 非 0 < 4 不命中))
  if (title.length > 0 && title.length < 4) reasons.push(`title 过短 (${title.length}字, 必须 ≥4)`);
  if (title.length > maxTitle) reasons.push(`title 超长 (${title.length}字, 必须 ≤${maxTitle})`);

  // 2. content 长度下限 (与 validateExtractedData 一致 ≥30; Reflection ≥10)
  const minContent = kind === "reflection" ? 10 : 30;
  if (content.length < minContent) {
    reasons.push(`content 过短 (${content.length}字, 必须 ≥${minContent})`);
  }

  // 3. markdown 结构
  const hasMarkdown = MARKDOWN_RE.test(content);
  // 2026-10-10 (practice cmv23vi4m00b1j6h59s 遗留 "反思结果尚未产出"):
  //   reflection 的 LLM JSON 契约是 {title, description, lesson} (见 global-organizer.ts
  //   llmSynthesize 模板), **没有承载 markdown 的 content 字段**; 写入侧却把
  //   description/lesson 当 content 硬卡 markdown 结构。实测真库最近 500 条
  //   sourceType=GLOBAL_ORGANIZER 的历史反思 500/500 (100%) 全挂在这一条
  //   (复算: packages/apps/mind/scripts/probe-reflection-format-gate.ts), 直接后果是
  //   每日反思 100% 被静默丢弃 (taskId=go-1791042673890-eapfxy: 291R -> 0 入库)。
  //   -> reflection 的 markdown 降级为软信号 (hasMarkdown 仍返回, 只是不入 reasons);
  //      title 长度 / content 下限 / V3 三选一 / 逃避式 仍是硬闸, 垃圾反思不会被放进来。
  if (kind !== "reflection" && content.length >= minContent && !hasMarkdown) {
    reasons.push("无 markdown 结构 (必须含 ##标题 / -bullet / **加粗** / `代码` 任一)");
  }

  // 4. V3 五件套三选一
  const hasV3Signal = V3_SIGNAL_RE.test(content);
  if (content.length >= minContent && !hasV3Signal) {
    reasons.push("未命中 V3 五件套三选一 (决策规则 / 经验根因 / 可复现具体性 任一)");
  }

  // 5. 逃避式条目
  const isEvasive = EVASIVE_RE.test(content);
  if (isEvasive && content.length >= minContent) {
    reasons.push("逃避式条目 (引用对话但无对应 Knowledge/Practice; 应跳过不写而非凑占位)");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    hasMarkdown,
    hasV3Signal,
    isEvasive,
  };
}

/**
 * 批量验证一组产物, 返回不合格项 (含 reasons)。
 * 供调用方在 reject 重试时知道哪些条目需要修。
 */
export function validateFlywheelProducts(
  products: ProductField[],
  kind: "knowledge" | "memory" | "practice" | "reflection" | "skill" = "knowledge"
): { valid: ProductField[]; rejected: Array<{ product: ProductField; reasons: string[] }> } {
  const valid: ProductField[] = [];
  const rejected: Array<{ product: ProductField; reasons: string[] }> = [];
  for (const p of products) {
    const r = validateFlywheelProduct(p, { kind });
    if (r.ok) valid.push(p);
    else rejected.push({ product: p, reasons: r.reasons });
  }
  return { valid, rejected };
}