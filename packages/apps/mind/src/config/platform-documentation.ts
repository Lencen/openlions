/**
 * platform-documentation.ts — 平台静态档单一来源 (agent-x P2#10, 2026-09-24)
 *
 * 【为何单独立文件 / 与 capabilities 的边界 (硬约束)】
 *   平台记忆 cmuc5i5jy000a1hqrms6y19t0 + cmue9y6gw04tzoi3197h0r0s3 明确要求:
 *     RFC 必须显式拆 capabilities vs documentation, 否则两个接口会塌成同一个。
 *       - capabilities  = **动态活接口列表 + 鉴权状态**  → 回答"我**现在**能调什么"
 *                          (见 ./platform-capabilities.ts / GET /api/v1/platform/capabilities);
 *       - documentation = **平台静态档**                → 回答"平台**是什么**"
 *                          (能力边界 / 服务清单 / 限制条件 / 版本兼容矩阵)。
 *   两者数据源不同: capabilities 每次请求从白名单"现算"(活); documentation 是人工维护、
 *   带版本号的静态事实(死)。因此本文件**只放静态事实**, 不放任何运行时状态。
 *
 * 【语义来源】不二次定义, 与既有单一来源对齐:
 *   - 能力边界:  由 readonly-protocol-whitelist(A 类) + abc-permission-tiers(A/B/C 闸门) 推导;
 *   - 服务清单:  与 platform/health route 的探活服务同名(probeName), 可被探针交叉核对;
 *   - 限制条件:  逐条附 file/code 锚点, 可复算(见 scripts/probes/probe-platform-documentation.ts);
 *   - 版本矩阵:  取自 package.json / 运行环境实测值, 非臆测。
 *
 * 【只读纪律】纯常量 + 纯函数, 不 import prisma / fs / network; 无 Date.now() (静态档可缓存)。
 *
 * 复算: cd packages/apps/mind && ../../../node_modules/.bin/tsx --tsconfig tsconfig.json \
 *         ../../../scripts/probes/probe-platform-documentation.ts
 */

/** 静态档 schema 版本 (结构变更时 +1, 供消费者做兼容判断) */
export const DOCUMENTATION_SCHEMA_VERSION = "1.0.0";

/** 静态档内容版本 (人工维护; 事实变更时 +1) */
export const DOCUMENTATION_CONTENT_VERSION = "1.0.0";

/** 人工维护日期 (非请求时刻; 静态档不随请求变化) */
export const DOCUMENTATION_UPDATED_AT = "2026-09-24";

/** 能力边界条目: 带依据锚点, 便于独立复核 */
export interface BoundaryFact {
  /** 事实陈述 */
  statement: string;
  /** 依据 (file:line / 端点 / 机制名), 供复算 */
  anchor: string;
}

/** 服务清单条目: probeName 与 platform/health 的 data[].name 一致 (可交叉核对) */
export interface ServiceInventoryEntry {
  /** 服务名 (与 health route 探活输出同名) */
  name: string;
  /** 监听端口 (0 = stdio 无 HTTP 端口) */
  port: number;
  /** 角色说明 */
  role: string;
  /** 探活方式 (与 health route 口径一致) */
  probe: "http" | "process";
  /** 生命周期载体 (systemd unit 或 stdio 进程) */
  runtime: string;
  /** 依据锚点 */
  anchor: string;
}

/** 限制条件条目: 由"机制"而非"约定"保证, 附实现锚点 */
export interface ConstraintEntry {
  /** 限制名 */
  name: string;
  /** 限制内容 */
  rule: string;
  /** 触发/违反时的行为 */
  onViolation: string;
  /** 实现锚点 (file:line 或模块) */
  anchor: string;
}

/** 版本兼容矩阵条目 */
export interface VersionCompatEntry {
  /** 组件/层 */
  component: string;
  /** 当前版本 (实测) */
  version: string;
  /** 兼容边界 (最低/最高/约定) */
  compatibility: string;
  /** 依据锚点 */
  anchor: string;
}

