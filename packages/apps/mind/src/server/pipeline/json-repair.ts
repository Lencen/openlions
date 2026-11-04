/**
 * json-repair.ts — LLM 输出 JSON 的宽容解析 (2026-09-11 第 29 轮)
 *
 * 为什么: structure-fragments 的 LLM 输出解析是裸 JSON.parse, 实测会因**输出畸变**整主题失败。
 *   实测到的畸变形态(均来自 STRUCTURE_DEBUG_RAW_DIR 落盘的原始返回, 非推测):
 *   1. **markdown 代码块包裹**: theme='故障排查' 一次运行里 7/7 个 chunk 的原始返回都是
 *      \`\`\`json ... \`\`\` —— 裸 JSON.parse 100% 失败。
 *   2. **尾随内容**: "Unexpected non-whitespace character after JSON at position 1050"
 *      —— 前 1050 字符是完整合法 JSON, 后面还跟着解释文字/第二个对象。
 *   3. **字符串值内部未转义的 ASCII 双引号**: "Expected ',' or '}' after property value at
 *      position 1824" —— 原文是 系统级任务(如"建立完整前端回归测试")自评过严, 中文强调用了裸 ",
 *      解析器认为字符串提前结束。这一形态 repairJson 修不了。
 *   4. 未转义换行 / 智能引号 / 尾逗号 / 缺失收尾括号(repairJson 原生覆盖)。
 *
 * 实现说明: repairJson 是 global-organizer.ts 里 repairJson 的**同源副本**(逐行一致), 刻意不直接
 *   import 那个模块 —— 避免为一个纯函数把 global-organizer 的整条依赖链拉进 structure-fragments。
 *   两处同源是已知重复, 若要合并, 应把 global-organizer 也改为 import 本文件(未做, 避免动在跑模块)。
 */
export function repairJson(raw: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      if (ch === "\u201c" || ch === "\u201d") { out += '"'; continue; }
      out += ch;
    } else {
      if (ch === "\u201c" || ch === "\u201d") { out += '"'; continue; }
      if (ch === "\u2018" || ch === "\u2019") { out += "'"; continue; }
      if (ch === ",") {
        let j = i + 1;
        while (j < raw.length && /\s/.test(raw[j])) j++;
        if (raw[j] === "}" || raw[j] === "]") continue;
      }
      out += ch;
    }
  }
  if (inStr) out += '"';
  let openBrackets = 0, openBraces = 0, inStr2 = false, escaped2 = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (escaped2) { escaped2 = false; continue; }
    if (ch === '\\') { escaped2 = true; continue; }
    if (ch === '"') { inStr2 = !inStr2; continue; }
    if (inStr2) continue;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
  }
  out = out.replace(/,\s*$/, '');
  for (let i = 0; i < openBrackets; i++) out += ']';
  for (let i = 0; i < openBraces; i++) out += '}';
  return out;
}

/**
 * 修复"字符串值内部未转义的 ASCII 双引号"(实测形态 3)。
 *
 * 判据(有依据, 且对合法 JSON 恒等): 处于字符串中遇到 \`"\` 时, 看其后**第一个非空白字符** ——
 *   若为 , } ] : (或已到结尾), 说明这是**闭合引号**; 否则(如后跟 建/注/汉 等正文字符)只能是内层引号,
 *   转义为 \\\`"\` 并继续留在字符串里。
 *   合法 JSON 中, 字符串闭合后必然紧跟 , } ] : 之一(键的闭合引号后跟 :), 故该函数对合法输入是恒等变换;
 *   但为稳妥, 调用方**只在严格 JSON.parse 失败后**才走这条路径。
 */
export function escapeInnerQuotes(raw: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let keyPos = false;        // 当前字符串是否处于"键"位置(由 { 或 , 引导)
  let lastStructural = "";   // 字符串外最后一个非空白字符, 用于判断键/值位置
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch !== '"') {
      if (!inStr && !/\s/.test(ch)) lastStructural = ch;
      out += ch;
      continue;
    }
    if (!inStr) {
      inStr = true;
      keyPos = lastStructural === "{" || lastStructural === ",";
      out += ch;
      continue;
    }
    let j = i + 1;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    const next = raw[j];
    // 闭合引号后面必然紧跟 , } ] 之一; 冒号只可能是**键**的闭合引号(值的后面不可能跟冒号)。
    // 这一条把 \`注意"此处":需人工确认\` 这类"内层引号恰好后跟冒号"的刁钻情形也覆盖住(实测用例 3b)。
    const closes = next === undefined || next === "," || next === "}" || next === "]"
      || (next === ":" && keyPos);
    if (closes) { inStr = false; out += ch; }
    else { out += '\\"'; }
  }
  return out;
}

/** 从 s 中提取所有**平衡**的 JSON 值子串 ({...} 或 [...]), 跳过字符串内部的括号。 */
function balancedValues(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { out.push(s.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  return out;
}

/** 剥掉 markdown 代码块包裹(实测形态 1: 7/7 个 chunk 都是这种)。 */
function stripFences(s: string): string {
  let t = String(s || "").trim();
  if (t.startsWith("\u0060\u0060\u0060")) t = t.replace(/^\u0060\u0060\u0060(?:json)?\n?/, "").replace(/\n?\u0060\u0060\u0060$/, "").trim();
  return t;
}

/**
 * 宽松解析。顺序(每步都基于实测形态, 逐级放宽):
 *   剥代码块 -> 严格 parse
 *   -> 变体(原样 / 转义内层引号) × (是否 repairJson) 上先做"平衡抽取", 优先返回**含 outputs** 的值
 *      (解决尾随杂讯与双对象)
 *   -> 变体整体 parse
 *   -> 任意可解析对象兜底
 *   -> 抛出并带上原文开头, 便于用落盘原文定位。
 */
export function parseJsonLoose(text: string): any {
  const s = stripFences(text);
  try { return JSON.parse(s); } catch { /* 走修复 */ }

  const base = [s, escapeInnerQuotes(s)];
  const variants: string[] = [];
  for (const v of base) variants.push(v);
  for (const v of base) variants.push(repairJson(v));
  for (const v of base) variants.push(escapeInnerQuotes(repairJson(v)));

  for (const v of variants) {
    for (const c of balancedValues(v)) {
      try {
        const p = JSON.parse(c);
        if (p && typeof p === "object" && !Array.isArray(p) && "outputs" in p) return p;
      } catch { /* 试下一个 */ }
    }
  }
  for (const v of variants) {
    try { return JSON.parse(v); } catch { /* 试下一个 */ }
  }
  for (const v of variants) {
    for (const c of balancedValues(v)) {
      try { const p = JSON.parse(c); if (p && typeof p === "object") return p; } catch { /* 试下一个 */ }
    }
  }
  throw new Error("JSON parse failed after repair: 已尝试 代码块剥离/内层引号转义/repairJson, head=" + s.slice(0, 120));
}
