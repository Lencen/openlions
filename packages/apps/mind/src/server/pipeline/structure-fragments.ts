/**
 * V1.7 structure-fragments.ts — ③.b 碎片结构化整理 (按 theme)
 * 设计: docs/lions-flywheel-v17-implementation-design.md §3
 *
 * 核心流程:
 * 1. 24h 防重入锁: FlywheelJob idempotencyKey="structured:<theme>" (status=DONE 表示跑过)
 * 2. 读某 theme 全部碎片 (memory/knowledge/practice/reflection + 反思报告)
 * 3. chunk 切分 (≤50K tokens/块, 2026-09-01 合并优化)
 * 4. 调 LLM 反向整理碎片 → N 条 V3 五件套结构化输出
 * 5. 复用 db-writer.ts 现有 runResolver() 入库 (action=CREATE/MERGE 走状态机)
 * 6. 写 FlywheelJob status=DONE (防重入锁)
 *
 * V1.7 §3.7 P0 防御: 24h 防重入锁防 V1.7 产物再被结构化的死循环
 * V1.7 §3.4 LLM 降级: LLM 调用失败 → status=FAILED, 不重试
 *
 * 不复用 db-writer.ts 主入口的原因: db-writer 是 session 级批量入口,
 * V1.7 是按 theme 反向入口 (输入语义不同), 复用其内部 runResolver() 而非主入口。
 */
import { prisma } from "../../lib/prisma";
import crypto from "node:crypto";
// P1-A 2026-08-31: 统一 fetch 封装 (原本地重复实现移除)
import { fetchWithTimeout, withLlmConcurrency } from "./with-retry";
// P1-C 2026-08-31: LLM 调用观测
import { recordLlmCall } from "./llm-observability";
// 2026-09-14 FW-QUALITY 机制修复: 产物评分/门槛收敛到单一权威入口 product-quality.ts
//   (根因: 本产线曾漏写 qualityScore, 后又把 confidence 当 valueScore 传 —— 参数漂移静默拉低 FW-QUALITY)
import { classifyStructuredOutput, MIN_PRODUCT_QUALITY } from "./product-quality";
import { markLaterDuplicateSuperseded } from "./structured-dedup";
// 2026-10-09 round 72-D3: Memory 写入改走**统一出口**(module store) —— 认知闸/受控投影挂在那里,
//   直连 prisma.memory.create 等于让闸管不到本产线(它曾是 Memory 的 95% 流量)。
import { safeCreateMemory } from "./safe-create";
import { parseJsonLoose } from "./json-repair";
// 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套硬约束 (该产线只产 knowledge/memory/practice 三类)
//   详见 flywheel-prompt-constraints.ts 顶部注释与 S1 commit 9d833c1
import { STRUCTURED_OUTPUT_HARD_RULES, validateFlywheelProduct } from "./flywheel-prompt-constraints";

// ===== 类型定义 =====
export interface StructureFragmentsInput {
  theme: string;
  lookbackDays?: number;
  chunkSize?: number;
  actor?: string;
  force?: boolean;     // 绕过 24h 防重入锁
}

export interface StructureFragmentsResult {
  theme: string;
  status: "OK" | "FAILED" | "SKIPPED";
  sessionCount: number;
  fragmentCount: number;
  outputCount: number;
  mergedCount: number;
  chunksProcessed: number;
  /** 2026-09-11 第 29 轮: 本轮失败的 chunk 序号(1-based)。部分失败时 status 仍为 OK, 用此字段让调用方
   *  能看见"哪些 chunk 没整理成功"; 全部失败时 status=FAILED 且该字段为全部序号。 */
  failedChunks?: number[];
  /** 2026-09-14 FW-QUALITY: 本轮**低于 G3 门槛**的产物数与均分。低于门槛的行仍会入库(不隐藏),
   *  但必须在此显式登记, 让"某批产物拉低 FW-QUALITY"在任务账上可见, 而不是静默发生。 */
  belowFloorCount?: number;
  belowFloorAvg?: number | null;
  // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套硬约束拒收 (格式不合规, 入库前 drop)。
  //   不重试 LLM (chunk retry cost 高), 由 prompt 提示 + 守门监控 (scripts/check-product-format.cjs) 共同降量。
  formatRejectedCount?: number;
  /** 2026-10-09 round 72-D3: LLM 未产出 summary/scenario 的条数(认知闸 enforce 的前置读数) */
  missingPurposeCount?: number;
  formatRejectReasons?: Record<string, number>;
  durationMs: number;
  summary: string;
  error?: string;
}

interface FragmentItem {
  id: string;
  type: "memory" | "knowledge" | "practice" | "reflection";
  title?: string;
  content: string;
  contentHash?: string;
  createdAt: number;
  sourceType?: string;
}

