/**
 * mind-client.ts — portal 调用 mind **服务间接口**的唯一出口 (2026-10-15 架构收敛)
 *
 * 为什么有本文件: portal 原先直连 Prisma 写 mind 生产库(违反 scripts/DB-ACCESS-RULE.md §1),
 *   使 `scripts/mind-db-recover.cjs` 的"除 mind 外 0 持有者"硬闸常态 exit 4(库损坏连续数周不修)。
 *   3 个写点(ingest / heartbeat / 读计数)改为转发 mind 的 `/api/v1/*`, 本文件是那次转发的
 *   **单点 HTTP 出口**: 统一取 base URL / service key / 超时 / 错误归一, 便于日后审计与替换。
 *
 * 服务凭据(优先级: 环境变量 > env 文件, **不落代码**):
 *   · LIONS_MIND_SERVICE_KEY  优先 —— 与仓库既有命名一致(packages/apps/mcp-server/src/mind-client.ts:45)
 *   · LIONS_MIND_API_KEY      兼容别名
 *   值必须是 AgentServicePermission 表里 status=ACTIVE 的 `sk-mind-*` service key。
 *   **缺失时不回退直连数据库**: 直接返回 mind_service_key_missing, 由调用方 503 明确报错(fail-closed)。
 *
 * env 文件兜底(2026-10-22, todo_255d3a324658416c9919 spec:registry-heartbeat-not-frozen):
 *   心跳是**两跳链路** portal -> mind `POST /api/v1/agents/seen`, 而 `AgentRegistry.last_seen_at`
 *   的唯一写者就是 mind 那一跳。实测根因: portal 单元只注了 NODE_OPTIONS/LIONS_NEXT_CMD/
 *   MIND_DB_DRIVER, **没有任何 LIONS_MIND_* 变量**, 于是第二跳恒缺凭据:
 *       POST /api/portal/heartbeat -> "warning":"last_seen_at 未更新: mind_service_key_missing",
 *                                     "last_seen_written": false, "last_seen_at_source": "db"
 *   -> 全平台 7 个 ACTIVE 身份 last_seen_at 同刻停跳 155.5h(极差 172s), 触发 spec:registry-heartbeat-not-frozen,
 *      并连带使 fix-stale-agent-status / revoke-orphan-service-keys / check-orphan-service-keys
 *      判「活/死」的结论在通道恢复前不可信。
 *   同一把 key 其实**就在仓库里**(packages/apps/mind/.env.local), 只是 portal 没去读。
 *   本兜底不是新发明, 是把仓库已有做法收敛到同一处:
 *     · packages/apps/mcp-server/src/mind-client.ts:52-72  env -> keyFile 两路;
 *     · packages/apps/portal/src/lib/mind-read.ts:13-14   LIONS_PG_PASSWORD_FILE -> run/pg-password -> PGPASSWORD;
 *     · scripts/lib/mind-service.cjs:56-82                pick() = env 两轮 + 文件两轮。
 *   仍然 fail-closed: 文件缺失/无 key 时照样返回 mind_service_key_missing, 只是错误串多告诉运维
 *   **去哪儿找**(且**不打印密钥本身**), 避免再出现「现场无从判断是缺配置还是通道坏了」。
 *
 * base URL: LIONS_MIND_BASE_URL(默认 http://localhost:3000, 与 @/lib/platform-guide 的 operator 分支一致)。
 */
import fs from "fs";

const DEFAULT_MIND_BASE_URL = (process.env.LIONS_MIND_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

/** 与 scripts/lib/mind-service.cjs:54 同款 env 文件路径约定(可用 LIONS_MIND_ENV_FILE 覆盖)。 */
const DEFAULT_MIND_ENV_FILE =
  (process.env.LIONS_HOME || process.cwd()) + "/packages/apps/mind/.env.local";

/** 只认这几个名, 且 env 优先于文件(与 mcp-server / mind-service 完全同口径)。 */
const KEY_NAMES = ["LIONS_MIND_SERVICE_KEY", "LIONS_MIND_API_KEY"] as const;

function envFilePath(): string {
  return String(process.env.LIONS_MIND_ENV_FILE || DEFAULT_MIND_ENV_FILE);
}

/** 从 env 文件里取 key: 支持 `KEY=value` / `export KEY=value` / 引号包裹 / 行尾注释。 */
function keyFromEnvFile(file: string): string {
  try {
    if (!fs.existsSync(file)) return "";
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const name = m[1];
      if (!(KEY_NAMES as readonly string[]).includes(name)) continue;
      const raw = m[2].trim().replace(/\s+#.*$/, "");
      const val = raw.replace(/^(['"])(.*)\1$/, "$2").trim();
      if (val) return val;
    }
  } catch {
    /* 文件不可读 = 当作未配置, 交给调用方 fail-closed */
  }
  return "";
}

export interface MindCallResult<T = any> {
  ok: boolean;
  /** HTTP 状态码; 0 = 未发出请求(缺凭据)或网络层失败 */
  status: number;
  data: T | null;
  error?: string;
}

/** mind 基址(末尾斜杠已裁掉) */
export function mindBaseUrl(): string {
  return (process.env.LIONS_MIND_BASE_URL || DEFAULT_MIND_BASE_URL).replace(/\/+$/, "");
}

/** 凭据来源描述(只报来源, **不打印密钥**), 让 503 能直接告诉运维去哪儿找。 */
export function mindServiceKeySource(): string {
  for (const n of KEY_NAMES) {
    if (String(process.env[n] || "").trim()) return "env:" + n;
  }
  const file = envFilePath();
  for (const n of KEY_NAMES) {
    if (keyFromEnvFile(file)) return "file:" + file + ":" + n;
  }
  return "(未配置)";
}

/** portal 侧服务凭据(优先 SERVICE_KEY, 回落 API_KEY; env -> env 文件; 与 mcp-server 同口径) */
export function mindServiceKey(): string {
  for (const n of KEY_NAMES) {
    const v = String(process.env[n] || "").trim();
    if (v) return v;
  }
  return keyFromEnvFile(envFilePath());
}

/** 凭据是否就位(路由可据此给出可执行的 503 提示) */
export function mindServiceKeyConfigured(): boolean {
  return mindServiceKey().length > 0;
}

/**
 * POST 到 mind 的 v1 接口。
 * 刻意**不抛异常**: 调用方按 `ok/status` 决定对外状态码(3 个写点的失败语义各不相同)。
 */
export async function callMind<T = any>(
  path: string,
  body: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<MindCallResult<T>> {
  const key = mindServiceKey();
  if (!key) {
    return {
      ok: false,
      status: 0,
      data: null,
      error:
        "mind_service_key_missing: portal 未配置 mind 服务凭据; 请配置环境变量 LIONS_MIND_SERVICE_KEY, " +
        "或在 " + envFilePath() + " 里配置 LIONS_MIND_SERVICE_KEY(AgentServicePermission 的 sk-mind-* service key)。" +
        "当前查找来源: " + mindServiceKeySource(),
    };
  }

  const timeoutMs = opts.timeoutMs ?? 4000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${mindBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify(body ?? {}),
      signal: ac.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, status: res.status, data: null, error: `mind 返回非 JSON: ${text.slice(0, 120)}` };
    }
    return { ok: res.ok && data?.ok !== false, status: res.status, data, error: data?.error };
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      data: null,
      error: aborted ? `mind 超时(${timeoutMs}ms): ${path}` : `mind 不可达: ${String(e?.message || e).slice(0, 160)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
