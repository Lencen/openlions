/**
 * llm-observability.ts — LLM 调用观测打点 (P1-C 2026-08-31)
 *
 * 背景 (P0-FLYWHEEL-IDLE-CALLS 文档 BUG-6):
 *   FlywheelEvent stage 只有 MEMORIZE/EVALUATE/REFLECT 等, 看不到 LLM 调用层
 *   → 空转/烧额度无法从事件流观测
 *
 * 本模块: 每次 LLM 调用落一条 FlywheelEvent
 *   stage       = "CALL_LLM"
 *   sourceType  = 入口 (main-extract / reflect / structured / improving-tasks)
 *   sourceId    = durationMs
 *   sourceTitle = 输入 token 估算 (tok≈N)
 *   targetStage = "OK" | "FAIL:<errorType>"
 *
 * 查询示例:
 *   SELECT sourceType, targetStage, COUNT(*) FROM FlywheelEvent
 *   WHERE stage='CALL_LLM' AND createdAt > ... GROUP BY sourceType, targetStage;
 */
import { prisma } from "@/lib/prisma";

export interface LlmCallObs {
  entry: string;            // 入口标识
  ok: boolean;
  durationMs: number;
  errorType?: string;
  tokenEstimate?: number;   // 输入 token 估算
  tokenUsed?: number;       // 2026-09-01: 真实 usage token (input+output, 从 API 响应)
  promptLength?: number;    // prompt 字符数
  model?: string;           // 2026-09-10: 模型名(归因"钱花在哪个模型"), 不传则按入口路由推定
  agentId?: string;         // 2026-09-10: 归因主体; 平台侧调用默认 "platform:<entry>"
}

/**
 * 2026-09-10: 模型归因。事件里原本没有 model 字段, 导致成本看板只能"推定"。
 * 这里按入口路由集中解析(与 .env.local 的模型配置同源), 调用点若显式传 model 则以调用点为准。
 */
function modelForEntry(entry: string): string {
  const e = (entry || "").toLowerCase();
  if (e.startsWith("reflect")) return process.env.REFLECT_MODEL || process.env.ANTHROPIC_MODEL || "unknown";
  if (e.startsWith("structured")) return process.env.STRUCTURED_MODEL || process.env.ANTHROPIC_MODEL || "unknown";
  return process.env.ANTHROPIC_MODEL || "unknown";
}

/**
 * 2026-09-11 (任务 cmtvfgjtg001e1j76o2f813wz 的诚实补完): "估算 token"这一列此前**没有生产者** ——
 *   实测近 24h 1029 次调用里 428 次有实测 tok=, **0 次** tok≈, 601 次只有 chars≈(其中 598 来自 session-extract)。
 *   即"估算"字段建好了但没人填, 成本页那一列永远为空。这里补上真正的估算器(用 tokenizer, 不是拍脑袋比例)。
 */
let _enc: any = null;
function tokenEncoder(): any {
  if (_enc !== null) return _enc;
  try {
    // js-tiktoken 已在依赖里(pure JS, 无需下载 BPE 文件)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: any = require("js-tiktoken");
    _enc = mod.getEncoding ? mod.getEncoding("cl100k_base") : mod.encodingForModel ? mod.encodingForModel("gpt-4o") : false;
  } catch { _enc = false; }
  return _enc;
}

/** 文本 -> token 估算。优先用 tokenizer; 不可用时回退到经验比并**在返回值上体现**为更粗的估算。 */
export function estimateTokens(text: string): number {
  const t = String(text || "");
  if (!t) return 0;
  const enc = tokenEncoder();
  if (enc && typeof enc.encode === "function") {
    try { return enc.encode(t).length; } catch { /* 回退 */ }
  }
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk + (t.length - cjk) / 4);
}

/** 是否用上了真 tokenizer(供调用点/自检区分"tokenizer 估算"与"经验比估算") */
export function tokenizerAvailable(): boolean {
  const enc = tokenEncoder();
  return !!(enc && typeof enc.encode === "function");
}

export async function recordLlmCall(obs: LlmCallObs): Promise<void> {
  try {
    await prisma.flywheelEvent.create({
      data: {
        stage: "CALL_LLM",
        // 2026-09-10 归因: 平台侧调用记为 platform:<entry>; agent 自报用量走 submit 路由记 agent:<id>
        sourceType: obs.agentId ? obs.agentId : "platform:" + obs.entry,
        sourceId: String(obs.durationMs),
        // 2026-09-01 增强: 记录真实 usage token (input+output) 替代估算
        //   MiniMax 后台按次数计费不展示 token, 平台侧自记实际消耗
        // 2026-09-10: 追加 model 字段(成本页可按模型聚合, 不再"推定"); 保持 tok=/tok≈/chars≈ 前缀不变以兼容既有解析
        sourceTitle:
          (obs.tokenUsed
            ? `tok=${obs.tokenUsed}`
            : obs.tokenEstimate
              ? `tok≈${obs.tokenEstimate}`
              : obs.promptLength
                ? `chars≈${obs.promptLength}`
                : "") + ` model=${obs.model || modelForEntry(obs.entry)} entry=${obs.entry}`,
        targetStage: obs.ok ? "OK" : `FAIL:${obs.errorType || "UNKNOWN"}`,
      },
    });
  } catch (e) {
    // 观测打点失败不影响主流程
    console.warn(`[llm-obs] record failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
}
