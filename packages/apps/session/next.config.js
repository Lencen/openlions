/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  experimental: {},
  // v3.1 平台化: @lions/events 走 packages/core/events/dist
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@lions/events": path.resolve(__dirname, "../../core/events/dist"),
    };
    return config;
  },
};

module.exports = nextConfig;