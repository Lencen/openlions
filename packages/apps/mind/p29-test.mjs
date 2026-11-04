// P2-9 v11 safeJsonParse 测试 - 纯 ESM .mjs (绕过 tsx + node v10 兼容问题)

// === Fixtures (跟 cognitive-extractor.ts 真实 bad-data case 对应) ===
// T1: 类似 3fdfcb "Expected ',' or '}' at 7504" - 中间 property value 后断
const T1_broken = '{"memories":[{"content":"hello"},{"content":"wor';
const T1_expected = { memories: [{ content: 'hello' }] };

// T2: 类似 917120 "Expected double-quoted property name at 11038" - key 缺引号
const T2_broken = '{"memories":[{"content":"hello"},{"content';
const T2_expected = { memories: [{ content: 'hello' }] };

// T3: 类似 "Expected ',' or ']' at 6925" - array 末尾断
const T3_broken = '{"array":[1,2,3,4,5,6,7,8,9,10,11,12';
const T3_expected = { array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };

// T4: 类似 772e28 "Unterminated string at 10993" - 深位 string 未闭合
const T4_broken = '{"memories":[{"content":"hello world';
const T4_expected = { memories: [{ content: 'hello world' }] };

// T5: 类似 c264b2 "Expected ',' or '}' at 2553" - 深位中段断
const T5_broken = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6';
const T5_expected = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };

const T6_empty = '';
const T7_v9 = '{"a": "hello';

// === v11 算法 ===
function safeJsonParseV11(llmResponse) {
  const cleaned = llmResponse.trim().replace(/```json|```/g, '').trim();
  if (!cleaned) throw new Error('safeJsonParse: LLM 返回空 response');

  const v9Attempts = [
    cleaned,
    cleaned.endsWith('}') ? cleaned : cleaned + '}',
    cleaned.endsWith(']') ? cleaned : cleaned + ']',
    closeUnterminatedString(cleaned),
    ensureTrailingBrace(closeUnterminatedString(cleaned)),
  ];
  for (const attempt of v9Attempts) {
    try { return JSON.parse(attempt); } catch (e) {}
  }

  const err = getParseError(cleaned);
  if (err && err.position > 0) {
    const pos = err.position;
    const truncated = cleaned.substring(0, pos).trim();
    console.log('[DBG] pos=' + pos + ' truncated="' + truncated + '"');
    if (isValidPrefix(truncated)) {
      try { return JSON.parse(truncated + '}'); } catch (e) {}
      try { return JSON.parse(truncated + ']'); } catch (e) {}
    }
    const lastSep = findLastSeparator(cleaned, pos);
    console.log('[DBG] strategy B lastSep=' + lastSep);
    if (lastSep > 0) {
      const truncated2 = cleaned.substring(0, lastSep).trim();
      if (isValidPrefix(truncated2)) {
        try { return JSON.parse(truncated2 + '}'); } catch (e) {}
        try { return JSON.parse(truncated2 + ']'); } catch (e) {}
      }
    }
    const lastKV = findLastCompleteKeyValue(cleaned, pos);
    console.log('[DBG] strategy C lastKV=' + lastKV);
    if (lastKV > 0) {
      try { return JSON.parse(cleaned.substring(0, lastKV) + '}'); } catch (e) {}
    }
  }

  throw new Error('safeJsonParse: 所有 8 轮 fallback 都失败, 原始: ' + cleaned.substring(0, 200));
}

function closeUnterminatedString(s) {
  const lastQuote = s.lastIndexOf('"');
  if (lastQuote > 0 && !s.endsWith('"')) return s + '"';
  return s;
}
function ensureTrailingBrace(s) {
  return s.endsWith('}') ? s : s + '}';
}
function getParseError(json) {
  try { JSON.parse(json); return null; }
  catch (e) {
    const m = e.message.match(/at position (\d+)/);
    return m ? { position: parseInt(m[1]), message: e.message } : null;
  }
}
function findLastSeparator(json, beforePos) {
  for (let i = beforePos - 1; i >= 0; i--) {
    const ch = json[i];
    if (ch === ',' || ch === ':' || ch === '"') return i + 1;
  }
  return -1;
}
function isValidPrefix(prefix) {
  if (!prefix) return false;
  return /^[{\[]/.test(prefix) && !/[^\\]"[}\]]?\s*$/.test(prefix);
}
function findLastCompleteKeyValue(json, beforePos) {
  for (let i = beforePos - 1; i >= 1; i--) {
    if (json[i] === ',') {
      const candidate = json.substring(i + 1, beforePos).trim();
      if (isCompleteValue(candidate)) return i;
    }
  }
  return -1;
}
function isCompleteValue(s) {
  if (!s) return false;
  if (/^"[^"]*"$/.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/^(true|false|null)$/.test(s)) return true;
  if (/^[{\[]/.test(s)) return isBalanced(s);
  return false;
}
function isBalanced(s) {
  let depth = 0, inString = false, escape = false;
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

// === Tests ===
const tests = [
  { name: 'T1 末尾截断 (7504 类)', input: T1_broken, expected: T1_expected },
  { name: 'T2 key 缺引号 (11038 类)', input: T2_broken, expected: T2_expected },
  { name: 'T3 array 末尾断 (6925 类)', input: T3_broken, expected: T3_expected },
  { name: 'T4 string 未闭合 (10993 类)', input: T4_broken, expected: T4_expected },
  { name: 'T5 深位中段断 (2553 类)', input: T5_broken, expected: T5_expected },
  { name: 'T6 空字符串 (P2-8 回归)', input: T6_empty, expected: 'THROW' },
  { name: 'T7 v9 unterminated (P2-6 回归)', input: T7_v9, expected: { a: 'hello' } },
];

console.log('=== P2-9 safeJsonParse v11 测试 ===\n');
let pass = 0, fail = 0;
for (const t of tests) {
  try {
    const result = safeJsonParseV11(t.input);
    const ok = JSON.stringify(result) === JSON.stringify(t.expected);
    if (ok) { pass++; console.log('✅ ' + t.name + ': ' + JSON.stringify(result)); }
    else { fail++; console.log('❌ ' + t.name + ': 期望 ' + JSON.stringify(t.expected) + ', 实际 ' + JSON.stringify(result)); }
  } catch (e) {
    if (t.expected === 'THROW') { pass++; console.log('✅ ' + t.name + ': 正确抛错 "' + e.message + '"'); }
    else { fail++; console.log('❌ ' + t.name + ': 不应抛错, 但抛了 "' + e.message + '"'); }
  }
}
console.log('\n=== 结果: ' + pass + '/' + (pass+fail) + ' 通过 ===');