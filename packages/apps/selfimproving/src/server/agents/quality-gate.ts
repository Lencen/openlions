/**
 * Quality Gate for Task Execution
 *
 * Evaluates whether an execution output meets minimum quality thresholds.
 * Enhanced version with:
 * - Dynamic thresholds based on task type
 * - Output substance analysis
 * - Generic template detection
 * - File path presence check
 */

export interface QualityGateInput {
  output: string;
  thoughtProcess: string | null;
  status: string;
  taskType?: "CODE_IMPLEMENTATION" | "DOCUMENTATION" | "ANALYSIS" | "GENERAL";
  projectPath?: string;
}

export interface QualityGateResult {
  passed: boolean;
  reasons: string[];
  retryRecommended: boolean;
  // Enhanced fields
  outputSubstance: "HIGH" | "MEDIUM" | "LOW";
  hasFilePaths: boolean;
  isGenericTemplate: boolean;
  dynamicThreshold: number;
  substanceScore: number; // 0-100
}

// Dynamic thresholds based on task type
const DYNAMIC_THRESHOLDS: Record<string, { minLength: number; substanceWeight: number }> = {
  CODE_IMPLEMENTATION: { minLength: 500, substanceWeight: 0.7 },
  DOCUMENTATION: { minLength: 300, substanceWeight: 0.6 },
  ANALYSIS: { minLength: 200, substanceWeight: 0.5 },
  GENERAL: { minLength: 100, substanceWeight: 0.4 },
};

const DEFAULT_THRESHOLD = DYNAMIC_THRESHOLDS["GENERAL"];

const MIN_THOUGHT_PROCESS_LENGTH = 50;

/**
 * Detect if output is a generic template (placeholder content)
 */
