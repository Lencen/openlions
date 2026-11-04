// P2-9 单元测试: safeJsonParse v11 position 锚定修复算法 (新增)
// 复制 cognitive-extractor.ts 里的 safeJsonParse V10 + P2-9 第 8 轮, 验证修复
// 端到端发现: 8 批跑下来 7 个 JSON 损坏 case (5 "Expected , or }" + 1 "Expected double-quoted" + 1 "Unterminated")
// 算法思路: 利用 JSON.parse 报的 position 信息, 截断到 position 之前, 补全末尾
//
// 注意: 跟 p26-test.ts / p28-test.ts 一样, 因为 tsx 4.22+ 跟 dev node v10 不兼容,
// 这个文件用于记录算法意图 + fixture, 不直接跑 (跟 P2-8 一样, 端到端验证替代单测)
//
// Fixture 策略: 不用真实 LLM 输出 (造不出来), 用构造的损坏 JSON 模拟

// P2-9 fixture (合成)
// T1: "Expected ',' or '}' at position 25" — JSON 中间截断 (类似 3fdfcb/7504)
const T1_broken = '{"memories":[{"content":"hello"},{"content":"wor';  // position 25 = 最后 '"' 后
const T1_expected = { memories: [{ content: 'hello' }] };

// T2: "Expected double-quoted property name at position 35" — key 缺引号 (类似 917120/11038)
const T2_broken = '{"memories":[{"content":"hello"},{"content';  // position 35 = " 后
const T2_expected = { memories: [{ content: 'hello' }] };

// T3: "Expected ',' or ']' at position 40" — array 中间截断 (类似 6925)
const T3_broken = '{"array":[1,2,3,4,5,6,7,8,9,10,11,12,';  // position 40 = , 后
const T3_expected = { array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };

// T4: "Unterminated string at position 20" — string 未闭合 (类似 772e28/10993 简化版)
const T4_broken = '{"memories":[{"content":"hello world';  // position 20 = " 后
const T4_expected = { memories: [{ content: 'hello world' }] };

// T5: "Expected ',' or '}' at position 50" — 更深截断 (类似 2553)
const T5_broken = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g"';  // position 50 = " 后
const T5_expected = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };

// T6 (P2-8 老 case): 空字符串
const T6_empty = '';

// T7: P2-6 老 case: unterminated 完整 (v9 第 4 轮)
const T7_v9 = '{"a": "hello';  // 末尾补 " + }

// === 算法 v11 ===

function safeJsonParseV11(llmResponse: string): any {
  const cleaned = llmResponse.trim().replace(/```json|```/g, '').trim();
  if (!cleaned) throw new Error('safeJsonParse: LLM 返回空 response');

  // v9 5 轮 fallback (保留)
  const v9Attempts = [
    cleaned,
    cleaned.endsWith('}') ? cleaned : cleaned + '}',
    cleaned.endsWith(']') ? cleaned : cleaned + ']',
    closeUnterminatedString(cleaned),
    ensureTrailingBrace(closeUnterminatedString(cleaned)),
  ];
  for (const attempt of v9Attempts) {
    try { return JSON.parse(attempt); } catch {}
  }

  // v11 第 8 轮: position 锚定修复 (新增)
  const err = getParseError(cleaned);
  if (err && err.position > 0) {
    const pos = err.position;

    // 策略 A: 截断到 position, 补 }
    const truncated = cleaned.substring(0, pos).trim();
    if (isValidPrefix(truncated)) {
      try { return JSON.parse(truncated + '}'); } catch {}
      try { return JSON.parse(truncated + ']'); } catch {}
    }

    // 策略 B: 找上一个 separator, 截断
    const lastSep = findLastSeparator(cleaned, pos);
    if (lastSep > 0) {
      const truncated2 = cleaned.substring(0, lastSep).trim();
      if (isValidPrefix(truncated2)) {
        try { return JSON.parse(truncated2 + '}'); } catch {}
        try { return JSON.parse(truncated2 + ']'); } catch {}
      }
    }

    // 策略 C: 找最后一个完整 key-value 对
    const lastKV = findLastCompleteKeyValue(cleaned, pos);
    if (lastKV > 0) {
      try { return JSON.parse(cleaned.substring(0, lastKV) + '}'); } catch {}
    }
  }

  throw new Error(`safeJsonParse: 所有 8 轮 fallback 都失败, 原始: ${cleaned.substring(0, 200)}`);
}

