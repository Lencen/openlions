#!/usr/bin/env node
/**
 * lions-apps.cjs — LIONS 五服务 profile 的**可 require 单一来源**（产品化 S0-1，2026-10-15）
 * ==========================================================================================
 *
 * 为什么要有它:
 *   `scripts/lions-release.cjs` 里有一份 APPS profile（本机发布用），但它是**脚本不是模块**（require 会执行发布主流程），
 *   安装器/升级器/doctor 不能直接 import。为避免"每个工具各写一份端口/单元名"导致漂移，
 *   这里抽出一份可 require 的 profile，并由 `scripts/check-apps-profile-parity.cjs` 机械保证与 release 工具一致。
 *
 * 字段:
 *   label/dir/unit/port/mode —— 与 lions-release.cjs APPS **逐字段一致**（守门比对这 5 项）。
 *   healthPaths  —— 健康检查路径（口径同 release 工具，见其 healthWhy 注释）。
 *   nodeHeapMiB  —— NODE_OPTIONS 堆上限（防 OOM 撕裂写库）。
 *   hasDatabase  —— 该 app 是否持有自己的库（portal 只读 mind，不建自己的库）。
 *   installMode  —— 新装实例运行模式（v1 全新安装统一 production；release 工具的 mode 描述的是本机现状）。
 */
"use strict";

const APPS = {
  mind: {
    label: "mind（认知核心）",
    dir: "packages/apps/mind",
    unit: "lions-mind.service",
    port: 3000,
    mode: "production",
    installMode: "production",
    nodeHeapMiB: 3072,
    hasDatabase: true,
    healthPaths: ["/api/health/db"],
  },
  selfimproving: {
    label: "selfimproving（自改进任务引擎）",
    dir: "packages/apps/selfimproving",
    unit: "lions-selfimproving.service",
    port: 3001,
    mode: "dev",
    installMode: "production",
    nodeHeapMiB: 3072,
    hasDatabase: true,
    healthPaths: ["/api/trpc/health.report?input=%7B%22json%22%3Anull%7D"],
  },
  session: {
    label: "session（会话/同步）",
    dir: "packages/apps/session",
    unit: "lions-session.service",
    port: 3002,
    mode: "production",
    installMode: "production",
    nodeHeapMiB: 3072,
    hasDatabase: true,
    healthPaths: ["/"],
  },
  console: {
    label: "console（运维台）",
    dir: "packages/apps/console",
    unit: "lions-console.service",
    port: 3004,
    mode: "production",
    installMode: "production",
    nodeHeapMiB: 3072,
    hasDatabase: false,
    healthPaths: ["/"],
  },
  portal: {
    label: "portal（对外门户）",
    dir: "packages/apps/portal",
    unit: "lions-portal.service",
    port: 3006,
    mode: "production",
    installMode: "production",
    nodeHeapMiB: 3072,
    hasDatabase: false,
    healthPaths: ["/api/portal/guide/version"],
  },
};

/** profile 中需要与 release 工具机械对齐的字段（守门比对集）。 */
const PARITY_FIELDS = ["label", "dir", "unit", "port", "mode"];
/** app 启动顺序：先库属主与依赖方，再界面（安装/升级都按此序）。 */
const START_ORDER = ["mind", "selfimproving", "session", "console", "portal"];

module.exports = { APPS, PARITY_FIELDS, START_ORDER };
