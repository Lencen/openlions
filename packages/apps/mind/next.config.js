/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  // 2026-10-26 P4 构建原子化：允许把产物先写到临时目录，成功后再整体切换（默认仍是 .next，行为不变）。
  //   背景：当天 .next/BUILD_ID 丢失导致 wrapper 回退 dev 并崩循环、服务中断。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // v3.1 平台化: @lions/events 走 packages/core/events/dist
  // 2026-10-08 round 58: @lions/product-contract 同处理(归一函数入口: normalizeProductTitle + TITLE_MAX + SKILL_NAME_MAX)
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@lions/events": path.resolve(__dirname, "../../core/events/dist"),
      "@lions/product-contract": path.resolve(__dirname, "../../modules/product-contract/dist"),
    };
    return config;
  },
};

module.exports = nextConfig;
