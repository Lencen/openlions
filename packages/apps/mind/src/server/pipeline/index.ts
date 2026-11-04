import type {
  PipelineResult,
  ScanResult,
} from "./types";
import {
  scanAllConversations,
  scanSessionService,
  filterNewConversations,
  getUpdatedConversations,
  getAlreadyProcessedConversations,
  lookupProcessedCount,
  enrichWithMessages,
  markSessionExtractStatus,
} from "./conversation-scanner";
import { autoTriggerReflection } from "./reflect-cron";
import { extractCognitiveData, extractCognitiveDataBatch } from "./cognitive-extractor";
import type { BatchSessionInput, BatchExtractResult } from "./cognitive-extractor";
import { writeToDatabase } from "./db-writer";
// 2026-09-23 uos20 #8: Skills 成功率汇总 (与 db-writer 共用同一口径纯函数)
import { computeSkillSuccessRate, type SkillSuccessRate } from "./skill-success-rate";
import { runWithTrace, withStage, makeLogger, getTraceId, setTraceId, createTraceId, estimateTokens } from "./logger";
import { recordError, recordErrorAsync, classifyErrorFromMessage } from "./error-sink";
import { prisma } from "@/lib/prisma"; // 遗留#8: B-2 修复需要查 DB 实际新增量

const log = makeLogger("pipeline");

export interface PipelineOptions {
  dryRun?: boolean;
  projectFilter?: string;
  maxConversations?: number;
  sourceType?: string;
  runMode?: string;
  sessionIds?: string[]; // process specific sessions, even if already processed
  onProgress?: (current: number, total: number, result?: PipelineResult) => void;
}

export interface PipelineReport {
  scanned: ScanResult;
  processed: PipelineResult[];
  totalRecordsCreated: number;
  errors: Array<{ sessionId: string; error: string }>;
  skipped: number;
  // 2026-09-23 uos20 #8: 本次 run 的 Skills 成功率汇总 (两位小数 + 原始分子分母)。
  //   独立于 totalRecordsCreated, 避免 skill=0 被聚合掩盖; 无候选时 rate=null。
  skillSuccess: SkillSuccessRate;
}

/**
 * 合并 Claude 客户端 + session 服务两个数据源
 * session 服务优先 (更全, 含全 agent), Claude 作为补充
 */
async function scanAllSources(): Promise<ScanResult> {
  const claudeScan = scanAllConversations(); // 同步, 兼容旧
  // Bug fix: 之前 limit=2000 但 session-service 有 12000+ session, 按 updatedAt ASC 排序
  // 只拉到最旧的 2000 个, 最新 session 看不到. 改为用 since 参数只拉最近有变化的.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 最近 7 天
  const sessionServiceConvs = await scanSessionService({ limit: 2000, since });

  const allConvs = [...sessionServiceConvs, ...claudeScan.newConversations];

  // 按 sessionId 去重 (session 服务优先)
  const seen = new Set<string>();
  const deduped = allConvs.filter((c) => {
    if (seen.has(c.sessionId)) return false;
    seen.add(c.sessionId);
    return true;
  });

  // 合并 projectSummary
  const projectSummaryMap = new Map<string, { projectPath: string; projectName: string; conversationCount: number; newCount: number }>();
  for (const ps of claudeScan.projectSummary) {
    projectSummaryMap.set(ps.projectName, { ...ps });
  }
  // session 服务统一汇总到一个 project
  if (sessionServiceConvs.length > 0) {
    projectSummaryMap.set("lions-session-service", {
      projectPath: "lions-session-service",
      projectName: "lions-session-service",
      conversationCount: sessionServiceConvs.length,
      newCount: sessionServiceConvs.length,
    });
  }

  // f-005 (2026-09-14): alreadyProcessed 之前恒为 claudeScan.alreadyProcessed(硬编码 0),
  //   scan 日志/埋点永远显示 0 -> acceptance 不可复算. 这里用与 filterNewConversations
  //   同一套三键口径, 对 deduped 实际复算"已处理"条数, 让 scan ENTER 日志可被验证.
  const processedForScan = await getAlreadyProcessedConversations();
  const alreadyProcessed = deduped.reduce(
    (n, c) => n + (lookupProcessedCount(processedForScan, c) !== undefined ? 1 : 0),
    0
  );

  return {
    totalConversations: deduped.length,
    newConversations: deduped,
    alreadyProcessed,
    projectSummary: Array.from(projectSummaryMap.values()),
  };
}

