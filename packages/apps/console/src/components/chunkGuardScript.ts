// 2026-10-13 round 76-CR: **脚本加载失败的全局兜底(内联, 不依赖 React)**
//
// 为什么必须是内联脚本:
//   第一版我写成 React 组件(ChunkLoadGuard.tsx), 实测**根本不生效** —— 因为当 chunk 加载失败时,
//   **连 layout 自己的 chunk 也拿不到**, React 从未挂载, 组件自然永远不会渲染。
//   所以兜底必须像主题预置脚本那样**直接写进 SSR 的 HTML**, 用原生 DOM 注入提示条。
//
// 判据(两条, 覆盖两种失败方式):
//   1) 捕获阶段 error 且 target 是 <script>/<link> 且 url 含 /_next/ —— 构建产物加载失败;
//   2) unhandledrejection 且 reason 是 ChunkLoadError / Loading chunk failed / dynamic import 失败。
// 只提示一次; 提示条自带[重新加载]; 用内联样式(此时代码可能还没样式表)。
export const CHUNK_GUARD_SCRIPT = `
(function(){
  if (window.__lionsChunkGuard) return; window.__lionsChunkGuard = true;
  var shown = false;
  function show(){
    if (shown || !document.body) return; shown = true;
    var d = document.createElement('div');
    d.setAttribute('role','alert');
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#8A6300;color:#fff;padding:10px 16px;font:13px/1.5 -apple-system,PingFang SC,Microsoft YaHei,sans-serif;display:flex;gap:12px;align-items:center;justify-content:center;box-shadow:0 -2px 10px rgba(0,0,0,.25)';
    var t = document.createElement('span');
    t.textContent = '页面资源加载失败，内容可能停在加载中。';
    var b = document.createElement('button');
    b.textContent = '重新加载';
    b.style.cssText = 'background:#fff;color:#8A6300;border:0;border-radius:6px;padding:3px 12px;cursor:pointer;font:600 13px/1.5 inherit';
    b.onclick = function(){ window.location.reload(); };
    d.appendChild(t); d.appendChild(b);
    document.body.appendChild(d);
  }
  window.addEventListener('error', function(e){
    var t = e.target || {};
    var tag = (t.tagName || '').toUpperCase();
    var url = String(t.src || t.href || '');
    if ((tag === 'SCRIPT' || tag === 'LINK') && url.indexOf('/_next/') !== -1) show();
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason || {};
    var msg = String(r.message || r.name || r || '');
    if (/ChunkLoadError|Loading chunk|dynamically imported module|module script failed/i.test(msg)) show();
  });
})();
`;