interface StructuredOutput {
  title: string;
  content: string;
  supersedes: string[];   // 这条结构化记忆取代的碎片 id 列表
  reason: string;
  /**
   * 2026-10-09 round 72-D3: 认知闸要求 Memory 有 summary|scenario 之一(人类定义:
   *   "记忆必须知道它在什么场景下有用")。本产线是 Memory 的**最大生产者**(近 7 天 1476 条,
   *   占同期 Memory 写入的 95%), 之前两条都是空 —— 于是整条产线的产物一条都过不了闸。
   *   summary = 一句话说清这条讲什么(列表页初筛用); scenario = 什么情况下该想起它。
   */
  summary?: string;
  scenario?: string;
  // 2026-09-11 第 29 轮修(实测缺陷): 与其它产线对齐 —— cognitive-extractor/db-writer/execute-improving-task
  //   都是「LLM 给 valueScore 0-1 -> 写库时 clamp -> calcQualityScore 消费 valueScore」。
  //   本产线此前传的是 confidence(那是 knowledge 分支的参数), 而 calcMemoryQuality 的签名里**没有 confidence**,
  //   于是这一维(最高 +0.2)恒定拿不到分: 实测 24h 窗口 144 条 memory 质量分只有 {0.2,0.4,0.7} 三档,
  //   minQ=0.2(只命中"具体性"), 说明分数完全由文本特征决定, 价值分维度从未接上。
  //   缺失时保持 undefined(不填常数, 避免制造虚高), 由 ingest 回落到默认 0.5。
  valueScore?: number;
}

const JOB_TYPE_STRUCTURE = "STRUCTURE_FRAGMENTS";
const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h (已结构化主题)
const LOCK_WINDOW_SHORT_MS = 1 * 60 * 60 * 1000; // 1h (未结构化主题, 首次快速重试)

// ===== 1. 24h 防重入锁 (复用 FlywheelJob 表) =====
// V1.7 §3.7 + FlywheelJob.idempotencyKey UNIQUE 约束:
//   先查 24h 内 status=DONE 的 job → 有则 SKIPPED
//   否则用 upsert (idempotencyKey="structured:<theme>") 拿/建 PROCESSING job
async function checkAndAcquireLock(
  theme: string,
  actor: string,
  force?: boolean
): Promise<{ allowed: boolean; existingJobId?: string; existingStatus?: string; lockId?: string }> {
  const idempotencyKey = `structured:${theme}`;

  if (!force) {
    // ★ 飞轮修复: 已结构化主题 24h 锁, 未结构化主题 1h 锁 (首次快速重试)
    const hasStructured = await prisma.memory.findFirst({
      where: { theme, sourceType: "FLYWHEEL_STRUCTURED" },
      select: { id: true },
    });
    // 2026-09-11 第 25 轮修(实测缺陷): 若上次结论是"碎片数=0, 无需结构化", 未结构化主题的 1h 锁会导致**每小时重试** ——
    //   实测同一 job attempts=176。而"没有碎片"在 lookback 窗口内不会自己变好, 故按 lookback 等长的冷静期(默认 7 天)处理。
    const lastJob = await prisma.flywheelJob.findFirst({
      where: { idempotencyKey },
      orderBy: { updatedAt: "desc" },
      select: { error: true },
    });
    // 2026-09-11 第 26 轮: 只有"上次是在同等或更长 lookback 下判定无碎片"时才吃长冷静期。
    //   历史行没有 lookback= 标记 -> 视为旧口径(7 天), 用短锁, 让首次长窗口能生效。
    const lastErr = String(lastJob?.error || "");
    const noFragments = lastErr.includes("碎片数=0");
    const usedLookback = (() => { const m = /lookback=(\d+)天/.exec(lastErr); return m ? Number(m[1]) : 7; })();
    const effectiveLookback = Number(process.env.STRUCTURE_FIRST_LOOKBACK_DAYS ?? 90);
    const NO_FRAG_COOLDOWN_MS = Number(process.env.STRUCTURE_NO_FRAGMENT_COOLDOWN_DAYS ?? 7) * 86400 * 1000;
    const longLockApplies = noFragments && usedLookback >= effectiveLookback;
    const lockWindow = longLockApplies ? NO_FRAG_COOLDOWN_MS : (hasStructured ? LOCK_WINDOW_MS : LOCK_WINDOW_SHORT_MS);
    const cutoff = new Date(Date.now() - lockWindow);
    const recentDone = await prisma.flywheelJob.findFirst({
      where: {
        idempotencyKey,
        status: "DONE",
        completedAt: { gte: cutoff },
      },
      orderBy: { completedAt: "desc" },
    });
    if (recentDone && recentDone.completedAt) {
      console.log(
        `[structure-fragments:V1.7] ${theme} ${lockWindow === LOCK_WINDOW_MS ? "24h" : "1h"} 内已跑过 (lockId=${recentDone.id.slice(-8)} completedAt=${recentDone.completedAt.toISOString()})`
      );
      return { allowed: false, existingJobId: recentDone.id, existingStatus: "DONE" };
    }
  }

  // upsert: 同 idempotencyKey 复用 (PROCESSING/FAILED 会被新一次覆盖成 PROCESSING, DONE 跳过见上)
  const job = await prisma.flywheelJob.upsert({
    where: { idempotencyKey },
    create: {
      jobType: JOB_TYPE_STRUCTURE,
      status: "PROCESSING",
      agentId: actor,
      priority: "P2",
      idempotencyKey,
      startedAt: new Date(),
      maxAttempts: 1,
      attempts: 1,
    },
    update: {
      // 重置 status=PROCESSING (允许 force 重跑)
      status: "PROCESSING",
      agentId: actor,
      startedAt: new Date(),
      completedAt: null,
      error: null,
      attempts: { increment: 1 },
    },
  });
  return { allowed: true, lockId: job.id };
}

async function markJobDone(lockId: string, summary: string) {
  await prisma.flywheelJob.update({
    where: { id: lockId },
    data: { status: "DONE", completedAt: new Date(), error: summary.slice(0, 500) },
  });
}

