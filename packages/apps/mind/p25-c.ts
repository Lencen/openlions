
import { fetchSourceText } from "./src/server/pipeline/source-fetcher";
async function main() {
  const r = await fetchSourceText({
    sessionUid: "test:sqlite:fake",
    agentId: "agent-h",
    source: "HERMES_SESSION",
    sourceId: "fake-session-id-xxx",
    strategy: ["sqlite_db"],
  });
  console.log("[C-sqlite_db]", r?.source, "messages:", r?.messageCount);
}
main().catch(e => console.error("ERR:", e.message));
