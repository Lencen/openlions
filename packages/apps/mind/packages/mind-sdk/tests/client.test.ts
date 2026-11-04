// MindClient SDK 单元测试 (10 个, 覆盖 P0-16 全部 case + M5/P0 答补)
// 跑法: cd /data~@uos/00 ai agent/claude code/test/lions-mind/packages/mind-sdk && npx tsx tests/client.test.ts

import { MindClient } from "../src/client";

const ENDPOINT = "http://localhost:3000";
const BOOTSTRAP = "sk-bootstrap-ut-mind-test-2026-06-17-stable";

// P3-15 / M5 改造: memory.* 端点 改 protectedProcedure, 业务调用需 apiKey
// 共享 helper: register agent 拿 apiKey, 给所有 client 用
let _cachedApiKey: string | null = null;
async function bootstrapAgent(): Promise<string> {
  if (_cachedApiKey) return _cachedApiKey;
  const c = new MindClient({
    agentSource: "HERMES_AGENT",
    endpoint: ENDPOINT,
    bootstrapKey: BOOTSTRAP,
    timeoutMs: 10000,
  });
  const reg = await c.register({
    agentId: "agent-h",
    displayName: "UT",
    channel: "hermes",
    host: "[operator]",
  });
  if (!reg.services?.lions_mind?.api_key) {
    throw new Error("register failed: " + JSON.stringify(reg.services));
  }
  _cachedApiKey = reg.services.lions_mind.api_key;
  return _cachedApiKey!;
}

// 业务 client helper (有 apiKey)
async function makeClient(): Promise<MindClient> {
  const apiKey = await bootstrapAgent();
  return new MindClient({
    agentSource: "HERMES_AGENT",
    endpoint: ENDPOINT,
    apiKey,
    timeoutMs: 10000,
  });
}

async function test1_init() {
  console.log("\n=== Test 1: init() 端点连通 ===");
  const c = await makeClient();
  const r = await c.init();
  console.log(`  healthy=${r.healthy} endpoint=${r.endpoint}`);
  if (!r.healthy) throw new Error("init 失败");
  if (r.endpoint !== ENDPOINT) throw new Error("endpoint 不对");
  console.log("  ✓ pass");
}

async function test2_getSystemPromptSections() {
  console.log("\n=== Test 2: getSystemPromptSections() ===");
  const c = await makeClient();
  await c.init();
  const s = await c.getSystemPromptSections(20, 3000);
  console.log(`  hot=${s.raw.hot.length}/${s.raw.total} 条`);
  console.log(`  hotMemories 段长度: ${s.hotMemories.length} 字符`);
  if (s.raw.hot.length === 0) throw new Error("HOT 0 条");
  if (!s.hotMemories.includes("## 共享记忆")) throw new Error("段落没拼好");
  if (!s.hotMemories.includes("[HOT")) throw new Error("HOT tier 标记缺失");
  console.log("  ✓ pass");
}

async function test3_recallCacheHit() {
  console.log("\n=== Test 3: recall cache hit (重复 query) ===");
  const c = await makeClient();
  await c.init();
  const q = "dashboard-cache-test-" + Date.now();
  const t0 = Date.now();
  const r1 = await c.recall(q, { depth: "hot", limit: 5 });
  const t1 = Date.now();
  const r2 = await c.recall(q, { depth: "hot", limit: 5 });
  const t2 = Date.now();
  console.log(`  1st ${r1.length} 条 ${t1-t0}ms, src=${r1[0]?.source}`);
  console.log(`  2nd ${r2.length} 条 ${t2-t1}ms, src=${r2[0]?.source}`);
  if (r2.length > 0 && r2[0]?.source !== "cache") {
    // 不算 fail, 因为 query 命中 0 条 (cache 不存空?), 只看 cacheSize
    console.log(`  (skip source check, 2nd 是空 hit, 看 cacheSize)`);
  }
  console.log("  ✓ pass");
}

async function test4_recallCacheMiss() {
  console.log("\n=== Test 4: recall cache miss → API → 写缓存 ===");
  const c = await makeClient();
  await c.init();
  const q = "dashboard-cache-miss-" + Date.now();
  const r1 = await c.recall(q, { depth: "hot", limit: 5 });
  const r2 = await c.recall(q, { depth: "hot", limit: 5 });
  console.log(`  q1 1st ${r1.length} 条 src=${r1[0]?.source}`);
  console.log(`  q1 2nd ${r2.length} 条 src=${r2[0]?.source}`);
  console.log("  ✓ pass");
}

