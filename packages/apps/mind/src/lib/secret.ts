/**
 * secret.ts — 凭据单点读取 + 严格模式 (2026-09-10 安全硬化)
 *
 * 背景(首版安全审计发现): `lions-session-dev-key` 等开发默认 key 以 `|| "..."` 形式散落在正式代码 26 处;
 *   离线交付(商业化路径: 打包订阅授权 + 离线部署)后, 这些默认值等于公开凭据 -> 任何拿到包的人都能读写平台数据。
 *
 * 策略:
 *   - 严格模式(LIONS_STRICT_SECRETS=1, 交付/生产必须开启): 缺失即抛错 -> 服务拒绝启动/接口拒绝执行, 绝不回退默认值。
 *   - 宽松模式(默认, 便于本地开发): 回退开发默认值, 但每个变量只告警一次, 提醒尽快配置。
 */
const warned = new Set<string>();
const DEV_DEFAULT = "lions-session-dev-key";

export function strictSecrets(): boolean {
  return process.env.LIONS_STRICT_SECRETS === "1";
}

export function requireSecret(name: string, devDefault?: string): string {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  if (strictSecrets()) {
    throw new Error("[secret] 严格模式(LIONS_STRICT_SECRETS=1)下缺少必需环境变量: " + name + " — 拒绝使用开发默认值(离线交付安全要求)");
  }
  if (!warned.has(name)) {
    warned.add(name);
    console.warn("[secret] " + name + " 未配置, 回退开发默认值(仅限本地开发; 交付前请设 LIONS_STRICT_SECRETS=1)");
  }
  return devDefault ?? DEV_DEFAULT;
}

/** 会话服务 key(跨 app 统一: 兼容三个历史变量名) */
export function sessionApiKey(): string {
  return requireSecret("LIONS_SESSION_API_KEY")
    || requireSecret("SESSION_SERVICE_API_KEY")
    || requireSecret("LIONS_UPLOAD_API_KEYS");
}
