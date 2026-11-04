// P2-8 单元测试: safeJsonParse 空字符串 case (新增)
// 复制 cognitive-extractor.ts 里的 safeJsonParse V5 + P2-6 第 6 轮 + P2-8 空串检查, 验证修复
// 端到端发现: session app 47 PENDING 重跑时 LLM 返回空, 全 FAILED "Unexpected end of JSON input"

// === 复用 P2-6 测试的 cleanJsonResponse ===
function cleanJsonResponse(text: string): string {
  let s = text;
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
  const start = Math.min(
    s.indexOf("{") >= 0 ? s.indexOf("{") : Infinity,
    s.indexOf("[") >= 0 ? s.indexOf("[") : Infinity
  );
  if (start !== Infinity && start > 0) s = s.slice(start);
  return s;
}

// === P2-6 第 6 轮 (复制原版, 没空串检查) ===
function safeJsonParseV6NoEmpty<T = unknown>(text: string): T {
  const cleaned = cleanJsonResponse(text);
  const attempts: Array<() => string> = [
    () => cleaned,
    () => {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      return end > 0 ? cleaned.slice(0, end) : cleaned;
    },
    () => cleaned.replace(/,(\s*[}\]])/g, "$1").replace(/'/g, '"'),
    () => {
      let s = cleaned.replace(/[""]/g, '\\"').replace(/['']/g, "'");
      s = s.replace(/,(\s*[}\]])/g, "$1");
      return s;
    },
    () => {
      const start = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      return start >= 0 && last > start ? cleaned.slice(start, last + 1) : cleaned;
    },
    () => {
      // v9 第 6 轮: unclosed string 截断
      let inStr = false, esc = false;
      const unclosedOpens: number[] = [];
      for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') {
          if (inStr) {
            if (unclosedOpens.length > 0) unclosedOpens.pop();
          } else {
            unclosedOpens.push(i);
          }
          inStr = !inStr;
        }
      }
      let candidate = cleaned;
      if (inStr && unclosedOpens.length > 0) {
        const lastUnclosed = unclosedOpens[unclosedOpens.length - 1];
        candidate = cleaned.slice(0, lastUnclosed) + '""';
      }
      const stack: string[] = [];
      let esc2 = false, inStr2 = false;
      for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (esc2) { esc2 = false; continue; }
        if (ch === "\\") { esc2 = true; continue; }
        if (ch === '"') { inStr2 = !inStr2; continue; }
        if (inStr2) continue;
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") {
          const top = stack[stack.length - 1];
          if (top && ((top === "{" && ch === "}") || (top === "[" && ch === "]"))) {
            stack.pop();
          }
        }
      }
      let closer = "";
      for (let i = stack.length - 1; i >= 0; i--) {
        closer += stack[i] === "[" ? "]" : "}";
      }
      candidate = candidate + closer;
      return candidate;
    },
  ];
  let firstErr: unknown = null;
  for (const gen of attempts) {
    try { return JSON.parse(gen()) as T; }
    catch (e) { if (!firstErr) firstErr = e; }
  }
  throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
}

// === P2-8 第 7 轮 (新增空字符串检查) ===
function safeJsonParseP28<T = unknown>(text: string): T {
  const cleaned = cleanJsonResponse(text);
  // P2-8 fix: 空字符串 case → 直接抛清晰错 (而不是 "Unexpected end of JSON input")
  if (!cleaned) {
    throw new Error('safeJsonParse: LLM 返回空 response (cleaned.length=0), 无法解析为 JSON');
  }
  // 复用 P2-6 第 6 轮 attempts (跟 V6NoEmpty 一样)
  return safeJsonParseV6NoEmpty(cleaned);
}

