/**
 * structure-inject.e2e.ts — 结构化管线端的反向用例（可复跑；假报文不发真请求）
 *
 * 为什么需要它（判据 3/4 的"落库/判失败"必须在**管线**层证明，光看 client 单元不够）：
 *   判据 3：content 为空 + reasoning_content 有正文 -> 必须取到正文并**落库**（Memory 新行正文可见）
 *   判据 4：finish_reason=length 且只出 1 token -> 必须**判失败**（status=FAILED / 事件 FAIL:TRUNCATED / 0 落库）
 *
 * 运行（必须显式给验证库 DSN，绝不默认连生产库）：
 *   export MIND_DB_DRIVER=pg
 *   export MIND_DATABASE_URL="$(sed -nE 's/^MIND_DATABASE_URL=//p' ~/.config/lions/comm-verify-mind.env)"
 *   tsx src/server/llm/structure-inject.e2e.ts                  # 判据 3（假报文）
 *   tsx src/server/llm/structure-inject.e2e.ts --inject-length  # 判据 4（假报文）
 *   tsx src/server/llm/structure-inject.e2e.ts --real           # 真请求 uniontech（判据 1/2 证据）
 *
 * 安全性：只写 theme="LLM-PROTOCOL-SMOKE" 的数据，开跑前先清同 theme 的 FLYWHEEL_STRUCTURED 与 job 行。
 */
const THEME = "LLM-PROTOCOL-SMOKE";
const ACTOR = "llm-protocol-selftest";

