/**
 * 质量分天平的单一来源 (2026-10-08 round 56a, 从 db-writer 搬过来, 行为零变化).
 * 任何新增维度/换公式只改这里, 漂移守门 spec:calc-quality-source 静态扫描兜底.
 */
export const STANDARD_THEMES = new Set([
  "任务管理","环境配置","数据管理","功能验证","进程管理","API认证",
  "错误处理","并发安全","文档管理","Pipeline","路由切换","路由管理",
  "端口管理","硬件迁移","数据同步","字段映射","飞轮闭环","飞轮链路",
  "飞轮空转","飞轮架构","项目结构","项目架构","问题解决","验证流程",
  "验收标准","链路诊断","其他",
]);

// 标准 Skill level
export const STANDARD_LEVELS = new Set([
  "AWARENESS","BEGINNER","INTERMEDIATE","ADVANCED","EXPERT","PROFICIENT",
]);

// Memory: 核心维度 = 决策性 + 经验性
export function calcMemoryQuality(p: {
  content: string; title?: string | null; theme?: string | null;
  tags?: string | null; valueScore?: number | null; reinforceCount?: number;
}): number {
  let s = 0;
  const { content, title, theme, tags, valueScore: vs, reinforceCount: rc } = p;
  if (!content) return 0;
  // 决策性: 有"必须/应该/不要/避免/确保"等决策词 +0.3
  if (/(必须|应该|不要|避免|确保|务必|禁止|一定|不能|需要)/.test(content)) s += 0.3;
  // 经验性: 有"教训/经验/原则/模式/规律/发现/导致"等经验词 +0.2
  if (/(教训|经验|原则|模式|规律|发现|导致|因为|所以|根因|原因是)/.test(content)) s += 0.2;
  // 具体性: 命令/路径/参数/数字 (降权) +0.2
  if (/\b(npm|pnpm|yarn|git|curl|sqlite3|tsx|node|bash|cron|tRPC|API|MCP|Prisma|SQLite|HTTP)\b|[\/\\]\w+\/\w+|\d{2,}/i.test(content)) s += 0.2;
  // 价值分 (LLM 自评) +0.2
  const vc = vs ?? 0;
  if (vc > 0.7) s += 0.2; else if (vc > 0.5) s += 0.1;
  // 强化度 +0.1
  if ((rc ?? 0) > 0) s += 0.1;
  // JSON dump 惩罚 -0.3 (原始 JSON 不是记忆)
  if (/^\s*\{/.test(content) && /"summary"|"status"|"data"/.test(content)) s -= 0.3;
  return Math.max(0, Math.min(s, 1.0));
}

// Knowledge: 核心维度 = 准确性 + 完整性
export function calcKnowledgeQuality(p: {
  content: string; title?: string | null; category?: string | null;
  tags?: string | null; confidence?: number | null; reinforceCount?: number;
}): number {
  let s = 0;
  const { content, title, category, tags, confidence: cf, reinforceCount: rc } = p;
  if (!content) return 0;
  // 准确性: confidence (LLM 自评) (P2-4: 自评偏高, 加权降权 - 只奖励高confidence)
  const vc = cf ?? 0;
  if (vc >= 0.9) s += 0.2;
  else if (vc > 0.7) s += 0.15;
  else if (vc > 0.5) s += 0.1;
  else if (vc > 0) s += 0.05;
  // P2-4: 长度门槛 - content < 30 字直接降分
  if (content.length < 30) s -= 0.2;
  if (content.length >= 100) s += 0.1;
  // 完整性: title + content 都有且 content > 30 字 +0.2
  if (title && title.length >= 4 && content.length > 30) s += 0.2;
  // 结构化: 有 category + tags +0.2
  if (category) s += 0.1;
  if (tags && tags.trim().length > 0) s += 0.1;
  // 具体性: 技术术语/命令/路径 +0.2
  if (/\b(npm|pnpm|git|curl|tsx|node|tRPC|API|MCP|Prisma|SQLite|HTTP|React|Vue|Next)\b|[\/\\]\w+\/\w+|\d{2,}/i.test(content)) s += 0.2;
  // 强化度 +0.1
  if ((rc ?? 0) > 0) s += 0.1;
  return Math.min(s, 1.0);
}

// Reflection: 核心维度 = 可执行性
export function calcReflectionQuality(p: {
  content: string; title?: string | null; theme?: string | null;
  priority?: string | null; actionType?: string | null; lesson?: string | null;
}): number {
  let s = 0;
  const { content, title, theme, priority, actionType: at, lesson } = p;
  if (!content && !title) return 0;
  // 可执行性: actionType 非 NONE 且非空 +0.4 (最重要)
  if (at && at !== "NONE" && at !== "") s += 0.4;
  // 具体性: lesson/improvements 有具体内容 +0.2
  if (lesson && lesson.length > 20) s += 0.2;
  else if (content && content.length > 30) s += 0.1;
  // 优先级: P1 +0.3, P2 +0.2, P3 +0.1
  if (priority === "P1") s += 0.3;
  else if (priority === "P2") s += 0.2;
  else if (priority === "P3") s += 0.1;
  // 主题归一化: theme 是标准主题 +0.1
  if (theme && STANDARD_THEMES.has(theme)) s += 0.1;
  return Math.min(s, 1.0);
}

// Practice: 核心维度 = 可重复性 + 结果明确
export function calcPracticeQuality(p: {
  content: string; title?: string | null; theme?: string | null;
  type2?: string | null; outcome?: string | null; difficulty?: number | null;
}): number {
  let s = 0;
  const { content, title, theme, type2, outcome, difficulty } = p;
  if (!content && !title) return 0;
  // 结果明确: outcome 有值 (P2-3: FAILED/PARTIAL 加权, SUCCESS 降权 - 失败经验更有价值)
  if (outcome === "FAILED") s += 0.35;
  else if (outcome === "PARTIAL") s += 0.3;
  else if (outcome === "SUCCESS") s += 0.15;
  else if (outcome) s += 0.1;
  // 可重复性: 有命令/路径/步骤 +0.3
  if (/\b(npm|pnpm|git|curl|tsx|node|bash|cron)\b|[\/\\]\w+\/\w+|--?[a-z]+=\S|\d{2,}/i.test(content || title || "")) s += 0.3;
  else if (/(步骤|流程|操作|执行|运行|启动|停止|配置)/.test(content || "")) s += 0.2;
  // 类型明确: type2 有值 +0.2
  if (type2 && ["FEATURE","BUGFIX","REFACTOR","INTEGRATION","OTHER"].includes(type2)) s += 0.2;
  // 复杂度: difficulty 有值 +0.2
  if (difficulty != null && difficulty > 0) s += 0.2;
  // P1-2: 长度门槛 - 描述太短降分 (2026-08-27 fix: 原引用未定义变量 desc, 恒为 undefined -> 恒 -0.2; 改用 content)
  const descLen = (content || title || "").length;
  if (descLen < 20) s -= 0.2;
  return Math.min(s, 1.0);
}

// Skill: 核心维度 = 数据干净度 + SKILL-SPEC 步骤完整性 (2026-08-28 P1.5)
// 2026-08-28 修正: 旧公式只测 description 长度, 与 SKILL-SPEC (无 steps 不成 skill) 脱节,
// 且调用点漏传 level 导致新技能恒 0 分 (level undefined -> return 0)。
// 新公式: 有可执行步骤 content +0.35, trigger +0.2, verification +0.2, level 标准 +0.15, category +0.1
export function calcSkillQuality(p: {
  name?: string | null; level?: string | null; category?: string | null;
  description?: string | null; content?: string | null;
  trigger?: string | null; verification?: string | null;
}): number {
  let s = 0;
  const { level, category, description, content, trigger, verification } = p;
  // SKILL-SPEC 铁律: 无 steps 不成 skill -> content (steps) 是最高权重
  const steps = (content || "").trim();
  if (steps.length >= 20) s += 0.35;
  else if (steps.length > 0) s += 0.15;
  // 适用场景 + 验证方法 各 +0.2
  if (trigger && trigger.trim().length > 0) s += 0.2;
  if (verification && verification.trim().length > 0) s += 0.2;
  // level 标准值 +0.15 (非标准不额外加分, 但不归零 — 步骤完整性才是核心)
  if (level && STANDARD_LEVELS.has(level)) s += 0.15;
  // 分类明确 +0.1
  if (category && category.trim().length > 0) s += 0.1;
  // 描述完整性降为辅助 +0.05
  if (description && description.length > 30) s += 0.05;
  return Math.min(s, 1.0);
}

// 入口: 按 type 分发
export function calcQualityScore(params: {
  type: "memory" | "knowledge" | "reflection" | "practice" | "skill";
  content: string; title?: string | null; theme?: string | null;
  tags?: string | null; valueScore?: number | null; confidence?: number | null;
  reinforceCount?: number; priority?: string | null; actionType?: string | null;
  lesson?: string | null; category?: string | null; type2?: string | null;
  outcome?: string | null; difficulty?: number | null; level?: string | null;
  description?: string | null; name?: string | null;
  trigger?: string | null; verification?: string | null;
}): number {
  switch (params.type) {
    case "memory": return calcMemoryQuality(params);
    case "knowledge": return calcKnowledgeQuality(params);
    case "reflection": return calcReflectionQuality(params);
    case "practice": return calcPracticeQuality(params);
    case "skill": return calcSkillQuality(params);
    default: return 0;
  }
}