export async function runPipeline(
  options: PipelineOptions = {}
): Promise<PipelineReport> {
  // P1-A 2026-08-31: maxConversations 默认 5, 防止 tRPC/外部调用不传时全量跑
  //   根因: 2026-08-31 上午 24 trace 全量处理 1679 session, 4845 次无效 LLM 调用烧光 Token Plan 额度
  const { dryRun = false, projectFilter, maxConversations = 5, sourceType, sessionIds, onProgress } = options;

  // 2026-08-21 leo: 确保每次 runPipeline 都有 traceId (支持 nested runPipeline 调用)
  if (!getTraceId()) {
    setTraceId(createTraceId());
  }
  const traceId = getTraceId();
  // B-2 修复: 记录 pipeline 开始时间, 用于结束时从 DB 查实际新增量
  (globalThis as any).__pipelineStartTime = Date.now();
  log.info("runPipeline start", { dryRun, projectFilter, maxConversations, sourceType, sessionIds: sessionIds?.length });

  // scan stage 只为埋点, 真正数据放 stage 外
  const scanned = await scanAllSources();
  await withStage("scan", { dryRun, maxConversations, totalConversations: scanned.totalConversations, newConversations: scanned.newConversations.length, alreadyProcessed: scanned.alreadyProcessed }, async (progress) => {
    progress("scan done", { totalConversations: scanned.totalConversations, newConversations: scanned.newConversations.length, alreadyProcessed: scanned.alreadyProcessed });
  });
  log.info("scanned", { totalConversations: scanned.totalConversations, newConversations: scanned.newConversations.length });
  let candidates: typeof scanned.newConversations = [];

  if (sessionIds && sessionIds.length > 0) {
    // Process specific sessions - look in ALL scanned conversations
    candidates = scanned.newConversations.filter(c => sessionIds.includes(c.sessionId));
  } else {
    candidates = await filterNewConversations(scanned.newConversations);
    const updated = await getUpdatedConversations(scanned.newConversations);
    candidates = [...candidates, ...updated];
  }

  // DEBUG: 临时调试输出
  // console.log(`[DEBUG runPipeline] scanned.newConversations=${scanned.newConversations.length} candidates(after filter)=${candidates.length} dryRun=${dryRun} maxConversations=${maxConversations}`);

  if (projectFilter) {
    candidates = candidates.filter((c) =>
      c.projectPath.toLowerCase().includes(projectFilter.toLowerCase())
    );
  }

  // 优先处理消息数多的 session (有价值的内容), 跳过空对话
  // 2026-09-01 NETWORK 死端修复: retryable (瞬时错误 FAILED 冷却后重试) 会话排最前,
  //   否则会被大消息量 PENDING 会话挤掉, 永远轮不到重试
  candidates.sort((a, b) => {
    if (!!a.retryable !== !!b.retryable) return a.retryable ? -1 : 1;
    return b.messageCount - a.messageCount;
  });

  // Step 4: Apply limit
  if (maxConversations) {
    candidates = candidates.slice(0, maxConversations);
  }

  const report: PipelineReport = {
    scanned,
    processed: [],
    totalRecordsCreated: 0,
    errors: [],
    skipped: 0,
    skillSuccess: computeSkillSuccessRate(0, 0),
  };

  // Step 5: Enrich + 增量截断 (按 token 预算分块, 2026-08-21 leo)
  //   之前: 硬截 MAX_NEW_MSGS=10, 切断上下文
  //   现在: 按 token 预算分块, 单 session 可拆 N 块, LLM 多次返回
  //   预算: 每块 ≤ 8000 tokens (中文 1.5 字符/token, 英文 4 字符/token)
  //   总批次预算: 32000 tokens (留余给 system prompt + 输出 8192)
  const processedMap = await getAlreadyProcessedConversations();
  const batchInputs: BatchSessionInput[] = [];
  const sessionMap = new Map<string, typeof candidates[0]>();

  const TOKENS_PER_CHUNK = 8000;       // 单 chunk 上限
  const MIN_MESSAGES_PER_CHUNK = 3;    // 避免太碎
  const MAX_CHUNKS_PER_SESSION = 1;    // B-1 修复: 1 session = 1 chunk, 避免同一 session 被重复提取 4 次

  for (let i = 0; i < candidates.length; i++) {
    const conv = candidates[i];
    try {
      const enrichedConv = await enrichWithMessages(conv);
      // 2026-08-21 leo: 双 key 匹配 (filePath + sessionId 后缀), 解决 SyncLog 匹配错位
      // f-005 (2026-09-14): 收敛为 lookupProcessedCount 单一实现, 与过滤阶段共用口径
      const lastProcessedCount =
        lookupProcessedCount(processedMap, enrichedConv) ?? 0;
      // Bug fix: enrichWithMessages 限 MAX_MESSAGES=500, 但 SyncLog 可能记 1000+
      // 如果 lastProcessedCount >= enrichedConv.messages.length, 说明新消息都在 MAX_MESSAGES 之后
      // 此时 take 全部 messages 当作 "all new" 处理, 不然会无限跳过
      const actualMessages = enrichedConv.messages;
      const allNewMessages = lastProcessedCount >= actualMessages.length
        ? actualMessages  // 全部当 new 处理 (enrich 不完整, SyncLog 可能记的是源文件长度)
        : actualMessages.slice(lastProcessedCount);
      if (allNewMessages.length === 0) continue;

      // P0-1 (2026-09-01) 提炼前价值预筛: 新增消息 < 3 条 = 低信息量会话, 跳过 LLM 提炼
      //   实测积压中 38% 是 <3 条消息的会话, 跳过可省 ~38% 提炼调用 (逻辑优化方案 S2)
      if (allNewMessages.length < 3) {
        report.skipped++;
        if (conv.filePath.startsWith("session-service:")) {
          markSessionExtractStatus(conv.sessionId, "DONE"); // 标记已消费, scan 不再拉到
        }
        continue;
      }

      // 按 token 分块 (从尾向头遍历, 保证最新消息优先被处理)
      const reversed = [...allNewMessages].reverse();
      const chunks: typeof allNewMessages[] = [];
      let current: typeof allNewMessages = [];
      let currentTokens = 0;

      for (const msg of reversed) {
        const t = estimateTokens(msg.content || "");
        if (current.length >= MIN_MESSAGES_PER_CHUNK && currentTokens + t > TOKENS_PER_CHUNK) {
          // 当前块已满, 保存并开始新块
          chunks.push(current.reverse());
          current = [];
          currentTokens = 0;
          if (chunks.length >= MAX_CHUNKS_PER_SESSION) break;
        }
        current.push(msg);
        currentTokens += t;
      }
      if (current.length > 0) chunks.push(current.reverse());
      if (chunks.length === 0) continue;

      // 多 chunk 时按从最新到最旧顺序喂 LLM (避免丢失上下文)
      const orderedChunks = chunks.reverse();

      for (let chunkIdx = 0; chunkIdx < orderedChunks.length; chunkIdx++) {
        const newMessages = orderedChunks[chunkIdx];
        batchInputs.push({
          conversation: enrichedConv,
          newMessages,
          lastProcessedCount: lastProcessedCount + (allNewMessages.length - newMessages.length - chunks.slice(chunkIdx + 1).reduce((s, c) => s + c.length, 0)),
          sessionIndex: (i + 1) * 100 + chunkIdx + 1,  // 主 session 用 1xx, 2xx, chunk 用 101/102/...
        });
        sessionMap.set(enrichedConv.sessionId, enrichedConv);
      }
    } catch (error) {
      report.errors.push({
        sessionId: conv.sessionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (batchInputs.length === 0) {
    report.skipped = scanned.totalConversations - candidates.length;
    return report;
  }

  // Step 6: 按 token 总量切分 batch (避免 prompt 38万 tokens 把 LLM 打爆)
  //   单 batch ≤ 100000 tokens input (MiniMax-M3 支持 200K+ 上下文, 留余给 system prompt + 输出)
  //   P2 优化: 从 24000 提升到 100000, 调用次数从 ~219 降到 ~22 (按调用次数计费更划算)
  //   P1-B 2026-08-31: 加 MAX_SESSIONS_PER_BATCH=8 硬上限 -- 输入塞满 100K token 时
  //     LLM 输出必超 8192 maxTokens (JSON 腰斩 SCHEMA_INVALID), 整批 20-50 session 全报废。
  //     8 session × 平均输出 ~800 token ≈ 6.4K < 8192, 从源头防截断。
  const TOKENS_PER_BATCH = 100000;
  // 2026-10-06 收紧 8 -> 4 (实测证据): 当日 24h 内 **54 个真实会话**被标 extractStatus=FAILED,
  //   extractError 全是 JSON 截断类("Expected ',' or '}' ... position 16087/17402/13012" —— 16K 字符
  //   ≈ 8K token, 正撞 maxTokens=8192)。按 8 条/批的失败面统计: 7 个失败批 × 最多 8 条 = 54 条,
  //   即**一个批的输出超限会连坐整批**。4 条/批把单次输出上限减半, 从源头降低连坐概率;
  //   代价是调用次数约翻倍(单次成本更低, 且平台 5h 调用量远低于配额)。
  const MAX_SESSIONS_PER_BATCH = 4;
  const subBatches: BatchSessionInput[][] = [];
  let currentBatch: BatchSessionInput[] = [];
  let currentTokens = 0;

  for (const input of batchInputs) {
    const inputTokens = estimateTokens(JSON.stringify(input.newMessages));
    if (currentBatch.length > 0 && (currentTokens + inputTokens > TOKENS_PER_BATCH || currentBatch.length >= MAX_SESSIONS_PER_BATCH)) {
      subBatches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push(input);
    currentTokens += inputTokens;
  }
  if (currentBatch.length > 0) subBatches.push(currentBatch);

  onProgress?.(0, subBatches.length);
  try {
    const allBatchResults: BatchExtractResult[] = [];
    let consecutiveErrors = 0;  // O1: 连续错误计数, 429 早停
    let totalErrors = 0;        // P1-D: 累计错误 (防交替失败把连续计数清零)

    // P1-C 2026-08-31: SCHEMA_INVALID (输出截断) 降级拆分
    //   JSON 在 maxTokens 处腰斩时, 对半拆 batch 重试 (拆到单 session 输出必 < 8192)。
    //   拆到 1 个 session 还截断才真正放弃。换取: 不再整批报废。
    const extractWithDegrade = async (batch: BatchSessionInput[], depth = 0): Promise<BatchExtractResult[]> => {
      try {
        return await extractCognitiveDataBatch(batch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isTruncation = /Expected|Unterminated|invalid JSON|JSON\.parse|SyntaxError/i.test(msg);
        // P0-2 (2026-09-01) 空转治理: depth 3 -> 1, 最多对半拆一次
        //   原 depth=3 递归最多 15 次调用/批 (拆到单 session 仍失败), 放大空转
        if (isTruncation && batch.length > 1 && depth < 1) {
          const mid = Math.ceil(batch.length / 2);
          log.warn("extract 输出截断, 降级拆分重试", { from: batch.length, half: mid, depth });
          const partA = await extractWithDegrade(batch.slice(0, mid), depth + 1);
          const partB = await extractWithDegrade(batch.slice(mid), depth + 1);
          return [...partA, ...partB];
        }
        throw e;
      }
    };

    for (let batchIdx = 0; batchIdx < subBatches.length; batchIdx++) {
      // O1: 429 早停 -- 连续 3 次 429 说明 Token Plan 用完, 继续跑只是浪费时间
      if (consecutiveErrors >= 3) {
        log.warn("extract 429 早停", { consecutiveErrors, skipped: subBatches.length - batchIdx });
        break;
      }
      // P1-D: 累计错误熔断 -- 交替成功/失败会不断重置连续计数, 累计 15 个 session 错
      //   (≈3 个满 batch) 说明本轮数据普遍有问题 (如输出超限/数据污染), 停止烧额度
      if (totalErrors >= 15) {
        log.warn("extract 累计错误熔断", { totalErrors, skipped: subBatches.length - batchIdx });
        break;
      }
      const subBatch = subBatches[batchIdx];
      const subTokens = estimateTokens(JSON.stringify(subBatch.map(b => b.newMessages)));

      // 用 stage 包裹单 sub-batch (单 stage 一次只发一个 batch)
      // 2026-08-21 leo: P1 修复 -- sessionIndex 在每个 sub-batch 内从 1 重新编号
      //   之前用 101/102/... 全局编号, LLM 按 S1/S2 返回 1/2, 永远不匹配
      const renumberedSubBatch = subBatch.map((input, idx) => ({
        ...input,
        sessionIndex: idx + 1,
      }));
      const extractStage = await withStage("extract", {
        batchIdx: batchIdx + 1,
        totalBatches: subBatches.length,
        batchSize: renumberedSubBatch.length,
        totalTokens: subTokens,
      }, async (progress) => {
        // P1-C: 用降级拆分版, 输出截断时自动对半重试
        const results = await extractWithDegrade(renumberedSubBatch);
        progress("extracted sub-batch", { results: results.length });
        return { results, summary: { count: results.length } };
      });

      if (extractStage.ok && extractStage.output?.results) {
        allBatchResults.push(...extractStage.output.results);
        consecutiveErrors = 0;  // O1: 成功重置
      } else {
        // 失败: 把这批所有 session 记为错
        const errMsg = extractStage.error?.message || "extract failed";
        const errType = classifyErrorFromMessage(errMsg);
        consecutiveErrors++;  // O1: 连续失败+1
        totalErrors += subBatch.length;  // P1-D: 累计 (按 session 数加权)
        for (const input of subBatch) {
          report.errors.push({
            sessionId: input.conversation.sessionId,
            error: errMsg,
          });
          // 2026-08-21 leo: 错误落库 (按错误类型分类, 便于趋势分析)
          recordErrorAsync({
            errorType: errType,
            stage: "extract",
            message: errMsg,
            sourcePath: input.conversation.filePath,
            sessionId: input.conversation.sessionId,
            sourceType: options.sourceType || "PIPELINE_DEFAULT",
          });
          // P0-1 (2026-09-01) 空转治理: 回写 session 服务 extractStatus=FAILED
          //   下次 scan 的 status=PENDING 过滤会排除它, 停止循环重提 (空转根因)
          if (input.conversation.filePath.startsWith("session-service:")) {
            markSessionExtractStatus(
              input.conversation.sessionId,
              "FAILED",
              errType,
            );
          }
        }
      }
      onProgress?.(batchIdx + 1, subBatches.length);
    }

    const batchResults = allBatchResults;

    // Step 7: 逐个写入 DB
    for (const result of batchResults) {
      const conv = sessionMap.get(result.sessionId);
      if (!conv) continue;

      if (dryRun) {
        report.processed.push({
          conversation: conv,
          extracted: result.extracted,
          stats: {
            memoriesCreated: result.extracted.memories.length,
            knowledgeCreated: result.extracted.knowledge.length,
            reflectionsCreated: result.extracted.reflections.length,
            practicesCreated: result.extracted.practices.length,
            flywheelEventsCreated: 0,
            // uos20 #8: dry-run 也按同一口径暴露 (skills 已过 SKILL-SPEC, knowledgeFromSkills 即降级)
            ...computeSkillSuccessRate(
              result.extracted.skills.length,
              (result.extracted.knowledgeFromSkills || []).length,
            ),
          },
        });
        continue;
      }

      const writeStage = await withStage("write", { sessionId: conv.sessionId, agent: (conv as any).agentId }, async (progress) => {
        const r = await writeToDatabase(conv, result.extracted, { sourceType, runMode: options.runMode });
        progress("wrote", { sessionId: conv.sessionId, memories: r.stats.memoriesCreated, knowledge: r.stats.knowledgeCreated });
        return r;
      });
      const writeResult = writeStage.ok ? writeStage.output : null;
      if (!writeResult) continue;
      report.processed.push(writeResult);
      // P0-1 (2026-09-01): 提取成功回写 DONE, 让 scan 的 status=PENDING 不再拉到它
      if (conv.filePath.startsWith("session-service:")) {
        markSessionExtractStatus(conv.sessionId, "DONE");
      }
      // 遗留#5 (2026-09-01): 提取后即时触发该主题反思 (autoTriggerReflection, 三重冷却)
      try {
        const ext = writeResult.extracted;
        const theme =
          ext?.memories?.[0]?.theme ||
          ext?.knowledge?.[0]?.theme ||
          ext?.reflections?.[0]?.theme ||
          "";
        if (theme) {
          autoTriggerReflection(theme).catch(() => {});
        }
      } catch { /* 反思触发失败不阻塞 */ }
      // P6 修复: Object.values 含非 number 字段导致 "0[object Object]"
      //   只对 number 类型求和
      const s = writeResult.stats;
      report.totalRecordsCreated +=
        (s.memoriesCreated || 0) +
        (s.knowledgeCreated || 0) +
        (s.reflectionsCreated || 0) +
        (s.practicesCreated || 0) +
        (s.skillsCreated || 0);
    }
    // B-2 修复: 从 DB 查实际新增量, 不依赖 extract 累加 (会有遗漏)
    const tStart = (globalThis as any).__pipelineStartTime || Date.now();
    try {
      const dbActual = await prisma.$queryRawUnsafe(`
        SELECT
          (SELECT COUNT(*) FROM Memory WHERE createdAt > ${tStart}) +
          (SELECT COUNT(*) FROM Knowledge WHERE createdAt > ${tStart}) +
          (SELECT COUNT(*) FROM Reflection WHERE createdAt > ${tStart}) +
          (SELECT COUNT(*) FROM Practice WHERE createdAt > ${tStart}) +
          (SELECT COUNT(*) FROM Skill WHERE createdAt > ${tStart})
      `);
      // Prisma $queryRawUnsafe 返回 BigInt, 需要转 Number
      const dbRows = dbActual as Array<Record<string, bigint>>;
      const row = dbRows[0] || (dbRows as any);
      const dbCount = row ? Number(Object.values(row)[0]) : 0;
      log.info("runPipeline end", {
        totalRecordsCreated: report.totalRecordsCreated,
        dbActualCreated: dbCount,
        processed: report.processed.length,
        errors: report.errors.length
      });
    } catch (dbErr) {
      // DB 查询失败时回退到原统计方式
      log.info("runPipeline end", {
        totalRecordsCreated: report.totalRecordsCreated,
        dbActualCreated: -1,  // -1 表示查询失败
        processed: report.processed.length,
        errors: report.errors.length
      });
    }
  } catch (error) {
    // 单 batch 调用失败 -- 只记录未成功处理的 session
    for (const subBatch of subBatches) {
      // 这里不能精确知道哪些 session 失败了, 保守地把整批记为错
      for (const input of subBatch) {
        report.errors.push({
          sessionId: input.conversation.sessionId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  report.skipped = scanned.totalConversations - candidates.length;

  // ===== 2026-09-23 uos20 #8 Skills 成功率汇总 =====
  //   跨 session 累加原始分子分母后再算率 (不平均各 session 的率, 避免小样本加权失真),
  //   两位小数 + 原始分子分母一并暴露, 可由 processed[].stats 逐步复算。
  {
    let created = 0;
    let downgraded = 0;
    for (const r of report.processed) {
      created += r.stats.skillsCreated || 0;
      downgraded += r.stats.skillsDowngraded || 0;
    }
    report.skillSuccess = computeSkillSuccessRate(created, downgraded);
  }

  return report;
}

export async function processSingleConversation(
  sessionId: string,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const { scanAllConversations } = await import("./conversation-scanner");
  const { extractCognitiveData } = await import("./cognitive-extractor");
  const { writeToDatabase } = await import("./db-writer");

  const allConvs = scanAllConversations().newConversations;
  const conv = allConvs.find((c) => c.sessionId === sessionId);

  if (!conv) {
    throw new Error(`Conversation ${sessionId} not found`);
  }

  const extracted = await extractCognitiveData(conv);

  if (options.dryRun) {
    return {
      conversation: conv,
      extracted,
      stats: {
        memoriesCreated: extracted.memories.length,
        knowledgeCreated: extracted.knowledge.length,
        reflectionsCreated: extracted.reflections.length,
        practicesCreated: extracted.practices.length,
        skillsCreated: extracted.skills.length,
        flywheelEventsCreated: 0,
      },
    };
  }

  return writeToDatabase(conv, extracted, { sourceType: "PIPELINE_CLAUDE" });
}

export { scanAllConversations, scanSessionService, filterNewConversations, getUpdatedConversations, getAlreadyProcessedConversations, enrichWithMessages } from "./conversation-scanner";
export { extractCognitiveData, extractCognitiveDataBatch } from "./cognitive-extractor";
export type { BatchSessionInput, BatchExtractResult } from "./cognitive-extractor";
export { writeToDatabase } from "./db-writer";