// === 辅助函数 ===

function closeUnterminatedString(s: string): string {
  // v9 算法: 在最后一个 " 后补 "
  const lastQuote = s.lastIndexOf('"');
  if (lastQuote > 0 && !s.endsWith('"')) {
    // 检查 lastQuote 是不是 string 开始 (简化: 假设是)
    return s + '"';
  }
  return s;
}

function ensureTrailingBrace(s: string): string {
  return s.endsWith('}') ? s : s + '}';
}

function getParseError(json: string): { position: number; message: string } | null {
  try {
    JSON.parse(json);
    return null;
  } catch (e: any) {
    const msg = e.message;
    const m = msg.match(/at position (\d+)/);
    return m ? { position: parseInt(m[1]), message: msg } : null;
  }
}

function findLastSeparator(json: string, beforePos: number): number {
  for (let i = beforePos - 1; i >= 0; i--) {
    const ch = json[i];
    if (ch === ',' || ch === ':' || ch === '"') return i + 1;
  }
  return -1;
}

function isValidPrefix(prefix: string): boolean {
  if (!prefix) return false;
  return /^[{\[]/.test(prefix) && !/[^\\]"[}\]]?\s*$/.test(prefix);
}

function findLastCompleteKeyValue(json: string, beforePos: number): number {
  for (let i = beforePos - 1; i >= 1; i--) {
    if (json[i] === ',') {
      const candidate = json.substring(i + 1, beforePos).trim();
      if (isCompleteValue(candidate)) return i;
    }
  }
  return -1;
}

function isCompleteValue(s: string): boolean {
  if (!s) return false;
  if (/^"[^"]*"$/.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/^(true|false|null)$/.test(s)) return true;
  if (/^[{\[]/.test(s)) return isBalanced(s);
  return false;
}

function isBalanced(s: string): boolean {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return depth === 0 && !inString;
}

// === 测试用例 ===

const tests = [
  { name: 'T1 末尾截断', input: T1_broken, expected: T1_expected },
  { name: 'T2 key 缺引号', input: T2_broken, expected: T2_expected },
  { name: 'T3 array 中间断', input: T3_broken, expected: T3_expected },
  { name: 'T4 string 未闭合', input: T4_broken, expected: T4_expected },
  { name: 'T5 深位截断', input: T5_broken, expected: T5_expected },
  { name: 'T6 空字符串 (P2-8)', input: T6_empty, expected: 'THROW' },
  { name: 'T7 v9 unterminated (P2-6)', input: T7_v9, expected: { a: 'hello' } },
];

console.log('=== P2-9 safeJsonParse v11 测试 ===\n');
let pass = 0, fail = 0;
for (const t of tests) {
  try {
    const result = safeJsonParseV11(t.input);
    const ok = JSON.stringify(result) === JSON.stringify(t.expected);
    if (ok) { pass++; console.log(`✅ ${t.name}`); }
    else { fail++; console.log(`❌ ${t.name}: 期望 ${JSON.stringify(t.expected)}, 实际 ${JSON.stringify(result)}`); }
  } catch (e: any) {
    if (t.expected === 'THROW') { pass++; console.log(`✅ ${t.name}: 正确抛错 "${e.message}"`); }
    else { fail++; console.log(`❌ ${t.name}: 不应抛错, 但抛了 "${e.message}"`); }
  }
}
console.log(`\n=== 结果: ${pass}/${pass+fail} 通过 ===`);