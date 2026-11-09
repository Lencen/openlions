/** @type {import('next').NextConfig} */
const { buildApiRewriteSource } = require("./api-proxy-exclusions.cjs");

const nextConfig = {
  // 2026-10-15: 构建产物目录可被环境变量改写, 让"开发实例"与"发布实例"共用同一份代码
  //   却**绝不共用构建产物目录**。
  //   为什么: dev 服务器在编译期持续写自己的 distDir; 若 dev 实例也用 `.next`, 它的写入
  //   会与发布流程的 `next build` 互相踩坏产物 —— 2026-10-15 console 发布连续两次失败
  //   (PageNotFoundError: /_document) 的根因就是"一个 dev 进程在构建期写 .next"。
  //   默认值仍是 `.next` -> lions-console.service(3004, next start) 行为**零变化**;
  //   只有显式设了 LIONS_DIST_DIR 的单元(见 lions-console-dev.service) 才用独立目录。
  distDir: process.env.LIONS_DIST_DIR || '.next',
  // Proxy API calls to Mind (avoid CORS)
  // 但本地 session 服务相关的端点不走 mind proxy, 直接路由到 :3002
  async rewrites() {
    return [
      // session 服务直连 (不经过 mind, 数据最新)
      // list: 静态字符串
      { source: '/api/session-service-list', destination: 'http://localhost:3002/api/v1/sessions' },
      // mcp-proxy: 本地 route.ts 处理, 不能让 catch-all 转给 mind (catch-all 顺序在后)
      // 负向 regex 用 lookahead 不支持, 改用 try-match: catch-all 排除 mcp-proxy
      // 2026-10-22：排除名单抽到 api-proxy-exclusions.cjs（唯一来源），由守门脚本校验
      //   "有动态路由的段必须在名单里"，避免再加 BFF 路由时漏改正则。
      { source: buildApiRewriteSource(), destination: 'http://localhost:3000/api/:path' },
    ];
  },
  // 2026-11-05 商业线裁决 C：/flywheel/business（含 [dim]）下线 -> 真 301 /market。
  //   为什么放在 next.config 而不是 page.tsx 里 redirect()：
  //   ① 判据 scripts/check-offline-301.cjs 判的是**字面 301**（旧路由 301 + Location 以目标结尾 + 目标 200）；
  //      App Router 里 next/navigation 的 redirect() 返回 307，过不了这条判据（仓内既有 307 先例：
  //      app/audit/page.tsx、app/cognitive/knowledge/governance/page.tsx，都是页内跳转不是下线）。
  //   ② 处置规范 docs/design/uiux-bento-2026-11/OFFLINE-SCOPE-078.md §3 把「next.config redirects」
  //      与「页内 redirect()」并列为两种实现；而 ord-078 要求页目录/组件原样保留 60 天，
  //      config 级 redirect 在进入路由前返回，页面文件可完全不动（只加一行说明注释）。
  //   statusCode 显式写 301：Next 14 里 permanent: true 产出的是 308，不等于 301。
  async redirects() {
    return [
      { source: '/flywheel/business', destination: '/market', statusCode: 301 },
      { source: '/flywheel/business/:dim', destination: '/market', statusCode: 301 },
      // 2026-11-06 商业线裁决（R-01 收口）：余下 3 条下线页也走 301
      { source: '/workbench', destination: '/', statusCode: 301 },
      { source: '/system/comm', destination: '/messages', statusCode: 301 },
      { source: '/agents/config', destination: '/agents', statusCode: 301 },
    ];
  },
  transpilePackages: ['echarts', 'echarts-for-react', 'antd', '@ant-design/icons'],
};

module.exports = nextConfig;