export interface PlatformDocumentation {
  /** 静态档标识: 恒为 "static" (与 capabilities 的 "dynamic" 相对) */
  kind: "static";
  schemaVersion: string;
  contentVersion: string;
  updatedAt: string;
  /** 一句话定位 */
  summary: string;
  /**
   * 与 capabilities 的显式边界: 本接口回答什么、不回答什么、对方接口是谁。
   * 该字段是"防两接口塌成一个"的结构性保证, 探针会断言其在位。
   */
  boundary: {
    documentationAnswers: string;
    capabilitiesAnswers: string;
    capabilitiesEndpoint: string;
    rule: string;
  };
  /** 能力边界: 能做什么 / 不能做什么 */
  capabilityBoundaries: {
    can: BoundaryFact[];
    cannot: BoundaryFact[];
  };
  /** 服务清单 */
  serviceInventory: ServiceInventoryEntry[];
  /** 限制条件 */
  constraints: ConstraintEntry[];
  /** 版本兼容矩阵 */
  versionCompatibility: VersionCompatEntry[];
  /** 相邻只读接口索引 (均为 A 类, 无入参) */
  relatedReadonlyEndpoints: Array<{ method: "GET"; endpoint: string; answers: string }>;
}

/**
 * 服务清单: name 必须与 packages/apps/mind/src/app/api/v1/platform/health/route.ts
 * 的 SERVICES 同名 (probe 会与线上 health 输出交叉核对, 防止"文档写了不存在的服务")。
 */
const SERVICE_INVENTORY: ServiceInventoryEntry[] = [
  {
    name: "Mind",
    port: 3000,
    role: "认知飞轮主服务 (记忆/知识/技能/待办/反思 API 与 /api/v1 平台只读面)",
    probe: "http",
    runtime: "systemd --user: lions-mind.service",
    anchor: "packages/apps/mind/src/app/api/v1/platform/health/route.ts:13",
  },
  {
    name: "Selfimproving",
    port: 3001,
    role: "自改进/流水线服务",
    probe: "http",
    runtime: "systemd --user",
    anchor: "packages/apps/mind/src/app/api/v1/platform/health/route.ts:14",
  },
  {
    name: "Session",
    port: 3002,
    role: "会话注册与同步",
    probe: "http",
    runtime: "systemd --user: lions-session.service",
    anchor: "packages/apps/mind/src/app/api/v1/platform/health/route.ts:15",
  },
  {
    name: "Console",
    port: 3004,
    role: "管理台 UI (Tasks/Problems/Dashboard)",
    probe: "http",
    runtime: "systemd --user: lions-console.service",
    anchor: "packages/apps/mind/src/app/api/v1/platform/health/route.ts:18",
  },
  {
    name: "Portal",
    port: 3006,
    role: "对外门户 UI (注: 设计值 3003 已废弃, 实际 3006)",
    probe: "http",
    runtime: "systemd --user: lions-portal.service",
    anchor: "packages/apps/mind/src/app/api/v1/platform/health/route.ts:17",
  },
  {
    name: "MCP-Server",
    port: 0,
    role: "MCP 工具服务 (stdio, 无 HTTP 端口)",
    probe: "process",
    runtime: "stdio: mcp-server/dist/index.js",
    anchor: "packages/apps/mind/src/app/api/v1/platform/health/route.ts:20",
  },
];

/** 限制条件: 每条都由平台层机制强制, 不是口头约定 */
const CONSTRAINTS: ConstraintEntry[] = [
  {
    name: "A 类只读接口协议确定性",
    rule: "A 类只读接口 method 固定 GET; 入参必须可由白名单静态枚举, 未知参数一律拒绝。",
    onViolation: "400 whitelist_param_unknown / 405 (method 不符)",
    anchor: "packages/apps/mind/src/config/readonly-protocol-whitelist.ts:160-202",
  },
  {
    name: "ABC 权限分级闸门",
    rule: "A 类零风险开放; B 类受控可写必须 whitelist+audit+rate-limit 三件套齐备才 enabled; C 类永不触碰。",
    onViolation: "B 类缺件 → enabled:false (fail-closed); C 类命中 → 403 c_class_forbidden",
    anchor: "packages/apps/mind/src/config/abc-permission-tiers.ts + middleware.ts:69-79",
  },
  {
    name: "网关限流",
    rule: "/api/trpc 每 agent 100 req/min, burst 20 (in-memory token bucket, 单进程)。",
    onViolation: "429 rate_limited + Retry-After: 1",
    anchor: "packages/apps/mind/src/middleware.ts:27-28,83-106",
  },
  {
    name: "探活超时统一",
    rule: "平台级探活统一 3000ms, 与 mind /readyz 自检同值; 禁止各脚本各写一套阈值。",
    onViolation: "超时记为 crit, 不挂死请求",
    anchor: "packages/apps/mind/src/app/api/v1/platform/health/route.ts:9",
  },
  {
    name: "平台库读写边界",
    rule: "平台校验优先只读打开 SQLite; 写路径唯一收敛到 prisma/dev.db; 不提供任意 SQL 执行接口。",
    onViolation: "只读打开失败即降级空数组/报错, 不静默写入",
    anchor: "packages/apps/mind/src/app/api/v1/platform/logs/route.ts:54-57",
  },
  {
    name: "结单证据锚点门槛",
    rule: "承诺型 Todo 结单 evidence 须 >=120 字且含 file:/cmd:/sql:/commit:/RFC 锚点之一, 否则不算落地。",
    onViolation: "service-check 标红 todo-promise-fulfillment 并自动重开进认领池",
    anchor: "packages/apps/mind/src/server/pipeline/todo-evidence-gate.ts:28,41",
  },
  {
    name: "服务重启纪律",
    rule: "macs-responder-* 响应体进程禁止被自身 stop/restart (会被 KillMode 连带杀死); 须分离执行。",
    onViolation: "停为 down 且不自动拉起 (需人工介入)",
    anchor: "docs/config-management-sop-2026-09-15.md + 平台运行纪律",
  },
];

