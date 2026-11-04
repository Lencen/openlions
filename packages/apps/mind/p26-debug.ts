// p26-debug
const text = `{"memories": [{"role": "user", "content": "用户问了一个问题"}, {"role": "assistant", "content": "AI 回答了 5000 字符的内容, 包含很多文字. Lorem ipsum dolor sit amet. 我们继续写内容, 模拟 stream 中断. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam. Nemo enim ipsam voluptatem quia voluptas sit aspernatur`;
console.log("INPUT len:", text.length);
console.log("INPUT tail 50:", text.slice(-50));

// 跑 v5 算法
let inStr = false, esc = false;
const unclosedOpens: number[] = [];
for (let i = 0; i < text.length; i++) {
  const ch = text[i];
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
console.log("unclosedOpens:", unclosedOpens);
console.log("end inStr:", inStr);

let candidate = text;
const sortedOpens = [...unclosedOpens].sort((a, b) => b - a);
for (const pos of sortedOpens) {
  if (pos + 1 <= candidate.length) {
    candidate = candidate.slice(0, pos + 1) + '"' + candidate.slice(pos + 1);
  }
}
console.log("after close, candidate len:", candidate.length);
console.log("candidate tail 100:", candidate.slice(-100));

// 第三步: 找 balanced
let depth = 0, esc2 = false, lastBalanced = -1;
let inStr2 = false;
for (let i = 0; i < candidate.length; i++) {
  const ch = candidate[i];
  if (esc2) { esc2 = false; continue; }
  if (ch === "\\") { esc2 = true; continue; }
  if (ch === '"') { inStr2 = !inStr2; continue; }
  if (inStr2) continue;
  if (ch === "{" || ch === "[") depth++;
  else if (ch === "}" || ch === "]") { depth--; if (depth === 0) lastBalanced = i; }
}
console.log("lastBalanced:", lastBalanced);
if (lastBalanced > 0 && lastBalanced < candidate.length - 1) {
  candidate = candidate.slice(0, lastBalanced + 1);
  candidate = candidate.replace(/,(\s*[}\]])/g, "$1");
}
console.log("FINAL candidate len:", candidate.length);
console.log("FINAL tail 200:", candidate.slice(-200));

try {
  const r = JSON.parse(candidate);
  console.log("PARSE OK, keys:", Object.keys(r));
} catch (e: any) {
  console.log("PARSE FAIL:", e.message);
}
