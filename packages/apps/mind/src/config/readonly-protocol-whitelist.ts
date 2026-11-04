/**
 * readonly-protocol-whitelist.ts — A 类只读接口协议白名单定义 (平台层兜底, 2026-09-23)
 *
 * [agent-x P0#3] 协议确定性白名单 (设计漏洞) — 落地依据:
 *   agent-x 反馈原句: "平台层兜底不该让 agent 自己写防御规则";
 *   设计结论 (knowledge cmuc5ibd7): 防御规则散落在各 agent 内部会导致规则不一致、
 *   覆盖不全、且无法静态枚举; 集中到平台层才能保证 fail-closed 的可静态枚举性与统一审计。
 *
 * 本文件即 **白名单定义**, 每条目 = 三件套:
 *   ① method           — 允许的 HTTP 方法 (A 类只读 = GET)
 *   ② endpoint 前缀     — 命中判定用 pathname 前缀 (含子路径, 如 /api/v1/skill/<id>)
 *   ③ 入参 schema       — 允许的 query 参数名 + 类型 + 必填/默认/长度约束
 *
 * 机制:
 *   - 平台层 fail-closed: 命中前缀的请求, method 或入参不符 → 405/400 拒绝;
 *   - agent 侧只消费 + 违规上报, 不再各写 deny/allow 规则;
 *   - 协议面扩展必须先改本表 (可静态枚举), 禁止绕过白名单直接放开。
 *
 * 适用边界: 仅覆盖 A 类只读接口 (跨 agent 共享的 HTTP 只读调用面);
 *   B 类受控可写 / C 类由各自机制管控, 不在本表。
 *
 * 与 route 实现逐一对齐 (2026-09-23 实测):
 *   - platform/health       GET, 无入参
 *   - platform/logs         GET, kind/limit/since (route 读取点见 platform/logs/route.ts)
 *   - platform/permission-tiers GET, 无入参 (ABC 分级清单, agent-x P0#11)
 *   - platform/capabilities  GET, 无入参 (动态活接口清单, agent-x P2#10 配套)
 *   - platform/documentation GET, 无入参 (静态平台档, agent-x P2#10)
 *   - flywheel/memory/context  GET, query/theme/limit/kinds (route 读取点见 context/route.ts)
 *   - skill                 GET 列表: search/category/legacy/stale/page/pageSize; 详情 GET /skill/<id> 无 query 参
 *   - flywheel/stats        GET, 无入参
 *   - knowledge/norms       GET, domain/limit
 *
 * 守卫覆盖纪律 (2026-09-23 教训): 本表条目必须被 middleware matcher 覆盖, 否则"声明为 A 类
 *   却无守卫" = 协议漂移。middleware 已把 matcher 收敛为 /api/:path* (全量进守卫, fail-closed),
 *   由 scripts/probes/probe-abc-permission-tiers.ts 断言表内前缀均可达守卫, 防止再次漂移。
 */

/** 入参 schema: 单个 query 参数的静态描述 */
export interface ReadonlyParamSpec {
  /** 参数名 */
  name: string;
  /** 类型: string / integer (integer 用 /^\d+$/ 校验) */
  type: "string" | "integer";
  /** 必填 (缺省 false) */
  required?: boolean;
  /** 缺省值 (文档用) */
  default?: string | number;
  /** string 类型的最大长度 */
  maxLength?: number;
  /** 语义说明 */
  description: string;
}

/** 白名单条目: method / endpoint 前缀 / 入参 schema 三件套 */
export interface ReadonlyWhitelistEntry {
  /** ① method — 只读接口仅 GET (POST/PATCH 等写操作属 B 类, 由其他机制管控) */
  method: "GET";
  /** ② endpoint 前缀 — pathname 前缀匹配 (精确或 前缀 + "/") */
  endpointPrefix: string;
  /** ③ 入参 schema — 允许的 query 参数全集 (未知参数拒绝) */
  inputSchema: ReadonlyParamSpec[];
  /** 条目语义说明 */
  description: string;
}

/** 校验失败返回结构 */
export interface WhitelistViolation {
  status: 400 | 405;
  error: string;
  message: string;
}

