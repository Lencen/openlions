/**
 * 2026-10-22 console 的 /api 代理排除名单（**唯一来源**）。
 *
 * 背景：next.config.js 里有一条 catch-all rewrite 把所有 /api/* 代理到 mind(:3000)，
 *   只对排除名单里的前缀放行。历史上漏加过名字，导致 /api/macs/trace/<id> 这种**动态段**
 *   被代理到 mind，返回 mind 的 404（单段路径因先命中本地路由才不会暴露）。
 *
 * 铁律：
 *   1) 新增 /api/<段>/ 且该段下**存在动态路由**（[id] / [...x]）时，必须把段名加进 EXCLUDED_SEGMENTS，
 *      否则 scripts/check-console-api-proxy.cjs 会 FAIL；
 *   2) next.config.js 必须通过本文件生成 rewrite，不得另写一份名单。
 */
const EXCLUDED_SEGMENTS = ["mcp-proxy", "session-detail", "guards", "macs"];

/** 生成 next.config.js 需要的 rewrite source（负向 lookahead 由这里统一拼） */
function buildApiRewriteSource() {
  return "/api/:path((?!" + EXCLUDED_SEGMENTS.join("|") + ").*)";
}

module.exports = { EXCLUDED_SEGMENTS, buildApiRewriteSource };
