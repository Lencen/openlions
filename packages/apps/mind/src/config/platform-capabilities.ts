/**
 * platform-capabilities.ts — 平台动态"我能调什么"单一来源 (agent-x P2#10 配套, 2026-09-24)
 *
 * 【与 documentation 的边界 (硬约束, 平台记忆 cmuc5i5jy / cmue9y6gw)】
 *   capabilities  = **动态活接口列表 + 鉴权状态** → 回答"我**现在**能调什么";
 *   documentation = **平台静态档**              → 回答"平台**是什么**"
 *                    (见 ./platform-documentation.ts / GET /api/v1/platform/documentation)。
 *   本文件**每请求从 A 类白名单现算**, 不复制清单、不写死条目 —— 白名单扩一条, 本接口立刻多一条;
 *   这正是"活"的含义, 也是它不能与静态档合并的原因。
 *
 * 【数据源】(单一来源, 不二次维护)
 *   - 可调接口清单: READONLY_PROTOCOL_WHITELIST (A 类只读; method/前缀/入参 schema 三件套);
 *   - 鉴权状态:     仅反映**调用方请求是否携带平台凭证头**, 不校验凭证有效性
 *                    (有效性校验在各自 route/网关; 此处不越权代替, 故标注 presence_only)。
 *
 * 【只读纪律】无 DB/网络/fs; 纯函数, 可被探针直调复算。
 *
 * 复算: cd packages/apps/mind && ../../../node_modules/.bin/tsx --tsconfig tsconfig.json \
 *         ../../../scripts/probes/probe-platform-documentation.ts
 */
import { READONLY_PROTOCOL_WHITELIST } from "./readonly-protocol-whitelist";

/** 调用方鉴权状态 (presence_only: 只看是否带凭证, 不判有效) */
export interface CallerAuthState {
  /** 是否携带平台凭证头 (x-api-key / x-bootstrap-key) */
  credentialProvided: boolean;
  /** 凭证来源头名 (未携带为 null) */
  credentialHeader: string | null;
  /** 模式: api-key | anonymous */
  mode: "api-key" | "anonymous";
  /** 判定口径诚实声明 */
  note: string;
}

/** 单个可调接口 (活条目: 每请求从白名单现算) */
export interface CallableInterface {
  tier: "A";
  risk: "readonly";
  method: "GET";
  endpointPrefix: string;
  /** 允许的入参名 (空数组 = 无入参) */
  params: string[];
  /** 是否已开放 (A 类恒 true) */
  open: true;
  description: string;
}

export interface PlatformCapabilities {
  kind: "dynamic";
  /** 本次生成时刻 (动态接口, 每次请求不同) */
  at: string;
  /** 生成来源: 运行时白名单, 非静态文件 */
  derivedFrom: string;
  summary: string;
  /** 与 documentation 的显式边界 (防两接口塌成一个) */
  boundary: {
    capabilitiesAnswers: string;
    documentationAnswers: string;
    documentationEndpoint: string;
    rule: string;
  };
  auth: CallerAuthState;
  interfaces: CallableInterface[];
  count: number;
}

/** 从请求头判定调用方鉴权状态 (presence_only, 不校验有效性) */
export function resolveCallerAuth(headers: Headers): CallerAuthState {
  const apiKey = headers.get("x-api-key");
  const bootstrap = headers.get("x-bootstrap-key");
  const header = apiKey ? "x-api-key" : bootstrap ? "x-bootstrap-key" : null;
  return {
    credentialProvided: header !== null,
    credentialHeader: header,
    mode: header ? "api-key" : "anonymous",
    note: "presence_only: 仅反映请求是否携带平台凭证头, 不校验凭证有效性 (有效性在各自 route/网关)",
  };
}

/**
 * 生成动态能力清单: 每请求从 A 类白名单现算 (白名单是唯一来源)。
 * @param headers 调用方请求头 (用于鉴权状态; 传空 Headers 表示匿名)
 */
export function describePlatformCapabilities(headers?: Headers): PlatformCapabilities {
  const interfaces: CallableInterface[] = READONLY_PROTOCOL_WHITELIST.map((e) => ({
    tier: "A" as const,
    risk: "readonly" as const,
    method: e.method,
    endpointPrefix: e.endpointPrefix,
    params: e.inputSchema.map((p) => p.name),
    open: true as const,
    description: e.description,
  }));

  return {
    kind: "dynamic",
    at: new Date().toISOString(),
    derivedFrom: "src/config/readonly-protocol-whitelist.ts (A 类只读白名单, 运行时现算)",
    summary:
      "我能调什么: 当前可用的 A 类只读接口活清单 + 调用方鉴权状态。平台静态能力边界请用 GET /api/v1/platform/documentation。",
    boundary: {
      capabilitiesAnswers: "我现在能调什么 (动态活接口列表 + 鉴权状态)",
      documentationAnswers: "平台是什么 (静态档: 能力边界/服务清单/限制条件/版本兼容矩阵)",
      documentationEndpoint: "GET /api/v1/platform/documentation",
      rule:
        "capabilities=动态(每请求从白名单现算, 随白名单扩缩而变); documentation=静态(带版本号的人工事实档)。" +
        "二者不可合并: 合并会让静态档随运行时抖动, 也会让活清单被静态陈述掩盖。",
    },
    auth: resolveCallerAuth(headers ?? new Headers()),
    interfaces,
    count: interfaces.length,
  };
}