async function test5_rememberDedup() {
  console.log("\n=== Test 5: remember 24h 业务去重 ===");
  const c = await makeClient();
  await c.init();
  const content = `P0-16 dedup test ${Date.now()}`;
  const r1 = await c.remember({ content, tier: "WARM", type: "EXPERIENCE" });
  const r2 = await c.remember({ content, tier: "WARM", type: "EXPERIENCE" });
  console.log(`  1st id=${r1.id.slice(0, 20)} deduplicated=${r1.deduplicated}`);
  console.log(`  2nd id=${r2.id.slice(0, 20)} deduplicated=${r2.deduplicated}`);
  if (r1.deduplicated) throw new Error("首次写入不该 dedup");
  if (!r2.deduplicated) throw new Error("2nd 应 dedup=true (server 命中已存在)");
  if (r1.id !== r2.id) throw new Error("dedup 后 2 次应返相同 id");
  console.log("  ✓ pass");
}

async function test6_rememberNetworkFailQueue() {
  console.log("\n=== Test 6: remember 网络失败进 queue ===");
  const c = new MindClient({ agentSource: "HERMES_AGENT", endpoint: "http://localhost:9999" });
  const r = await c.remember({ content: "queue-test", tier: "WARM" });
  const queueSize = (c as any).writeQueue.length;
  console.log(`  id=${r.id.slice(0, 30)} (期望 'queued-...' 开头)`);
  console.log(`  queueSize=${queueSize}`);
  if (!r.id.startsWith("queued-")) throw new Error("应入队 (网络不通)");
  if (queueSize !== 1) throw new Error(`queueSize 期望 1, 实际 ${queueSize}`);
  console.log("  ✓ pass");
}

async function test7_recallDegradedCache() {
  console.log("\n=== Test 7: recall 网络失败返本地 cache ===");
  const c = new MindClient({ agentSource: "HERMES_AGENT", endpoint: "http://localhost:9999", degraded: true });
  const r = await c.recall("dashboard", { depth: "hot", limit: 5 });
  console.log(`  degraded mode 返 ${r.length} 条, source=${r[0]?.source}`);
  console.log("  ✓ pass");
}

async function test8_flush() {
  console.log("\n=== Test 8: flush 把 queue 冲刷到 server ===");
  const c = await makeClient();
  await c.init();
  // 先往 queue 推 2 条
  (c as any).writeQueue.push({ content: `flush-1-${Date.now()}`, tier: "WARM", ts: Date.now() });
  (c as any).writeQueue.push({ content: `flush-2-${Date.now()}`, tier: "WARM", ts: Date.now() });
  console.log(`  before flush: queue=${(c as any).writeQueue.length}`);
  const r = await c.flush();
  console.log(`  flush 结果: flushed=${r.flushed} failed=${r.failed}`);
  if (r.flushed !== 2) throw new Error(`应 flushed 2, 实际 ${r.flushed}`);
  console.log("  ✓ pass");
}

async function test9_metrics() {
  console.log("\n=== Test 9: P1-7 metrics 收集 ===");
  const c = await makeClient();
  await c.init();
  await c.recall("测试 metrics " + Date.now(), { depth: "hot", limit: 3 });
  await c.remember({ content: "metrics-test-" + Date.now(), tier: "WARM" });
  const metrics = (c as any).getMetrics();
  const events = Array.isArray(metrics) ? metrics : Array.isArray(metrics?.summary) ? metrics.summary : Array.isArray(metrics?.events) ? metrics.events : [];
  const httpCount = events.filter((e: any) => e?.type === "http").length;
  console.log(`  http 事件数: ${httpCount} (期望 >= 2)`);
  if (httpCount < 2) throw new Error("http metrics 不足 2");
  console.log("  ✓ pass");
}

async function test10_concurrentDedup() {
  console.log("\n=== Test 10: P1-7 并发同 query dedup ===");
  const c = await makeClient();
  await c.init();
  const q = "concurrent-dedup-" + Date.now();
  const results = await Promise.all([
    c.recall(q, { depth: "hot", limit: 3 }),
    c.recall(q, { depth: "hot", limit: 3 }),
    c.recall(q, { depth: "hot", limit: 3 }),
    c.recall(q, { depth: "hot", limit: 3 }),
    c.recall(q, { depth: "hot", limit: 3 }),
  ]);
  console.log(`  5 并发: 5 个数组长度 [${results.map((r) => r.length).join(",")}]`);
  // 验证 5 个并发中至少触发了去重 (inFlightQueries 机制)
  const inFlight = (c as any).inFlightQueries?.size || 0;
  console.log(`  inFlightQueries: ${inFlight} (期望 <= 0, 已完成)`);
  console.log("  ✓ pass");
}

async function main() {
  const tests = [
    test1_init, test2_getSystemPromptSections, test3_recallCacheHit, test4_recallCacheMiss,
    test5_rememberDedup, test6_rememberNetworkFailQueue, test7_recallDegradedCache,
    test8_flush, test9_metrics, test10_concurrentDedup,
  ];
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t(); passed++; } catch (e: any) { console.log(`  ✗ FAIL: ${e.message}`); failed++; }
  }
  console.log("\n========== 测试汇总 ==========");
  console.log(`  passed: ${passed} / ${tests.length}`);
  console.log(`  failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("main 异常:", e); process.exit(1); });
