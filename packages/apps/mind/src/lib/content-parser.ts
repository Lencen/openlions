/**
 * parseContent - 解析 Memory/Knowledge 的 content 字段
 * 兼容旧自由文本和新结构化 JSON
 *
 * 旧格式: content = "一段自由文本"
 * 新格式: content = JSON.stringify({ summary, claim, reasoning, evidence, ... })
 *
 * 返回: { summary, structured, legacy }
 * - legacy=true: 旧格式, summary=原文, structured=null
 * - legacy=false: 新格式, summary=结构化摘要, structured=解析后的对象
 */

export interface ParsedContent {
  summary: string;
  structured: Record<string, any> | null;
  legacy: boolean;
}

export function parseContent(content: string): ParsedContent {
  if (!content) {
    return { summary: "", structured: null, legacy: true };
  }

  // 尝试 JSON.parse
  try {
    const parsed = JSON.parse(content);
    // 判断是否是结构化格式 (有 summary 或 claim 字段)
    if (parsed && typeof parsed === "object" && (parsed.summary || parsed.claim || parsed.statement)) {
      return {
        summary: parsed.summary || parsed.claim || parsed.statement || "",
        structured: parsed,
        legacy: false,
      };
    }
    // 是 JSON 但不是结构化格式, 当自由文本处理
    return {
      summary: typeof parsed === "string" ? parsed : content,
      structured: null,
      legacy: true,
    };
  } catch {
    // JSON.parse 失败, 是纯文本
    return {
      summary: content,
      structured: null,
      legacy: true,
    };
  }
}

/**
 * 质量分计算 - Memory
 * confidence 不由 LLM 自评, 改为程序计算
 */
export function calcMemoryQuality(structured: Record<string, any> | null, sourceId?: string | null): { qualityScore: number; confidence: number } {
  if (!structured) return { qualityScore: 0, confidence: 0.4 };

  let score = 0;
  // 有 evidence -> +0.2
  if (structured.evidence && Array.isArray(structured.evidence) && structured.evidence.length > 0) score += 0.2;
  // 有 reasoning -> +0.2
  if (structured.reasoning) score += 0.2;
  // 有 scope -> +0.1
  if (structured.scope) score += 0.1;
  // verifiable && verifiedAt -> +0.3
  if (structured.verifiable && structured.verifiedAt) score += 0.3;
  // confidence >= 0.8 -> +0.2 (用程序计算的 confidence)
  const evidenceCount = Array.isArray(structured.evidence) ? structured.evidence.length : 0;
  const confidence = Math.min(1, 0.4 + 0.2 * evidenceCount + (sourceId ? 0.2 : 0));
  if (confidence >= 0.8) score += 0.2;

  return { qualityScore: Math.min(1, score), confidence };
}

/**
 * 质量分计算 - Knowledge
 */
export function calcKnowledgeQuality(structured: Record<string, any> | null): number {
  if (!structured) return 0;

  let score = 0;
  if (structured.statement && structured.prerequisites) score += 0.2;
  if (structured.counterexample) score += 0.2;
  if (structured.verification) score += 0.2;
  if (structured.evidence && Array.isArray(structured.evidence) && structured.evidence.length > 0) score += 0.2;
  if (structured.staleCheck) score += 0.2;

  return Math.min(1, score);
}

/**
 * 质量分计算 - Skill
 */
export function calcSkillQuality(structured: Record<string, any> | null): number {
  if (!structured) return 0;

  let score = 0;
  if (structured.trigger) score += 0.2;
  if (structured.steps && Array.isArray(structured.steps) && structured.steps.length > 0) score += 0.2;
  if (structured.pitfalls && Array.isArray(structured.pitfalls) && structured.pitfalls.length > 0) score += 0.3;
  if (structured.verification) score += 0.2;
  if (structured.relatedSkills && Array.isArray(structured.relatedSkills) && structured.relatedSkills.length > 0) score += 0.1;

  return Math.min(1, score);
}

/**
 * 质量分 -> tier 映射
 */
export function qualityToTier(qualityScore: number): string {
  if (qualityScore >= 0.7) return "HOT";
  if (qualityScore >= 0.4) return "WARM";
  return "COLD";
}
