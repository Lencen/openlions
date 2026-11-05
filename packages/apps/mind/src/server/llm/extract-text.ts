/**
 * extract-text.ts — 从 LLM 响应里取正文（2026-11-05, ord-069）
 *
 * 为什么需要：MiniMax-M3.1-Flash 强制 adaptive thinking，响应形如
 *   { content: [{type:'thinking', ...}, {type:'text', text:'...'}] }
 * 而全仓多处只取 `content?.[0]?.text` —— 拿到空串，于是「LLM 返回非 JSON」整轮失败。
 * 本 helper 统一为：**按顺序拼接所有 type==='text' 的块**，忽略 thinking/reasoning 等；
 * 再回退 OpenAI 风格 `choices[0].message.content`。全空返回 ''，由调用方按「空响应」处理。
 */

export type LlmContentBlock = { type?: string; text?: unknown };

export function extractLlmText(data: any): string {
  if (!data || typeof data !== 'object') return '';

  // 1) Anthropic Messages API: content 是块数组，可能混有 thinking
  const blocks = (data as any).content;
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const b of blocks as LlmContentBlock[]) {
      if (!b || typeof b !== 'object') continue;
      if (b.type !== 'text') continue;            // 忽略 thinking / reasoning / tool_use 等
      if (typeof b.text === 'string' && b.text.length > 0) parts.push(b.text);
    }
    if (parts.length > 0) return parts.join('');
  }

  // 2) 兼容 OpenAI / 旧格式
  const legacy = (data as any)?.choices?.[0]?.message?.content;
  if (typeof legacy === 'string') return legacy;
  if (Array.isArray(legacy)) {
    return legacy
      .map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p === 'string' ? p : ''))
      .join('');
  }

  // 3) 极少数服务直接给字符串 body
  if (typeof (data as any).text === 'string') return (data as any).text;
  return '';
}