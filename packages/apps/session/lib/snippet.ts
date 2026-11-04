// D-01 (2026-09-07): FTS5 snippet 安全转义 — 独立模块便于单测
// FTS5 的 snippet() 用 <mark>…</mark> 包裹命中词, 中间是用户消息原文。
// 直接 dangerouslySetInnerHTML 会把消息里的 <script>/HTML 当标签执行 (stored XSS)。
// 修复: 先整体 HTML 转义, 再只把 &lt;mark&gt; 还原为高亮标签 (白名单)。
export function escapeSnippet(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}