function detectGenericTemplate(output: string): { isTemplate: boolean; reason?: string } {
  const genericIndicators = [
    /通用/g, /模板/g, /示例/g, /示例代码/g, /样例/g,
    /placeholder/gi, /todo/gi, /此处应/g, /TODO/g,
    /此处省略/g, /此处待/g, /[待补充]/g, /\[.*\]/g,
  ];

  const projectSpecificIndicators = [
    /src\//, /\.tsx?/, /\.py\b/, /package\.json/,
    /\w{2,}\.ts/, /\w{2,}\.js/, /components\//, /utils\//,
    /import\s+.*from\s+['"]/, /const\s+\w+\s*=/,
  ];

  // Check for generic indicators
  const hasGenericIndicators = genericIndicators.some((pattern) => pattern.test(output));
  const hasProjectSpecific = projectSpecificIndicators.some((pattern) => pattern.test(output));

  // If has generic indicators but no project-specific content, likely a template
  if (hasGenericIndicators && !hasProjectSpecific) {
    return { isTemplate: true, reason: "包含通用模板指示词且无具体项目路径" };
  }

  // Check for placeholder-heavy content
  const placeholderDensity = (output.match(/\[.*\]|\{.*\}|此处.{0,20}/g) || []).length;
  const totalWords = output.split(/\s+/).length;
  if (totalWords > 50 && placeholderDensity / totalWords > 0.1) {
    return { isTemplate: true, reason: "占位符密度过高" };
  }

  return { isTemplate: false };
}

/**
 * Check if output contains file paths (for verification of deliverable location)
 */
function hasFilePaths(output: string): boolean {
  const pathPatterns = [
    /src\/[\w\/\.-]+/, // src/...
    /docs\/[\w\/\.-]+/, // docs/...
    /[\w\/\.-]+\.(tsx?|jsx?|py|java|go)/, // file extensions
    /\/[\w\/\.-]+\/[\w\/\.-]+/, // any path pattern
  ];
  return pathPatterns.some((pattern) => pattern.test(output));
}

/**
 * Calculate output substance score (0-100)
 */
function calculateSubstanceScore(output: string): { score: number; level: "HIGH" | "MEDIUM" | "LOW" } {
  const trimmed = output.trim();
  if (trimmed.length === 0) return { score: 0, level: "LOW" };

  let score = 0;

  // Length contribution (40% of score)
  const lengthScore = Math.min(40, trimmed.length / 10);
  score += lengthScore;

  // Code block contribution (30% of score)
  const codeBlocks = (trimmed.match(/```[\s\S]*?```/g) || []).length;
  const codeBlockScore = Math.min(30, codeBlocks * 10);
  score += codeBlockScore;

  // Concrete details contribution (20% of score)
  const concreteIndicators = [
    /\w+\s*=\s*\w+/, // assignments: var = value
    /function\s+\w+/, // function declarations
    /class\s+\w+/, // class declarations
    /import\s+\w+/, // imports
    /\w+\s*\(\s*\)/, // function calls
  ];
  const concreteCount = concreteIndicators.reduce((count, pattern) => {
    return count + (trimmed.match(pattern) || []).length;
  }, 0);
  const concreteScore = Math.min(20, concreteCount * 2);
  score += concreteScore;

  // No placeholder indicators (10% of score)
  const placeholderIndicators = [/TODO/g, /此处/g, /省略/g, /待/g];
  const hasPlaceholder = placeholderIndicators.some((p) => p.test(trimmed));
  if (!hasPlaceholder) score += 10;

  // Normalize to 0-100
  score = Math.min(100, Math.max(0, Math.round(score)));

  let level: "HIGH" | "MEDIUM" | "LOW";
  if (score >= 70) level = "HIGH";
  else if (score >= 40) level = "MEDIUM";
  else level = "LOW";

  return { score, level };
}

/**
 * Determine task type from output characteristics
 */
function inferTaskType(output: string): string {
  const codeBlocks = (output.match(/```[\s\S]*?```/g) || []).length;
  const docIndicators = (output.match(/#{1,3}\s+\w+|API|文档|说明|指南/g) || []).length;

  if (codeBlocks > 3) return "CODE_IMPLEMENTATION";
  if (docIndicators > 5) return "DOCUMENTATION";
  if (output.includes("分析") || output.includes("原因")) return "ANALYSIS";
  return "GENERAL";
}

/**
 * Evaluate quality gate for a task execution result.
 * Enhanced with dynamic thresholds, substance analysis, and template detection.
 */
export function evaluateQualityGate(input: QualityGateInput): QualityGateResult {
  const reasons: string[] = [];

  const outputStr = typeof input.output === "string" ? input.output : String(input.output ?? "");
  const thoughtProcessStr =
    typeof input.thoughtProcess === "string" ? input.thoughtProcess : String(input.thoughtProcess ?? "");

  // Determine task type and threshold
  const taskType = input.taskType || inferTaskType(outputStr);
  const thresholdConfig = DYNAMIC_THRESHOLDS[taskType] || DEFAULT_THRESHOLD;
  const minLength = thresholdConfig.minLength;

  // 1. Length check with dynamic threshold
  if (outputStr.trim().length < minLength) {
    reasons.push(
      `Output too short: ${outputStr.trim().length} < ${minLength} chars (${taskType} requires ${minLength})`
    );
  }

  // 2. Thought process length check
  if (thoughtProcessStr.trim().length < MIN_THOUGHT_PROCESS_LENGTH) {
    reasons.push(
      `Thought process too short: ${thoughtProcessStr.trim().length} < ${MIN_THOUGHT_PROCESS_LENGTH} chars`
    );
  }

  // 3. Blocked status check
  if (input.status === "BLOCKED") {
    reasons.push("Execution was blocked — cannot pass quality gate");
  }

  // 4. Generic template detection
  const templateCheck = detectGenericTemplate(outputStr);
  const isGenericTemplate = templateCheck.isTemplate;
  if (isGenericTemplate) {
    reasons.push(`Generic template detected: ${templateCheck.reason || "无具体项目上下文"}`);
  }

  // 5. Output substance analysis
  const { score: substanceScore, level: outputSubstance } = calculateSubstanceScore(outputStr);
  if (substanceScore < 30) {
    reasons.push(`Output substance too low: ${substanceScore}/100 (likely placeholder/framework content)`);
  }

  // 6. File path presence check
  const hasPaths = hasFilePaths(outputStr);
  if (!hasPaths && outputStr.length > 300) {
    // Only require paths for substantial outputs
    reasons.push("Output lacks file paths — deliverable location not specified");
  }

  const passed = reasons.length === 0;

  return {
    passed,
    reasons,
    retryRecommended: !passed && input.status !== "BLOCKED",
    outputSubstance,
    hasFilePaths: hasPaths,
    isGenericTemplate,
    dynamicThreshold: minLength,
    substanceScore,
  };
}