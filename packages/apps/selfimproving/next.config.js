const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 2026-10-16 (D6): 质量门禁恢复。此前 61→36→0 的类型问题已全部修完（tsc --noEmit 实测 0 错误），
  //   故不再关闭类型检查；ESLint 暂无局部配置（构建期不产生 lint 判定），完整 next build 验收留待发布窗口。
  // 2026-10-13 round 76-BS: 删掉 5 条 redirects —— 它们把 /problems /reflections /reviews /tasks
  //   **跨应用**跳到 mind(:3000), 而 mind 的前端 2026-09-05 起已归档(实测那些路径全 404),
  //   于是这些 redirect 变成"308 -> 404"的**死链**。console 现在是唯一管理后台, 对应能力在那边。
  // v3.1 平台化: @lions/events 走 packages/core/events/dist (webpack alias)
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@lions/events": path.resolve(__dirname, "../../core/events/dist"),
    };
    return config;
  },
};

module.exports = nextConfig;