/** 版本兼容矩阵: version 字段为实测值, 不是设计值 */
const VERSION_COMPATIBILITY: VersionCompatEntry[] = [
  {
    component: "HTTP API 版本面",
    version: "/api/v1",
    compatibility: "现行唯一版本前缀 (无 /api/v2); 新端点一律挂 /api/v1 下, 破坏性变更须新前缀",
    anchor: "packages/apps/mind/src/app/api/v1/**",
  },
  {
    component: "Node.js 运行时",
    version: "v22.22.2 (实测)",
    compatibility: "engines.node >= 18.0.0; 本机实测 v22.22.2",
    anchor: "package.json engines.node",
  },
  {
    component: "Next.js (App Router)",
    version: "14.2.35",
    compatibility: "App Router route handlers (export async function GET); force-dynamic 用于读 DB 的只读接口",
    anchor: "packages/apps/mind/package.json dependencies.next",
  },
  {
    component: "Prisma / SQLite",
    version: "Prisma ^5.22.0 / dev.db",
    compatibility: "单文件 SQLite; 跨服务共享同一 dev.db; 校验路径只读打开",
    anchor: "packages/apps/mind/prisma/dev.db + package.json dependencies.@prisma/client",
  },
  {
    component: "React (Console/Portal UI)",
    version: "^18",
    compatibility: "App Router 服务端组件优先; 前端不得硬编码 KPI (读真实 API)",
    anchor: "packages/apps/mind/package.json dependencies.react",
  },
  {
    component: "Python 调用方 helper",
    version: "python3 stdlib",
    compatibility: "platform_context.py 兼容 python3.7+ 且不向上抛异常 (失败返回空)",
    anchor: "scripts/macs-responder/lib/platform_context.py",
  },
];

/**
 * 静态档单一来源导出。
 * 注意: 纯数据组装, 无副作用; route 直接返回本函数结果。
 */