/** 白名单定义: A 类只读接口静态清单 (agent-x "A 类只读接口" 落地 + 后续扩展) */
export const READONLY_PROTOCOL_WHITELIST: ReadonlyWhitelistEntry[] = [
  {
    method: "GET",
    endpointPrefix: "/api/v1/platform/health",
    inputSchema: [],
    description: "平台健康聚合探活 (agent-x P1 platform_health, A 类只读; 无入参)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/platform/logs",
    inputSchema: [
      { name: "kind", type: "string", maxLength: 16, description: "日志源: all|events|errors|audit (默认 all)" },
      { name: "limit", type: "integer", default: 50, description: "每源条数上限 (route 内 1..500)" },
      { name: "since", type: "string", maxLength: 32, description: "起始时间 (ISO 8601 或 epoch ms), 只返回其后条目" },
    ],
    description: "平台日志只读接口 (agent-x P1 platform_logs, A 类只读; 数据源=平台结构化日志表 FlywheelEvent/FlywheelErrorLog/AuditLog)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/flywheel/memory/context",
    inputSchema: [
      { name: "query", type: "string", default: "", maxLength: 512, description: "检索关键词 (空 = 不过滤)" },
      { name: "theme", type: "string", maxLength: 128, description: "主题过滤" },
      { name: "limit", type: "integer", default: 8, description: "返回条数上限 (route 内 1..200)" },
      { name: "kinds", type: "string", maxLength: 64, description: "逗号分隔命中类型: memory/knowledge/skill" },
      // 2026-10-10 round 72-Z: 诊断类调用不计数。A 类协议要求入参可静态枚举, 故必须在此登记,
      //   否则 middleware 会以 whitelist_param_unknown 400 拦掉(实测: 冒烟探针加了参数后直接 400 失败)。
      { name: "countUsage", type: "string", default: "true", maxLength: 8, description: "是否计入使用计数: false=诊断类调用不计(默认 true)" },
      // 2026-10-10 round 72-AB: 调用者身份。生产模式下请求日志消失, 这是归因「谁在调」的唯一手段。
      { name: "source", type: "string", maxLength: 32, description: "调用者身份标识(如 smoke/todo-worker/manual), 写进注入事件的 sourceId" },
      // 2026-09-22 知识库结构化整理(步骤3): tags/domain 检索参数(向后兼容, 不传则现行为)
      { name: "tags", type: "string", maxLength: 256, description: "标签过滤(逗号分隔, 命中任一; 受控词表见 scripts/knowledge-tags-vocab.json)" },
      { name: "domain", type: "string", maxLength: 64, description: "领域过滤(受控枚举: platform/agent-ops/devops/product/data)" },
    ],
    description: "记忆前置注入: 任务执行前拉平台上下文 (agent 统一入口, platform_context.py 同款参数; 2026-09-22 增 tags/domain)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/skill",
    inputSchema: [
      { name: "search", type: "string", maxLength: 256, description: "技能名/触发词全文搜索" },
      { name: "category", type: "string", maxLength: 64, description: "分类过滤" },
      { name: "legacy", type: "string", maxLength: 8, description: "是否含 legacy 技能 (仅 true 含)" },
      { name: "stale", type: "string", maxLength: 8, description: "false 时过滤 stale" },
      { name: "page", type: "integer", default: 1, description: "页码 (>=1)" },
      { name: "pageSize", type: "integer", default: 20, description: "每页条数 (1..100)" },
    ],
    description: "技能列表 (SKILL-SPEC; 前缀亦覆盖 GET /api/v1/skill/<id> 详情, 详情无 query 参 → schema 为空集是其子集)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/flywheel/stats",
    inputSchema: [],
    description: "飞轮统计只读指标 (console/portal 拉取; 无入参)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/platform/permission-tiers",
    inputSchema: [],
    description: "ABC 权限分级清单 (agent-x P0#11; A 类只读, 无入参; B 类三件套台账 + C 类永不触碰)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/platform/capabilities",
    inputSchema: [],
    description:
      "平台动态能力清单 (agent-x P2#10 配套; A 类只读, 无入参; 回答'我现在能调什么' = A 类活接口列表每请求从本白名单现算 + 调用方鉴权状态)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/platform/documentation",
    inputSchema: [],
    description:
      "平台静态档 (agent-x P2#10; A 类只读, 无入参; 回答'平台是什么' = 能力边界/服务清单/限制条件/版本兼容矩阵; 与 capabilities 显式分离)",
  },
  {
    method: "GET",
    endpointPrefix: "/api/v1/knowledge/norms",
    inputSchema: [
      { name: "domain", type: "string", default: "platform", maxLength: 64, description: "领域过滤(默认 platform; 受控枚举见 knowledge-base-reorg 方案)" },
      { name: "limit", type: "integer", default: 50, description: "返回条数上限 (route 内 1..200)" },
    ],
    description: "规范类知识列表 (2026-09-22 知识库整理步骤4; agent 落地前拉规范索引, 轻量不占注入预算)",
  },
];