async function markJobFailed(lockId: string, error: string) {
  await prisma.flywheelJob.update({
    where: { id: lockId },
    data: { status: "FAILED", completedAt: new Date(), error: error.slice(0, 500) },
  });
}

// ===== 2. 读某 theme 全部碎片 =====
async function loadThemeFragments(theme: string, lookbackDays: number): Promise<FragmentItem[]> {
  const cutoff = new Date(Date.now() - lookbackDays * 86400 * 1000);
  const [mems, knows, practices, flywheelRefls] = await Promise.all([
    prisma.memory.findMany({
      where: { theme, createdAt: { gte: cutoff } },
      select: { id: true, title: true, content: true, contentHash: true, sourceType: true, createdAt: true },
    }),
    prisma.knowledge.findMany({
      // 2026-09-15 撤回流程: 已撤回(stale/被取代)的知识不再作为结构化归纳的输入, 否则撤回的结论会被重新合成
      where: { theme, createdAt: { gte: cutoff }, stale: false, supersededBy: null },
      select: { id: true, title: true, content: true, createdAt: true },
    }).then(rows => rows.map(r => ({ ...r, content: r.content ?? "" }))),
    prisma.practice.findMany({
      where: { theme, createdAt: { gte: cutoff } },
      select: { id: true, title: true, description: true, createdAt: true },
    }),
    // FlywheelReflection 是反思报告 (元数据), 不作为碎片输入
    Promise.resolve([]),
  ]);

  const fragments: FragmentItem[] = [];
  for (const m of mems) fragments.push({
    id: m.id, type: "memory", title: m.title ?? undefined, content: m.content,
    contentHash: m.contentHash ?? undefined, createdAt: m.createdAt.getTime(),
    sourceType: m.sourceType ?? undefined,
  });
  for (const k of knows) fragments.push({
    id: k.id, type: "knowledge", title: k.title ?? undefined, content: k.content,
    createdAt: k.createdAt.getTime(),
  });
  for (const p of practices) fragments.push({
    id: p.id, type: "practice", title: p.title ?? undefined,
    content: p.description ?? "",  // ★ P1 fix: Practice.description 可空 (schema String?), 空值给 "" 避免 TypeError
    createdAt: p.createdAt.getTime(),
  });

  // V1.7 §11 C-V1.7-1: 反思 Memory (FLYWHEEL_REFLECTION) 也在范围 — 已经是 memory 走, 自然包含
  console.log(
    `[structure-fragments:V1.7] theme="${theme}" loaded ${fragments.length} fragments ` +
    `(mem=${mems.length} know=${knows.length} practice=${practices.length})`
  );
  return fragments;
}

// ===== 3. chunk 切分 (按字符数估算 tokens, 1 token ≈ 4 字符) =====
// 2026-09-11 第 28 轮修(实测缺陷): 原来只按**输入**大小切(chunkSize*4 = 默认 200,000 字符),
//   而 LLM 的 max_tokens 只有 8192 —— 输出必须覆盖整个 chunk 里的所有碎片。
//   实测: theme='项目架构'(448 条碎片) 日志显示 chunk **1/1**(全塞一个 chunk) -> 输出被截断 ->
//   'LLM JSON parse failed: Unterminated string in JSON at position 15676' -> 整个 theme FAILED。
//   修: 追加**按碎片条数**的上限(默认 12, env STRUCTURE_MAX_FRAGS_PER_CHUNK), 让输出规模可控。
const MAX_FRAGS_PER_CHUNK = Number(process.env.STRUCTURE_MAX_FRAGS_PER_CHUNK ?? 12);