// === T7 测试用例: 空字符串场景 ===
const cases = [
  {
    name: "T7-A: 完全空字符串 (LLM 返回空 response)",
    input: "",
    // V6 没空串检查 → JSON.parse("") 抛 "Unexpected end of JSON input" → 失败
    v6ShouldFail: true,
    v6ErrorContains: "Unexpected end of JSON",
    // P2-8 加空串检查 → 直接抛清晰错
    p28ShouldFail: true,
    p28ErrorContains: "LLM 返回空 response",
  },
  {
    name: "T7-B: 只有空白字符 (trim 后空)",
    input: "   \n  \t  ",
    v6ShouldFail: true,
    p28ShouldFail: true,
    p28ErrorContains: "LLM 返回空 response",
  },
  {
    name: "T7-C: 只有 markdown code fence (内容空)",
    input: "```json\n```",
    v6ShouldFail: true,
    p28ShouldFail: true,
    p28ErrorContains: "LLM 返回空 response",
  },
  // === 老 P2-6 T2/T6 sanity (确认 P2-8 不破坏 P2-6 修复) ===
  {
    name: "T2 (P2-6 unterminated): 不被 P2-8 空串检查影响",
    input: `{"memories": [{"role": "user", "content": "我们继续写内容, 模拟 stream 中断. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam. Nemo enim ipsam voluptatem quia voluptas sit aspernatur`,
    v6ShouldPass: true,
    p28ShouldPass: true,
  },
  {
    name: "T6 (P2-6 unterminated at 11447): 不被 P2-8 空串检查影响",
    input: `{"memories": [{"role": "user", "content": "hi"}], "knowledge": [{"topic": "test", "content": "value here"}, {"topic": "test2", "content": "another value that got truncated at some point due to stream interruption`,
    v6ShouldPass: true,
    p28ShouldPass: true,
  },
];

let v6Pass = 0, p28Pass = 0;
let v6Correct = 0, p28Correct = 0;

console.log("=== P2-8 safeJsonParse 空字符串 case 测试 ===\n");

for (const c of cases) {
  console.log(`--- ${c.name} ---`);
  console.log(`  input length: ${c.input.length}`);
  if (c.input.length < 50) console.log(`  input: "${c.input}"`);

  // V6 (老, 没空串检查)
  try {
    const r = safeJsonParseV6NoEmpty(c.input);
    if (c.v6ShouldPass) {
      console.log(`  ✅ V6 期望 pass → 通过 (v6Correct)`);
      v6Correct++;
    } else if (c.v6ShouldFail) {
      console.log(`  ❌ V6 期望 fail → 但成功了 (BUG)`);
    } else {
      console.log(`  ❓ V6 无期望 → 通过`);
    }
    v6Pass++;
  } catch (e: any) {
    const msg = e.message;
    if (c.v6ShouldPass) {
      console.log(`  ❌ V6 期望 pass → 失败: ${msg.slice(0, 80)} (v6Incorrect)`);
    } else if (c.v6ShouldFail) {
      const contains = c.v6ErrorContains ? msg.includes(c.v6ErrorContains) : true;
      if (contains) {
        console.log(`  ✅ V6 期望 fail → 抛 "${msg.slice(0, 60)}" (v6Correct)`);
        v6Correct++;
      } else {
        console.log(`  ❌ V6 期望 fail → 抛 "${msg.slice(0, 60)}" 但期望含 "${c.v6ErrorContains}" (v6Incorrect)`);
      }
    }
  }

  // P2-8 (新, 加空串检查)
  try {
    const r = safeJsonParseP28(c.input);
    if (c.p28ShouldPass) {
      console.log(`  ✅ P2-8 期望 pass → 通过 (p28Correct)`);
      p28Correct++;
    } else if (c.p28ShouldFail) {
      console.log(`  ❌ P2-8 期望 fail → 但成功了 (BUG)`);
    } else {
      console.log(`  ❓ P2-8 无期望 → 通过`);
    }
    p28Pass++;
  } catch (e: any) {
    const msg = e.message;
    if (c.p28ShouldPass) {
      console.log(`  ❌ P2-8 期望 pass → 失败: ${msg.slice(0, 80)} (p28Incorrect)`);
    } else if (c.p28ShouldFail) {
      const contains = c.p28ErrorContains ? msg.includes(c.p28ErrorContains) : true;
      if (contains) {
        console.log(`  ✅ P2-8 期望 fail → 抛 "${msg.slice(0, 60)}" (p28Correct)`);
        p28Correct++;
      } else {
        console.log(`  ❌ P2-8 期望 fail → 抛 "${msg.slice(0, 60)}" 但期望含 "${c.p28ErrorContains}" (p28Incorrect)`);
      }
    }
  }
  console.log();
}

console.log("=== 总计 ===");
console.log(`  V6 (老):   ${v6Correct}/${cases.length} correct (${v6Pass}/${cases.length} 通过)`);
console.log(`  P2-8 (新): ${p28Correct}/${cases.length} correct (${p28Pass}/${cases.length} 通过)`);
console.log(`  提升: P2-8 把空字符串 case 报成清晰错 (区别于 JSON 损坏), 不破坏 P2-6 修复`);