export function describePlatformDocumentation(): PlatformDocumentation {
  return {
    kind: "static",
    schemaVersion: DOCUMENTATION_SCHEMA_VERSION,
    contentVersion: DOCUMENTATION_CONTENT_VERSION,
    updatedAt: DOCUMENTATION_UPDATED_AT,
    summary:
      "平台静态档: 描述平台是什么 (能力边界/服务清单/限制条件/版本兼容矩阵)。" +
      "回答'我**现在**能调什么'请用 GET /api/v1/platform/capabilities (动态)。",
    boundary: {
      documentationAnswers: "平台是什么 (静态事实: 能力边界/服务清单/限制条件/版本兼容矩阵)",
      capabilitiesAnswers: "我现在能调什么 (动态活接口列表 + 鉴权状态)",
      capabilitiesEndpoint: "GET /api/v1/platform/capabilities",
      rule:
        "documentation=静态(死, 带版本号, 人工维护); capabilities=动态(活, 每请求从白名单现算)。" +
        "二者不可合并: 合并会让'平台是什么'随运行时抖动, 也会让'我能调什么'被静态陈述掩盖。",
    },
    capabilityBoundaries: {
      can: [
        { statement: "跨 agent 共享的记忆/知识/技能检索与写入 (飞轮)", anchor: "GET /api/v1/flywheel/memory/context, GET /api/v1/skill" },
        { statement: "待办登记/认领/结单与证据闸门闭环", anchor: "packages/apps/mind/src/app/api/v1/flywheel/todos/**" },
        { statement: "反思/提案/发现/讨论的沉淀与检索", anchor: "packages/apps/mind/src/app/api/v1/flywheel/{reflections,findings,discussions}/**" },
        { statement: "平台只读可观测面: 探活/日志/权限分级/静态档/活接口清单", anchor: "GET /api/v1/platform/{health,logs,permission-tiers,documentation,capabilities}" },
        { statement: "质量审计与服务检查 (发现承诺无实现的空头 DONE 并重开)", anchor: "packages/apps/mind/src/app/api/v1/flywheel/{quality-audit,goal-check}/**" },
      ],
      cannot: [
        { statement: "不提供任意 SQL 执行接口 (平台自身校验用只读打开 DB)", anchor: "packages/apps/mind/src/app/api/v1/platform/logs/route.ts:54-57" },
        { statement: "不提供任意 shell / 进程控制接口", anchor: "packages/apps/mind/src/config/abc-permission-tiers.ts:143-150" },
        { statement: "不提供跨 agent 私有凭证/密钥读取 (C 类永久拒绝)", anchor: "packages/apps/mind/src/config/abc-permission-tiers.ts:143-150" },
        { statement: "不提供记忆/知识的硬删除直通 (purge 类操作须走受控链路并留回滚窗口)", anchor: "commit edfe887" },
        { statement: "不替代 agent 本地工具执行 (平台只做协调与记录, 不代跑 shell/db 工具)", anchor: "packages/apps/mind/src/server/pipeline/agent-capability.ts:48" },
      ],
    },
    serviceInventory: SERVICE_INVENTORY,
    constraints: CONSTRAINTS,
    versionCompatibility: VERSION_COMPATIBILITY,
    relatedReadonlyEndpoints: [
      { method: "GET", endpoint: "/api/v1/platform/capabilities", answers: "我现在能调什么 (动态)" },
      { method: "GET", endpoint: "/api/v1/platform/permission-tiers", answers: "ABC 分级清单 + B 类闸门台账" },
      { method: "GET", endpoint: "/api/v1/platform/health", answers: "平台存活探活" },
      { method: "GET", endpoint: "/api/v1/platform/logs", answers: "平台最近事件/错误/审计" },
    ],
  };
}

/** 静态档占位/完整性自检 (供探针复用, 不产生副作用) */
export function validatePlatformDocumentation(doc: PlatformDocumentation): string[] {
  const problems: string[] = [];
  if (doc.kind !== "static") problems.push("kind 必须为 static");
  if (!doc.schemaVersion || !doc.contentVersion || !doc.updatedAt) problems.push("版本三件套缺失");
  if (!doc.boundary?.capabilitiesEndpoint) problems.push("boundary.capabilitiesEndpoint 缺失 (无法与 capabilities 区分)");
  if (!doc.boundary?.rule) problems.push("boundary.rule 缺失 (防塌成一个接口的结构性说明)");
  if (doc.capabilityBoundaries.can.length < 3) problems.push("can 条目 < 3");
  if (doc.capabilityBoundaries.cannot.length < 3) problems.push("cannot 条目 < 3");
  if (doc.serviceInventory.length < 4) problems.push("服务清单 < 4");
  if (doc.constraints.length < 4) problems.push("限制条件 < 4");
  if (doc.versionCompatibility.length < 4) problems.push("版本兼容矩阵 < 4");
  for (const c of doc.constraints) if (!c.anchor) problems.push(`限制 "${c.name}" 缺 anchor`);
  for (const b of [...doc.capabilityBoundaries.can, ...doc.capabilityBoundaries.cannot]) {
    if (!b.anchor) problems.push(`能力边界 "${b.statement.slice(0, 20)}" 缺 anchor`);
  }
  for (const v of doc.versionCompatibility) if (!v.version || !v.anchor) problems.push(`版本项 "${v.component}" 缺 version/anchor`);
  for (const s of doc.serviceInventory) if (!s.anchor) problems.push(`服务 "${s.name}" 缺 anchor`);
  return problems;
}