function chunkFragments(fragments: FragmentItem[], chunkSizeTokens: number, maxPerChunk = MAX_FRAGS_PER_CHUNK): FragmentItem[][] {
  const charLimit = chunkSizeTokens * 4;
  const chunks: FragmentItem[][] = [];
  let current: FragmentItem[] = [];
  let currentSize = 0;

  for (const f of fragments) {
    const fSize = (f.title?.length ?? 0) + f.content.length + 50; // 50 字节 metadata
    if ((currentSize + fSize > charLimit || current.length >= maxPerChunk) && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(f);
    currentSize += fSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ===== 4. LLM 反向整理碎片 → V3 五件套输出 =====
async function callLLMStructureFragments(
  theme: string,
  chunk: FragmentItem[]
): Promise<StructuredOutput[]> {
  // V1.7 §3.4 LLM 调用 - 跟 V1.5 reflect.ts 一致用 MiniMax/Anthropic API
  // (原代码用 SESSION_API/OPENAI_BASE_URL fallback 到 localhost:11434, 本地无 ollama -> fetch failed)
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  if (!apiKey) throw new Error("LLM API key 未配置 (ANTHROPIC_AUTH_TOKEN)");
  const MODEL = process.env.ANTHROPIC_MODEL || "MiniMax-M3";

  const prompt = buildStructurePrompt(theme, chunk);

  const t0 = Date.now();
  // P0-3 (2026-09-01): 全局并发信号量
  const resp = await withLlmConcurrency(() => fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: "你是 LIONS 飞轮引擎的结构化整理专家。把碎片反向整理为 V3 五件套, 严格按 JSON 返回。",
      messages: [{ role: "user", content: prompt }],
    }),
  }));

  if (!resp.ok) {
    recordLlmCall({ entry: "structured", ok: false, durationMs: Date.now() - t0, errorType: `HTTP_${resp.status}`, promptLength: prompt.length });
    throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  recordLlmCall({ entry: "structured", ok: true, durationMs: Date.now() - t0, promptLength: prompt.length });
  const data: any = await resp.json();
  // Anthropic API 格式: data.content[0].text (不是 data.choices[0].message.content)
  const content = data.content?.[0]?.text ?? data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 无返回内容");

  // 2026-09-11 第 29 轮诊断(实测缺陷): 畸形 JSON 的真实形态必须看原始返回才能定位, 不能靠错误信息猜。
  //   env STRUCTURE_DEBUG_RAW_DIR 指向目录时, 把每次 LLM 原始返回落盘(文件名含主题与时间戳)。
  const debugDir = process.env.STRUCTURE_DEBUG_RAW_DIR;
  if (debugDir) {
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(debugDir, { recursive: true });
      const safeTheme = encodeURIComponent(theme).replace(/%/g, "");
      fs.writeFileSync(debugDir + "/" + safeTheme + "_" + Date.now() + ".txt", content, "utf8");
    } catch { /* 诊断落盘失败不影响主流程 */ }
  }

  let parsed: any;
  try {
    // 2026-09-11 第 29 轮修(实测缺陷): 原来是裸 JSON.parse, 实测因**输出畸变**整主题失败 ——
    //   "Expected ',' or '}' after property value in JSON at position 194"(位置很靠前, 属格式错误而非截断;
    //   常见成因: 字符串里未转义的换行 / 智能引号 / 尾逗号)。
    //   改为走 parseJsonLoose(先直接 parse, 失败则 repairJson 后再 parse; 修复逻辑与 global-organizer 同源)。
    parsed = parseJsonLoose(content);
  } catch (e: any) {
    throw new Error(`LLM JSON parse failed: ${e.message}, content="${content.slice(0, 200)}"`);
  }

  // 校验输出
  if (!parsed.outputs || !Array.isArray(parsed.outputs)) {
    throw new Error(`LLM 输出无 outputs[]: keys=${Object.keys(parsed)}`);
  }
  const outputs: StructuredOutput[] = [];
  for (const o of parsed.outputs) {
    if (!o.title || !o.content) continue;
    // valueScore: 与 cognitive-extractor 同口径 —— clamp 到 [0,1]; 非数字/缺失 -> undefined(回落默认值)
    const rawVs = Number((o as any).valueScore);
    outputs.push({
      title: String(o.title).slice(0, 200),
      content: String(o.content).slice(0, 5000),
      supersedes: Array.isArray(o.supersedes) ? o.supersedes.map((s: any) => String(s)) : [],
      reason: String(o.reason ?? "碎片反向整理").slice(0, 500),
      // round 72-D3: 两个新字段原样透传(缺失就是 undefined, **不编造**) ——
      //   编造出来的 summary 会让"完备性"变成形式主义, 而我们要的是能用来初筛的摘要。
      summary: o.summary ? String(o.summary).trim().slice(0, 200) : undefined,
      scenario: o.scenario ? String(o.scenario).trim().slice(0, 300) : undefined,
      valueScore: Number.isFinite(rawVs) ? Math.min(1, Math.max(0, rawVs)) : undefined,
    });
  }
  return outputs;
}

function buildStructurePrompt(theme: string, chunk: FragmentItem[]): string {
  const fragmentLines = chunk.map((f, i) => {
    const tag = `[${i + 1}/${chunk.length}] type=${f.type} id=${f.id} title="${f.title ?? ""}"`;
    return `${tag}\n${f.content}`;
  }).join("\n\n---\n\n");

  return `主题: ${theme}

下面是 ${chunk.length} 条该主题的碎片 (memory/knowledge/practice 混合):
${fragmentLines}

请反向整理这些碎片, 输出 1-5 条 V3 五件套结构化记忆。要求:
1. 合并重复/矛盾的碎片为 1 条精炼结构化记忆
2. 标记 supersedes[] 列出被这条结构化记忆取代的碎片 id (用上面 [N/M] 中的 id 字段)
3. 每条 title 简明 (≤30 字), content 完整 (≤500 字)
4. reason 简述合并理由
5. valueScore: 0-1, 该条的**复用/决策价值**自评 (越具体可执行越高)。
   判据: 含明确取舍或"必须/不要/优先"等决策规则 -> 0.7 以上; 只复述现象 -> 0.3 以下。
6. 【2026-09-14 FW-QUALITY 质量要求, 不满足会被 G3 门槛标记】content 不能只是复述现象/罗列事实, 必须至少包含:
   - 一条**可执行的决策规则**(用"必须/不要/优先/应/避免"等词) 或
   - 一条**经验/根因**(用"因为/所以/根因/教训/导致"等词) 或
   - **可复现的具体性**(命令/路径/参数/数字, 如 pnpm test、/api/v1/... 、阈值 6000)。
   三者至少命中其一; 三条都缺的条目会被计入 belowFloor 并拉低 FW-QUALITY。

7. 【2026-10-09 round 72-D3 必填】每条还要给两个**用途字段**(缺了这条记忆就"不知道什么时候该用"):
   - summary: ≤60 字, 一句话说清"这条讲的是什么"(别人只看它就要能决定要不要展开看 content);
   - scenario: ≤80 字, 说清"什么情况下该想起它"(触发条件/适用场景), 不要写"适用于各种情况"这种空话。

严格按以下 JSON 格式返回:
{
  "outputs": [
    {
      "title": "...",
      "summary": "一句话摘要(≤60字)",
      "scenario": "什么情况下该想起它(≤80字)",
      "content": "...",
      "supersedes": ["id1", "id2"],
      "reason": "...",
      "valueScore": 0.8
    }
  ]
}

${STRUCTURED_OUTPUT_HARD_RULES}
`;
}