/**
 * 命中判定: (method, pathname) 是否落在白名单内。
 * 只对声明 method 生效 —— 同一前缀的写操作 (如 POST /api/v1/skill) 不属 A 类, 不在此表, 返回 null 放行。
 */
export function matchReadonlyWhitelist(method: string, pathname: string): ReadonlyWhitelistEntry | null {
  const m = String(method || "").toUpperCase();
  for (const entry of READONLY_PROTOCOL_WHITELIST) {
    if (m !== entry.method) continue;
    if (pathname === entry.endpointPrefix || pathname.startsWith(entry.endpointPrefix + "/")) {
      return entry;
    }
  }
  return null;
}

/**
 * 入参校验 (fail-closed):
 *   1) 未知参数拒绝 —— 入参空间完全由 schema 枚举 (协议确定性);
 *   2) 已知参数按类型/长度校验。
 * 返回 null = 通过; 否则返回拒绝原因。
 */
export function validateReadonlyWhitelist(
  entry: ReadonlyWhitelistEntry,
  sp: URLSearchParams
): WhitelistViolation | null {
  const allowed = new Set(entry.inputSchema.map((p) => p.name));
  for (const key of sp.keys()) {
    if (!allowed.has(key)) {
      return {
        status: 400,
        error: "whitelist_param_unknown",
        message: `参数 "${key}" 不在 ${entry.endpointPrefix} 的白名单 schema 内 (A 类只读协议确定性: 入参必须可静态枚举)`,
      };
    }
  }
  for (const spec of entry.inputSchema) {
    const raw = sp.get(spec.name);
    if (raw === null) {
      if (spec.required) {
        return {
          status: 400,
          error: "whitelist_param_missing",
          message: `缺少必填参数 "${spec.name}" (${entry.endpointPrefix})`,
        };
      }
      continue;
    }
    if (spec.type === "integer" && !/^\d+$/.test(raw)) {
      return {
        status: 400,
        error: "whitelist_param_type",
        message: `参数 "${spec.name}" 应为整数, 收到 "${raw}" (${entry.endpointPrefix})`,
      };
    }
    if (spec.type === "string" && spec.maxLength !== undefined && raw.length > spec.maxLength) {
      return {
        status: 400,
        error: "whitelist_param_length",
        message: `参数 "${spec.name}" 长度 ${raw.length} 超过上限 ${spec.maxLength} (${entry.endpointPrefix})`,
      };
    }
  }
  return null;
}

/**
 * 平台层 fail-closed 守卫入口 (middleware 调用):
 *   - 未命中白名单 (路径不在表内, 或 method 非本表声明的 GET) → 返回 null, 放行
 *     (同前缀的写方法属 B/C 类, 由它们或 route 自身管控; 框架对未导出方法返 405);
 *   - 命中且入参不符 → 400。
 *   注: 2026-09-24 订正 —— 本函数按 method 过滤条目, 故"A 类前缀 + 非 GET"不会由本函数返 405
 *   (此前注释误写 405 分支, 实为不可达; 行为不变)。
 */
export function readonlyWhitelistCheck(
  method: string,
  pathname: string,
  sp: URLSearchParams
): WhitelistViolation | null {
  const entry = matchReadonlyWhitelist(method, pathname);
  if (!entry) return null;
  const v = validateReadonlyWhitelist(entry, sp);
  if (v) return v;
  return null;
}

/** 白名单定义的可读摘要 (审计/巡检/复算用): 逐条输出三件套 */
export function describeReadonlyWhitelist(): Array<{
  method: string;
  endpointPrefix: string;
  params: string[];
}> {
  return READONLY_PROTOCOL_WHITELIST.map((e) => ({
    method: e.method,
    endpointPrefix: e.endpointPrefix,
    params: e.inputSchema.map((p) => `${p.name}:${p.type}${p.required ? "!" : ""}`),
  }));
}