function maskHeaders(h: Record<string, string>): string {
  const out: Record<string, string> = { ...h };
  for (const k of Object.keys(out)) {
    if (/authorization|x-api-key|api-key/i.test(k)) out[k] = out[k].replace(/(Bearer\s+)?(.{0,4}).*/, "$1$2***");
  }
  return JSON.stringify(out);
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--real")
    ? "real"
    : process.argv.includes("--inject-length")
      ? "inject-length"
      : process.argv.includes("--inject-anthropic")
        ? "inject-anthropic"
        : "inject-reasoning";

  if (!process.env.MIND_DATABASE_URL) {
    console.error("[e2e] 拒绝运行：必须显式设置 MIND_DATABASE_URL（建议指向验证库 lions_comm_verify_mind）");
    process.exit(2);
  }
  if (mode === "real") {
    process.env.LLM_PROTOCOL = "openai";
    process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || "https://llm.example.com/tenant/v1";
    process.env.LLM_MODEL = process.env.LLM_MODEL || "agent-d-v4.1-flash-1017";
    if (!process.env.UNIONTECH_API_KEY && !process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY) {
      console.error("[e2e] --real 需要 UNIONTECH_API_KEY / LLM_API_KEY / OPENAI_API_KEY");
      process.exit(2);
    }
  } else if (mode === "inject-anthropic") {
    // 回退路径（判据 5）：不设 LLM_PROTOCOL 或显式 anthropic -> 必须逐字回到旧请求
    process.env.LLM_PROTOCOL = "anthropic";
    process.env.ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "fake-anthropic-key";
    process.env.ANTHROPIC_MODEL = "MiniMax-M3";
  } else {
    // 假报文模式：协议必须 openai，否则注入的 choices 结构不会被解析
    process.env.LLM_PROTOCOL = "openai";
    process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
    process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
    process.env.UNIONTECH_API_KEY = process.env.UNIONTECH_API_KEY || "fake-key-for-inject";
  }

  const { prisma } = await import("../../lib/prisma");
  const mod = await import("../pipeline/structure-fragments");
  const { getLlmClientStats } = await import("./client");

  console.log(`[e2e] mode=${mode} db=${String(process.env.MIND_DATABASE_URL).replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`[e2e] protocol=${process.env.LLM_PROTOCOL} base=${process.env.LLM_BASE_URL} model=${process.env.LLM_MODEL}`);

  // 1) 清理同 theme 旧数据（幂等可复跑）
  const delOut = await prisma.memory.deleteMany({ where: { theme: THEME, sourceType: "FLYWHEEL_STRUCTURED" } });
  const delJob = await prisma.flywheelJob.deleteMany({ where: { idempotencyKey: `structured:${THEME}` } });
  const oldFrags = await prisma.memory.deleteMany({ where: { theme: THEME, agentSource: ACTOR } });
  console.log(`[e2e] cleaned: structured=${delOut.count} job=${delJob.count} oldFragments=${oldFrags.count}`);

  // 2) 造 3 条碎片（memory 表；内容带明确决策规则，便于模型产出合规的 V3 条目）
  const frags = [
    "飞轮 LLM 通道必须按协议分流：Anthropic 协议走 /v1/messages，OpenAI 协议走 /v1/chat/completions。因为 uniontech 已禁用 Anthropic 协议（403 permission_error），只改 env 无效。判据：请求 URL 里出现 /chat/completions。",
    "空正文必须回落：uniontech 的 OpenAI 响应 choices[0].message.content 可能为空字符串，正文在 reasoning_content 或 reasoning 里。必须依次回落，回落不到才算真空响应并记 EMPTY，禁止静默跳过。判据：reasoningFallbacks 计数大于 0 且正文非空。",
    "finish_reason=length 必须判失败：uniontech 真实窗口约 30 万 token，prompt 到 345265 时网关返回 finish_reason=length 且只出 1 token，不报错。必须记为 TRUNCATED 失败，不能记 OK；阈值取 chunk 50K tokens，余量约 21 万。",
  ];
  for (let i = 0; i < frags.length; i++) {
    await prisma.memory.create({
      data: {
        content: frags[i],
        title: `LLM 协议碎片 ${i + 1}`,
        theme: THEME,
        sourceType: "FLYWHEEL_REFLECTION",
        agentSource: ACTOR,
        tier: "WARM",
        importance: 0.6,
      },
    });
  }
  console.log(`[e2e] fragments inserted=${frags.length}`);

  // 3) 装假 fetch（仅注入模式）；真实模式保持真 fetch
  let capturedUrl = "";
  let capturedHeaders = "";
  if (mode !== "real") {
    const outputs = [
      {
        title: "LLM 协议必须按 host 分流",
        summary: "协议开关决定请求路径与鉴权头",
        scenario: "换供应商或改了 LLM_PROTOCOL 时核对",
        content:
          "## 规则\n必须按 LLM_PROTOCOL 分流：openai -> /v1/chat/completions + Bearer；anthropic -> /v1/messages + x-api-key。\n\n" +
          "REASONING_FALLBACK_BODY_MARKER：正文来自 reasoning_content 回落，不是 content。\n\n" +
          "判据：FlywheelEvent 的 sourceTitle 里 model=agent-d-v4.1-flash-1017 host=llm.example.com。",
        supersedes: [],
        reason: "注入用例：content 为空，正文只在 reasoning_content",
        valueScore: 0.85,
      },
    ];
    const payload =
      mode === "inject-anthropic"
        ? {
            content: [{ type: "thinking", thinking: "先想一下" }, { type: "text", text: JSON.stringify({ outputs }) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1234, output_tokens: 256 },
            model: "MiniMax-M3",
          }
        : mode === "inject-length"
        ? {
            choices: [{ index: 0, message: { role: "assistant", content: "A", reasoning_content: "" }, finish_reason: "length" }],
            usage: { prompt_tokens: 345265, completion_tokens: 1 },
            model: "agent-d-v4.1-flash-1017",
          }
        : {
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  reasoning_content: JSON.stringify({ outputs }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1234, completion_tokens: 256 },
            model: "agent-d-v4.1-flash-1017",
          };
    (globalThis as any).fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers || {})) h[String(k).toLowerCase()] = String(v);
      capturedHeaders = maskHeaders(h);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
  }

  // 4) 跑一轮结构化
  const t0 = Date.now();
  const result = await mod.structureFragments({ theme: THEME, lookbackDays: 7, chunkSize: 50000, actor: ACTOR, force: true });
  const durationMs = Date.now() - t0;

  console.log("[e2e] ---- 管线返回 ----");
  console.log(
    JSON.stringify(
      {
        status: result.status,
        outputCount: result.outputCount,
        mergedCount: result.mergedCount,
        chunksProcessed: result.chunksProcessed,
        failedChunks: (result as any).failedChunks,
        summary: result.summary,
        error: (result as any).error,
        durationMs,
      },
      null,
      1
    )
  );
  if (capturedUrl) console.log(`[e2e] injected request: url=${capturedUrl} headers=${capturedHeaders}`);
  console.log(`[e2e] llm stats=${JSON.stringify(getLlmClientStats())}`);

  // 5) 查落库 + 事件
  const rows = await prisma.memory.findMany({
    where: { theme: THEME, sourceType: "FLYWHEEL_STRUCTURED" },
    select: { id: true, title: true, content: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const events = await prisma.flywheelEvent.findMany({
    where: { stage: "CALL_LLM", sourceType: "platform:structured" },
    select: { sourceTitle: true, targetStage: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const job = await prisma.flywheelJob.findUnique({ where: { idempotencyKey: `structured:${THEME}` }, select: { status: true, error: true } });

  console.log("[e2e] ---- Memory(FLYWHEEL_STRUCTURED) ----");
  if (rows.length === 0) console.log("(无)");
  for (const r of rows) {
    console.log(`id=${r.id} title=${JSON.stringify(r.title)} content[0:40]=${JSON.stringify(r.content.slice(0, 40))}`);
  }
  console.log("[e2e] ---- FlywheelEvent(stage=CALL_LLM, platform:structured) ----");
  if (events.length === 0) console.log("(无)");
  for (const e of events) console.log(`targetStage=${e.targetStage} sourceTitle=${e.sourceTitle}`);
  console.log(`[e2e] job=${JSON.stringify(job)}`);

  // 6) 断言
  let ok = false;
  if (mode === "inject-length") {
    const truncEvent = events.some((e) => e.targetStage === "FAIL:TRUNCATED");
    ok = result.status === "FAILED" && rows.length === 0 && truncEvent && (result.outputCount ?? 0) === 0;
    console.log(
      `[e2e] 判据4 断言: status=FAILED(${result.status === "FAILED"}) 无落库(${rows.length === 0}) ` +
      `事件含FAIL:TRUNCATED(${truncEvent}) outputCount=0(${(result.outputCount ?? 0) === 0})`
    );
  } else if (mode === "inject-anthropic") {
    // 判据 5：请求逐字等于旧实现（URL / x-api-key / anthropic-version / 无 Bearer），且旧报文仍能落库
    const urlOk = capturedUrl === "https://api.minimaxi.com/anthropic/v1/messages";
    const hdrObj: Record<string, string> = JSON.parse(capturedHeaders || "{}");
    // maskHeaders 会把 x-api-key 脱敏成 "fake***"，这里只断言"存在且是我们给的假 key 前缀 + 旧协议头 + 没有 Bearer"
    const hdrOk =
      String(hdrObj["x-api-key"] || "").startsWith("fake") &&
      hdrObj["anthropic-version"] === "2023-06-01" &&
      !hdrObj["authorization"];
    ok = urlOk && hdrOk && result.status === "OK" && rows.length > 0;
    console.log(
      `[e2e] 判据5 断言(anthropic 回退): url=${capturedUrl} url逐字旧实现(${urlOk}) headers=${capturedHeaders} ` +
      `头符合旧实现(${hdrOk}) status=OK(${result.status === "OK"}) 落库>0(${rows.length > 0})`
    );
  } else if (mode === "inject-reasoning") {
    const bodyHit = rows.some((r) => r.content.includes("REASONING_FALLBACK_BODY_MARKER"));
    ok = result.status === "OK" && rows.length > 0 && bodyHit;
    console.log(
      `[e2e] 判据3 断言: status=OK(${result.status === "OK"}) 落库>0(${rows.length > 0}) ` +
      `正文含回落标记(${bodyHit})`
    );
  } else {
    ok = result.status === "OK" && rows.length > 0;
    console.log(`[e2e] 判据2 断言(真实通道): status=OK(${result.status === "OK"}) created>0(${rows.length > 0})`);
  }

  if (mode !== "real") {
    // 还原真 fetch（避免影响同进程后续）
    delete (globalThis as any).fetch;
  }
  await prisma.$disconnect();
  console.log(ok ? "[e2e] RESULT: PASS" : "[e2e] RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[e2e] 异常: " + (e?.stack || e?.message || String(e)));
  process.exit(1);
});
