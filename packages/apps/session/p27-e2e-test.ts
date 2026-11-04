// P2-7 端到端验证: scanSource 真抓 hermes 跟 claude session, sourceType 正确
// 2026-10-14 修: 原 import 指向作者本机绝对路径
//   "~@uos/00 ai agent/claude code/test/lions/..." —— 该路径在本仓库不存在 (TS2307),
//   且因为模块解析失败, loadScanSources 退化成 any, 连带产生 TS7006。改为相对本文件的路径后,
//   ScanSource 类型恢复, 脚本在本机可真正运行 (脚本语义/行为不变)。
import { scanSource, loadScanSources } from "./lib/scan-sources";

async function main() {
  console.log("=== P2-7 端到端验证: scanSource sourceType 正确性 ===\n");
  const sources = loadScanSources();
  console.log(`加载 ${sources.length} 个 source config:`);
  for (const s of sources) {
    console.log(`  agent=${s.agentId} sourceType=${s.sourceType} path=${s.path.slice(0, 80)}...`);
  }
  console.log();
  for (const src of sources) {
    console.log(`--- 抓 ${src.agentId} (sourceType=${src.sourceType}) ---`);
    try {
      const r = scanSource(src, 0);
      console.log(`  sessions=${r.sessions.length}, messages=${r.messages.length}`);
      if (r.sessions.length > 0) {
        const types = [...new Set(r.sessions.map(s => s.sourceType))];
        console.log(`  sourceType 分布: ${JSON.stringify(types)}`);
        if (types.length > 1 || (types.length === 1 && types[0] !== src.sourceType)) {
          console.error(`  ❌ sourceType 不匹配! 期望 ${src.sourceType}, 实际 ${types}`);
        } else if (types[0] === src.sourceType) {
          console.log(`  ✅ sourceType 正确 (${types[0]})`);
        }
      } else {
        console.log(`  ⚠️ 0 sessions (path 不存在或源空)`);
      }
    } catch (e) {
      // 2026-10-14: strict 下 catch 变量是 unknown (useUnknownInCatchVariables), 与仓库其它处写法一致
      //   (见 app/api/v1/sessions/[sessionUid]/route.ts:116)。
      console.error(`  ❌ 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
main().catch(console.error);