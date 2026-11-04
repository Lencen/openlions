/**
 * MiniMax Message Response Parser
 *
 * MiniMax returns message content as an array of blocks with different types:
 * - { type: "thinking", thinking: "..." } — internal reasoning trace
 * - { type: "text", text: "..." } — visible output text
 *
 * Previously the code read content[0].text which would be empty for thinking blocks.
 */

export interface ParsedMessage {
  thoughtProcess: string;
  output: string;
  rawText: string;
}

/**
 * Parse MiniMax message content array into thoughtProcess and output.
 */
export function parseMiniMaxMessage(
  content?: Array<{ type?: string; text?: string; thinking?: string }>
): ParsedMessage {
  if (!content || content.length === 0) {
    return { thoughtProcess: "", output: "", rawText: "" };
  }

  const thoughtProcess = content
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking ?? "")
    .filter(Boolean)
    .join("\n\n");

  const textBlocks = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .filter(Boolean)
    .join("\n\n");

  return {
    thoughtProcess,
    output: textBlocks,
    rawText: textBlocks,
  };
}

/**
 * Extract JSON object from a response string that may contain explanatory text
 * before/after the JSON. Tries each { position and returns the first valid JSON.
 */
export function extractJsonFromResponse(text: string): Record<string, unknown> | null {
  const startIdx = text.indexOf("{");
  if (startIdx === -1) return null;

  // Try parsing from each { position — return first valid JSON
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const slice = text.slice(i);
    // Try to find a balanced closing brace
    let depth = 0;
    let endIdx = -1;
    for (let j = 0; j < slice.length; j++) {
      if (slice[j] === "{") depth++;
      else if (slice[j] === "}") {
        depth--;
        if (depth === 0) {
          endIdx = j;
          break;
        }
      }
    }
    if (endIdx === -1) break;
    const candidate = slice.slice(0, endIdx + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Not valid JSON, continue to next {
    }
  }
  return null;
}