// ===== 5. 入库 V3 五件套 + 标记 supersededBy =====
async function ingestStructuredOutputs(
  theme: string,
  outputs: StructuredOutput[],
  actor: string,
  chunk: FragmentItem[] = []
): Promise<{ created: number; merged: number; belowFloor: number; belowFloorScores: number[]; formatRejected: number; formatRejectReasons: Record<string, number>; missingPurpose: number }> {
  let created = 0;
  /** 2026-10-09 round 72-D3: LLM 没给 summary/scenario 的条数(切 enforce 的前置读数) */
  let missingPurpose = 0;
  let merged = 0;
  let belowFloor = 0;
  const belowFloorScores: number[] = [];
  // 2026-09-29 todo_0aa1ea6d28a049fba44d: post-processing 软验证 (格式合规拒绝入产物池)
  //   不重试 LLM (chunk 重试代价高, 96.7% 现状下会整主题失败), 仅 drop 不合规条目 + 记录原因。
  //   prompt 已在 buildStructurePrompt 末尾告知硬约束, LLM 大部分会自调; 守门监控
  //   scripts/check-product-format.cjs 持续观测降量, 7 日观察期 (与待办原意一致)。
  let formatRejected = 0;
  const formatRejectReasons: Record<string, number> = {};

  for (const o of outputs) {
    // 软验证: title/content 必含 + markdown 结构 + V3 五件套三选一 + 非逃避式
    // 该产线不写 Knowledge 表, 输出走 FLYWHEEL_STRUCTURED Memory/Practice, validateFlywheelProduct 通用
    const val = validateFlywheelProduct(
      { title: o.title, content: o.content },
      { kind: "memory" /* FLYWHEEL_STRUCTURED Memory */, maxTitle: 30 }
    );
    if (!val.ok) {
      formatRejected++;
      for (const r of val.reasons) {
        formatRejectReasons[r] = (formatRejectReasons[r] || 0) + 1;
      }
      console.log(
        `[structure-fragments:V1.7] format-rejected title="${o.title.slice(0, 30)}": ${val.reasons.join("; ")}`
      );
      continue;
    }
    const contentHash = crypto.createHash("sha256").update(o.content).digest("hex");

    // contentHash 去重 (V3 五件套第 1 道防护): 已有同 hash 的 FLYWHEEL_STRUCTURED 不重复写
    const existing = await prisma.memory.findFirst({
      where: { theme, sourceType: "FLYWHEEL_STRUCTURED", contentHash },
      select: { id: true },
    });
    if (existing) {
      console.log(`[structure-fragments:V1.7] dedup: contentHash=${contentHash.slice(0, 12)} 已存在 id=${existing.id.slice(-8)}`);
      continue;
    }

    // 2026-09-11 第 26 轮修(实测缺陷): 原来 create 里**没有 qualityScore** —— 落库取默认 0,
    //   于是新产的结构化记忆质量分为 0, FW-QUALITY(24h 平均质量)被拉到 0。
    //   实测: 2026-09-10 的 21 条 avg=0.462(来自历史补分脚本), 而本轮新写的 3 条 avg=0、全部 zeroq。
    //   修: 写库时用与其它产线同一个判据 calcQualityScore 打分, 而不是留给补分脚本。
    // 2026-09-11 第 29 轮再修(实测缺陷): 上一轮判据的**入参传错了** —— 传的是 confidence: 0.7, 但
    //   calcMemoryQuality 的签名是 {content,title,theme,tags,valueScore,reinforceCount}, **没有 confidence**;
    //   confidence 是 knowledge 分支的参数。于是「价值分」这一维恒定不得分, 且 valueScore 列一直留默认 0.5。
    //   实测证据: 24h 窗口 144 条 FLYWHEEL_STRUCTURED memory 的质量分只取 {0.2,0.4,0.7} 三档且 minQ=0.2,
    //   恰好等于三条**文本特征**正则(决策词0.3/经验词0.2/具体性0.2)的命中组合 —— 说明分数纯由文本特征决定。
    //   修: 按其它产线既有约定补齐 valueScore(LLM 新增自评字段) 与 tags 入参, 并把 valueScore 落到列上。
    // 2026-09-14 FW-QUALITY 收敛: 改调 product-quality.structuredProductScore(单一入口, valueScore 内部 clamp)。
    const structuredTags = JSON.stringify(["flywheel-structured", `v1.7-${new Date().toISOString().slice(0, 7)}`]);
    const structuredValue = o.valueScore ?? 0.5; // 与 cognitive-extractor 一致: 缺失回落 0.5
    const { qualityScore, belowFloor: isBelow } = classifyStructuredOutput(
      { content: o.content, title: o.title, valueScore: structuredValue },
      theme,
      structuredTags
    );
    // 2026-09-14: 低于 G3 门槛的产物仍入库(不隐藏), 但显式登记 + 告警 —— 让"某批产物拉低 FW-QUALITY"
    //   在任务账上可见。这是"检测并暴露", 不是"悄悄丢弃以美化均值"。
    if (isBelow) {
      belowFloor++;
      belowFloorScores.push(Number(qualityScore.toFixed(3)));
      console.warn(`[structure-fragments:V1.7] BELOW-FLOOR 产物: qualityScore=${qualityScore.toFixed(2)} < ${MIN_PRODUCT_QUALITY} theme="${theme}" title="${String(o.title).slice(0, 40)}" (已入库并在摘要登记)`);
    }
    // 2026-09-14 可追溯性修复(实测缺陷): 本处 create **没写 sourceId** ——
    //   平台不变量 traceable-finding-id('任务产出行可追溯 findingId(24h)') 因此在 24h 窗口内长期报 16 条,
    //   即 PL-TRUST(audit_violations 目标 0) 的两个构成之一。产出无法回溯到它由哪些碎片/来源整理而来,
    //   "认知复利"的链条在产物这一跳断开(也影响 FW-EVIDENCE: 无法给出落地证据)。
    //   溯源口径(择优): ① 本次被取代的碎片 id(即 LLM 明确指认的来源碎片); ② 无则用本 chunk 的首个碎片 id;
    //   ③ 都没有才留空。截断到 200 字符以适配列宽。
    const provenance = (
      o.supersedes && o.supersedes.length
        ? o.supersedes.slice(0, 5).join(",")
        : (chunk[0]?.id ?? "")
    ).slice(0, 200);
    // CREATE: 写 FLYWHEEL_STRUCTURED Memory
    // 2026-10-09 round 72-D3: 改为走**统一写入出口** safeCreateMemory(module store), 不再直连 prisma。
    //   为什么必须改: store 是认知闸/受控投影/qualityScore 兜底的唯一挂载点 —— 直连等于"闸管不到主流量"。
    //   实测本轮之前: 本产线近 7 天写 1476 条 Memory, 占同期 Memory 的 95%, 一条都没经过 store。
    //   代价必须说清: store 的 V3 内容闸可能返回 null(拒绝), 原来直连不会 —— 所以下面**显式处理 null**,
    //   计入 formatRejected 并跳过, 而不是让 structured.id 抛 TypeError 把整个主题打崩。
    const structured = await safeCreateMemory(prisma, {
      data: {
        content: o.content,
        title: o.title,
        qualityScore,
        valueScore: structuredValue,
        tier: "WARM",
        type: "memory",
        sourceType: "FLYWHEEL_STRUCTURED",
        sourceId: provenance,
        agentSource: actor,
        contentHash,
        theme,
        tags: structuredTags,
        importance: 0.7, // 结构化记忆 importance 偏高
        // round 72-D3: 认知闸要求的用途字段(LLM 产出; 缺失时留空 -> 闸会在 observe 下告警)
        summary: o.summary ?? null,
        scenario: o.scenario ?? null,
      },
    });
    if (!structured || !structured.id) {
      formatRejected++;
      formatRejectReasons["store-rejected"] = (formatRejectReasons["store-rejected"] || 0) + 1;
      console.warn(`[structure-fragments:V1.7] store 拒绝: title="${String(o.title).slice(0, 40)}"(统一出口的 V3 内容闸)`);
      continue;
    }
    if (!o.summary && !o.scenario) {
      // 不拦(闸在 observe 档), 但必须可见: "LLM 没按新要求给用途字段" 的比例是切 enforce 的前置读数
      missingPurpose = (missingPurpose || 0) + 1;
    }
    created++;
    console.log(`[structure-fragments:V1.7] created: structuredMemory id=${structured.id.slice(-8)} title="${o.title}" q=${qualityScore.toFixed(2)} supersedes=${o.supersedes.length}`);

    // 2026-09-14 并发去重兜底(实测缺陷): findFirst(dedup) + create **不是原子的** ——
    //   语义与 (createdAt, id) 字典序定序详见 structured-dedup.ts(**单一入口**)。
    //   此处不再内联实现, 避免"同毫秒 lt 不成立"那类修复只落在一处、另一处漂移。
    {
      const older = await markLaterDuplicateSuperseded("memory", { id: structured.id, createdAt: structured.createdAt }, theme, contentHash);
      if (older) console.warn(`[structure-fragments:V1.7] 并发去重兜底: id=${structured.id.slice(-8)} 与更早的 ${older.slice(-8)} 同 theme+contentHash, 已标记为被取代`);
    }

    // MERGE: 标记被取代碎片 supersededBy = structured.id (V3 五件套第 3 道防护)
    // V1.7 §11 C-V1.7-3 + Step 2 bug 修复: 碎片来自 3 表, 3 表都需标 supersededBy
    for (const fragmentId of o.supersedes) {
      if (!fragmentId) continue;
      // 先查 memory 表
      const memTarget = await prisma.memory.findUnique({
        where: { id: fragmentId },
        select: { id: true, sourceType: true, supersededBy: true },
      });
      if (memTarget) {
        if (memTarget.sourceType === "FLYWHEEL_STRUCTURED") {
          console.warn(`[structure-fragments:V1.7] WARN 跳过 FLYWHEEL_STRUCTURED 自指: ${fragmentId.slice(-8)}`);
          continue;
        }
        if (memTarget.supersededBy) continue;
        await prisma.memory.update({
          where: { id: fragmentId },
          data: { supersededBy: structured.id, supersededAt: new Date() },
        });
        merged++;
        continue;
      }
      // 再查 knowledge 表
      const knowTarget = await prisma.knowledge.findUnique({
        where: { id: fragmentId },
        select: { id: true, supersededBy: true },
      });
      if (knowTarget) {
        if (knowTarget.supersededBy) continue;
        await prisma.knowledge.update({
          where: { id: fragmentId },
          data: { supersededBy: structured.id, supersededAt: new Date() },
        });
        merged++;
        continue;
      }
      // 最后查 practice 表
      const pracTarget = await prisma.practice.findUnique({
        where: { id: fragmentId },
        select: { id: true, supersededBy: true },
      });
      if (pracTarget) {
        if (pracTarget.supersededBy) continue;
        await prisma.practice.update({
          where: { id: fragmentId },
          data: { supersededBy: structured.id, supersededAt: new Date() },
        });
        merged++;
        continue;
      }
    }
  }
  return { created, merged, belowFloor, belowFloorScores, formatRejected, formatRejectReasons, missingPurpose };
}

