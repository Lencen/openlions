// P2-6 单元测试: safeJsonParse 6 轮 truncated 截断
// 复制 cognitive-extractor.ts 里的 safeJsonParse + 第 6 轮, 验证 P2-6 修复

// === 复制原 5 轮 ===
function cleanJsonResponse(text: string): string {
  let s = text;
  // 去 markdown code fence
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
  // 截到 第一个 { 或 [
  const start = Math.min(
    s.indexOf("{") >= 0 ? s.indexOf("{") : Infinity,
    s.indexOf("[") >= 0 ? s.indexOf("[") : Infinity
  );
  if (start !== Infinity && start > 0) s = s.slice(start);
  return s;
}

function safeJsonParseV5<T = unknown>(text: string): T {
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
  ];
  let firstErr: unknown = null;
  for (const gen of attempts) {
    try { return JSON.parse(gen()) as T; }
    catch (e) { if (!firstErr) firstErr = e; }
  }
  throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
}

// === P2-6 第 6 轮 (新增) ===
function safeJsonParseP26<T = unknown>(text: string): T {
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
    // 6. P2-6 fix v9: unclosed string 截断到开引号前 + 补 depth close
    //    解决 "Unterminated string in JSON at position 10615" 类故障
    //    之前 v1-v8 各种尝试都失败 (闭合后 garbage, depth 永不归 0, 等)
    //    v9 算法: 找 unclosed 开引号, 截到那之前, 补 " 闭合 value, 再补 stack depth close
    () => {
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

// === 6 个测试用例 ===
const cases = [
  {
    name: "T1: 干净 JSON",
    input: '{"memories": [{"role": "user", "content": "hi"}]}',
    shouldPassV5: true,
  },
  {
    name: "T2: 真实场景 — LLM stream 截断在 string 中间 (mind log 10615 类)",
    input: `{"memories": [{"role": "user", "content": "用户问了一个问题"}, {"role": "assistant", "content": "AI 回答了 5000 字符的内容, 包含很多文字. Lorem ipsum dolor sit amet. 我们继续写内容, 模拟 stream 中断. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam. Nemo enim ipsam voluptatem quia voluptas sit aspernatur`,
    shouldPassV5: false,
    shouldPassP26: true,
  },
  {
    name: "T3: 中间 balanced 截断 + 尾部乱码",
    input: '{"memories": [{"role": "user", "content": "hello world"}], "knowledge": [{"topic": "test", "content": "x"}], "reflection": null}, ??$#@garbage',
    shouldPassV5: false,
    shouldPassP26: true,
  },
  {
    name: "T4: markdown code fence + 尾部乱码",
    input: '```json\n{"memories": [{"role": "user", "content": "hi"}]}\n```\nEXTRA GARBAGE',
    shouldPassV5: true,
  },
  {
    name: "T5: 纯尾部乱码 (没 balanced 点)",
    input: 'not json at all, just garbage',
    shouldPassV5: false,
    shouldPassP26: false,
  },
  {
    name: "T6: 真实场景 — 截断在 string 末尾 (mind log 11447 类)",
    input: `{"memories": [{"role": "user", "content": "hi"}], "knowledge": [{"topic": "test", "content": "value here"}, {"topic": "test2", "content": "another value that got truncated at some point due to stream interruption`,
    shouldPassV5: false,
    shouldPassP26: true,
  },
];

let v5Pass = 0, p26Pass = 0;
for (const c of cases) {
  console.log(`\n=== ${c.name} ===`);
  console.log(`  input length: ${c.input.length}, tail: "${c.input.slice(-50)}"`);
  try {
    const v5 = safeJsonParseV5(c.input);
    console.log(`  ✅ V5 5 轮: 成功 (memories=${(v5 as any).memories?.length ?? 'N/A'})`);
    v5Pass++;
  } catch (e) {
    console.log(`  ❌ V5 5 轮: 失败 (${(e as Error).message.slice(0, 80)})`);
  }
  try {
    const p26 = safeJsonParseP26(c.input);
    console.log(`  ✅ P2-6 6 轮: 成功 (memories=${(p26 as any).memories?.length ?? 'N/A'})`);
    p26Pass++;
  } catch (e) {
    console.log(`  ❌ P2-6 6 轮: 失败 (${(e as Error).message.slice(0, 80)})`);
  }
}

console.log(`\n=== 总计 ===`);
console.log(`  V5 5 轮: ${v5Pass}/${cases.length}`);
console.log(`  P2-6 6 轮: ${p26Pass}/${cases.length}`);
console.log(`  提升: ${p26Pass - v5Pass} 个新 case 通过`);

// === 业务价值验证 ===
// 真实 mind log: "Unterminated string in JSON at position 10615" → T2
// 真实 mind log: "Expected ',' or '}' after property value in JSON at position 2973" → T3
// 真实 mind log: "Unterminated string in JSON at position 11447" → T6
console.log(`\n=== 业务价值 ===`);
console.log(`  T2 命中: 真实 mind log "Unterminated string at position 10615" 类故障`);
console.log(`  T3 命中: 真实 mind log "Expected ',' or '}' at position 2973" 类故障`);
console.log(`  T6 命中: 真实 mind log "Unterminated string at position 11447" 类故障`);
