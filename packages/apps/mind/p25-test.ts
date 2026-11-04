
import { fetchSourceText } from "./src/server/pipeline/source-fetcher";

async function main() {
  console.log("=== P2-5 fetchSourceText 验证 (v2) ===");
  // 测试 1: B-hermes 命中
  const r1 = await fetchSourceText({
    sessionUid: "agent-h:hermes_session:20260617_112451_6af8b9",
    agentId: "agent-h",
    source: "HERMES_SESSION",
    sourceId: "20260617_112451_6af8b9",
    sourceType: "hermes",
  });
  console.log("[B-hermes]", r1?.source, "messages:", r1?.messageCount);

  // 测试 2: 旧 strategy 兼容
  const r2 = await fetchSourceText({
    sessionUid: "test:cli:20260617_112451_6af8b9",
    agentId: "agent-h",
    source: "HERMES_SESSION",
    sourceId: "20260617_112451_6af8b9",
    strategy: ["raw_payload", "claude_transcript", "hermes_state", "hermes_session_file"],
  });
  console.log("[legacy strategy]", r2?.source, "messages:", r2?.messageCount);

  // 测试 3: 不存在
  const r3 = await fetchSourceText({
    sessionUid: "test:nonexistent",
    agentId: "agent-h",
    source: "HERMES_SESSION",
    sourceId: "nonexistent_xxx",
    sourceType: "hermes",
  });
  console.log("[not found]", r3);

  // 测试 4: sourceType 推断 (不显式传, 推断 hermes)
  const r4 = await fetchSourceText({
    sessionUid: "agent-h:cli:20260617_112451_6af8b9",
    agentId: "agent-h",
    source: "cli",
    sourceId: "20260617_112451_6af8b9",
    // 不传 sourceType, 推断
  });
  console.log("[infer cli→hermes]", r4?.source, "messages:", r4?.messageCount);

  // 测试 5: sourceType 推断 (claude)
  const r5 = await fetchSourceText({
    sessionUid: "test:claude:fake-uuid",
    agentId: "agent-g",
    source: "CLAUDE_CONVERSATION",
    sourceId: "520d1f52-7654-4262-8c0a-eecb1e277b0b",
    // 不传 sourceType
  });
  console.log("[infer claude]", r5?.source, "messages:", r5?.messageCount);
}

main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