// ===== 主函数 =====
export async function structureFragments(input: StructureFragmentsInput): Promise<StructureFragmentsResult> {
  const t0 = Date.now();
  // 2026-09-01 合并提交优化: chunkSize 12000 -> 50000 (按调用次数计费, token 不限)
  //   与 reflect.ts 的 chunk 合并一致, 减少碎片化调用次数
  const { theme, lookbackDays = 7, chunkSize = 50000, actor = "flywheel:v1.7", force } = input;
  console.log(`[structure-fragments:V1.7] START theme="${theme}" lookbackDays=${lookbackDays} chunkSize=${chunkSize} force=${!!force} actor=${actor}`);

  try {
    // 1. 24h 防重入锁
    const lock = await checkAndAcquireLock(theme, actor, force);
    if (!lock.allowed) {
      return {
        theme, status: "SKIPPED",
        sessionCount: 0, fragmentCount: 0, outputCount: 0, mergedCount: 0,
        chunksProcessed: 0, durationMs: Date.now() - t0,
        summary: `24h 防重入锁: lockId=${lock.existingJobId?.slice(-8)} status=${lock.existingStatus} (force=${!!force} 可绕过)`,
      };
    }
    const lockId = lock.lockId!;

    // 2. 读碎片
    const fragments = await loadThemeFragments(theme, lookbackDays);
    if (fragments.length === 0) {
      // 2026-09-11 第 26 轮: 标记里带上本次使用的 lookback —— 否则"按 7 天窗口得出无碎片"会把
      //   "按 90 天首次窗口再看一眼"也一并锁死(实测: 修了首次 lookback 后仍被 7 天冷静期挡住)。
      await markJobDone(lockId, `theme="${theme}" 碎片数=0 (lookback=${lookbackDays}天), 无需结构化`);
      // 2026-09-11 第 25 轮修(实测缺陷): 原来返回 status:"OK" —— cron 把"什么都没做"计入 executed(成功),
      //   实测表现: 接口返回 executed:2 / byTheme OK, 但 FLYWHEEL_STRUCTURED 产物一条没多。指标与行为不一致。
      //   改为 SKIPPED, 让计数器如实反映"跳过"。
      return {
        theme, status: "SKIPPED",
        sessionCount: 0, fragmentCount: 0, outputCount: 0, mergedCount: 0,
        chunksProcessed: 0, durationMs: Date.now() - t0,
        summary: `theme="${theme}" lookbackDays=${lookbackDays} 碎片=0, 无可整理内容`,
      };
    }

    // 3. chunk
    const chunks = chunkFragments(fragments, chunkSize);
    console.log(`[structure-fragments:V1.7] chunked: ${fragments.length} fragments → ${chunks.length} chunks`);

    // 4. LLM 反向整理 (per chunk)
    let totalCreated = 0;
    let totalMerged = 0;
    // 2026-09-11 第 29 轮修(实测缺陷): 原来任一 chunk 失败就 break 并把整个 theme 判 FAILED, 注释理由是
    //   "不写半成品" —— 但 ingestStructuredOutputs 就在**同一个循环里**逐 chunk 写库, 实际语义是
    //   "已成功的 chunk 照写, 后面没跑的 chunk 全部放弃"。
    //   实测证据 theme='项目架构'(49 chunks): chunk 1-14 写入 45 条产物后, chunk 15 因 JSON 畸变失败
    //   -> chunk 16-49(约 408 条碎片)**再没跑过**, 最终 status=FAILED 却已落库 45 条。
    //   既不是整体回滚(注释所称), 也不是跳过坏 chunk 继续 —— 是最坏的组合: 部分写入 + 丢弃后续 70% 工作。
    //   改为: 记录失败 chunk 并**继续**后面的 chunk(每条产物都来自一个完整 chunk, 不存在半成品);
    //   只有**全部** chunk 都失败时才判 FAILED。
    const failedChunks: Array<{ index: number; error: string }> = [];
    // 2026-09-14 FW-QUALITY: 登记本轮低于 G3 门槛的产物(仍入库, 但让均值风险在任务账上可见)
    const belowFloorScores: number[] = [];
    // 2026-09-29 todo_0aa1ea6d28a049fba44d: 累计 format-rejected 数 (与 belowFloor 同样登记, 不隐藏)
    let totalFormatRejected = 0;
    /** 2026-10-09 round 72-D3: LLM 没给 summary/scenario 的条数(切 enforce 的前置读数) */
    let totalMissingPurpose = 0;
    const formatRejectReasons: Record<string, number> = {};
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      try {
        const outputs = await callLLMStructureFragments(theme, chunk);
        const { created, merged, belowFloorScores: bfs, formatRejected: fr, formatRejectReasons: frr, missingPurpose: mp } = await ingestStructuredOutputs(theme, outputs, actor, chunk);
        totalMissingPurpose += mp;
        totalCreated += created;
        totalMerged += merged;
        belowFloorScores.push(...bfs);
        totalFormatRejected += fr;
        for (const k of Object.keys(frr)) {
          formatRejectReasons[k] = (formatRejectReasons[k] || 0) + frr[k];
        }
        console.log(`[structure-fragments:V1.7] chunk ${ci + 1}/${chunks.length}: outputs=${outputs.length} created=${created} merged=${merged}${bfs.length ? ` belowFloor=${bfs.length}` : ""}${fr ? ` formatRejected=${fr}` : ""}`);
      } catch (chunkErr: any) {
        const msg = String(chunkErr?.message ?? chunkErr).slice(0, 200);
        failedChunks.push({ index: ci + 1, error: msg });
        console.error(`[structure-fragments:V1.7] chunk ${ci + 1}/${chunks.length} FAILED (跳过该 chunk, 继续后续): ${msg}`);
      }
    }

    const durationMs = Date.now() - t0;
    if (failedChunks.length === chunks.length) {
      const firstErr = failedChunks[0].error;
      await markJobFailed(lockId, `LLM 失败(全部 ${chunks.length} 个 chunk): ${firstErr}`);
      return {
        theme, status: "FAILED",
        sessionCount: 0, fragmentCount: fragments.length,
        outputCount: totalCreated, mergedCount: totalMerged,
        chunksProcessed: 0, durationMs,
        // 2026-09-11 修: 原来是 chunks.findIndex((_, i) => true) —— 谓词恒真, 恒返回 0,
        //   于是"第几个 chunk 出错"永远报 chunk 0/1, 与同一行的日志自相矛盾。改为记录真实序号。
        summary: `FAILED: 全部 ${chunks.length} 个 chunk 均失败, 首个失败 chunk ${failedChunks[0].index}: ${firstErr}`,
        error: firstErr,
      };
    }

    // 部分失败仍判 OK(避免 1h 重试风暴), 但把失败 chunk 写进摘要, 让"部分失败"在任务账上可见。
    const failNote = failedChunks.length
      ? ` failedChunks=${failedChunks.length} [${failedChunks.map((f) => f.index).join(",")}]`
      : "";
    // 2026-09-14 FW-QUALITY: 低于门槛的产物必须在摘要里可见(不隐藏), 附均分便于判断"这批拖了多少"。
    const belowFloorAvg = belowFloorScores.length
      ? Number((belowFloorScores.reduce((a, b) => a + b, 0) / belowFloorScores.length).toFixed(3))
      : null;
    const belowFloorNote = belowFloorScores.length
      ? ` belowFloor=${belowFloorScores.length}(avg${belowFloorAvg}, floor=${MIN_PRODUCT_QUALITY})`
      : "";
    // 2026-09-29 todo_0aa1ea6d28a049fba44d: format-rejected 计数同样进入摘要, 便于 7 日观察期核对
    const formatRejectNote = totalFormatRejected
      ? ` formatRejected=${totalFormatRejected}${Object.keys(formatRejectReasons).length ? ` [${Object.entries(formatRejectReasons).map(([k,v])=>`${k}:${v}`).join("; ")}]` : ""}`
      : "";
    const missingPurposeNote = totalMissingPurpose ? ` missingPurpose=${totalMissingPurpose}/${totalCreated + totalMissingPurpose}` : "";
    const summary = `theme="${theme}" fragments=${fragments.length} chunks=${chunks.length} created=${totalCreated} merged=${totalMerged}${failNote}${belowFloorNote}${formatRejectNote}${missingPurposeNote} duration=${durationMs}ms`;
    await markJobDone(lockId, summary);

    console.log(`[structure-fragments:V1.7] END ${summary}`);
    return {
      theme, status: "OK",
      sessionCount: 0,  // 暂未读取 session 全文, 用碎片量代替
      fragmentCount: fragments.length,
      outputCount: totalCreated,
      mergedCount: totalMerged,
      chunksProcessed: chunks.length - failedChunks.length,
      failedChunks: failedChunks.map((f) => f.index),
      belowFloorCount: belowFloorScores.length,
      belowFloorAvg,
      // 2026-09-29 todo_0aa1ea6d28a049fba44d: 暴露给上层 (FlywheelJob / console 看板)
      ...(totalFormatRejected ? {
        formatRejectedCount: totalFormatRejected,
        formatRejectReasons,
      } : {}),
      // round 72-D3: 用途字段缺失数必须**无条件**暴露 —— 它是"能不能切 enforce"的唯一前置读数,
      //   藏在条件分支里就等于没人看得到。
      missingPurposeCount: totalMissingPurpose,
      durationMs,
      summary,
    };
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    console.error(`[structure-fragments:V1.7] END FAILED theme="${theme}" duration=${durationMs}ms err=${err.message}`);
    return {
      theme, status: "FAILED",
      sessionCount: 0, fragmentCount: 0, outputCount: 0, mergedCount: 0,
      chunksProcessed: 0, durationMs,
      summary: `FAILED: ${err.message.slice(0, 200)}`,
      error: err.message,
    };
  }
  // P2 修复 2026-08-28: 删除 finally 里的 prisma.$disconnect()
  // structureFragments 被 /api/v1/flywheel/structured/run API 路由调用 (Next.js 服务进程内),
  // disconnect 全局共享 PrismaClient 会让后续调用报 "Engine is not yet connected"。
}
