import assert from 'node:assert';
import { extractLlmText } from './extract-text';

let pass = 0, fail = 0;
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e: any) { fail++; console.log('FAIL ' + name + ' :: ' + String(e.message).slice(0, 160)); }
}

t('a) thinking + text -> 能解析出 JSON', () => {
  const data = { content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '{"ok":1}' }] };
  const s = extractLlmText(data);
  assert.strictEqual(s, '{"ok":1}');
  assert.deepStrictEqual(JSON.parse(s), { ok: 1 });
});

t('b) 只有 thinking -> 返回空串（调用方按空响应处理，不崩）', () => {
  const data = { content: [{ type: 'thinking', thinking: '只有思考块' }] };
  assert.strictEqual(extractLlmText(data), '');
  assert.throws(() => JSON.parse(extractLlmText(data)), SyntaxError);
});

t('c) 多个 text 块按顺序拼接', () => {
  const data = { content: [{ type: 'text', text: 'a' }, { type: 'thinking' }, { type: 'text', text: 'b' }] };
  assert.strictEqual(extractLlmText(data), 'ab');
});

t('d) 兼容 OpenAI 旧格式 choices[0].message.content', () => {
  assert.strictEqual(extractLlmText({ choices: [{ message: { content: 'legacy' } }] }), 'legacy');
});

t('e) 空/异常输入不抛异常', () => {
  assert.strictEqual(extractLlmText(null), '');
  assert.strictEqual(extractLlmText({}), '');
  assert.strictEqual(extractLlmText({ content: [] }), '');
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);