import fs from "node:fs";
import path from "node:path";

// mind-admin.ts — console -> mind 的**管理员身份头**单点（2026-10-23 资产归属 R2-b）
//
// 为什么需要：mind 的记忆读接口从 2026-10-23 起按归属过滤（私有记忆只给所属 agent）。
//   console 是平台管理端，必须看到全量，否则 agent 一写私有记忆，看板就静默变少。
//   身份用 x-admin-key（MIND_ADMIN_API_KEY）—— 与 mind 的 root_admin 对齐，不是把 console 变成某个 agent。
//
// 注意：未配置 MIND_ADMIN_API_KEY 时返回 undefined（不带头），console 会退化成"匿名视图"（只看公共/无主行）。
//   这是**可见的降级**（数字变小），不是静默放行 —— 配好 env 即恢复。
function readKeyFromMindEnv(): string {
  // 2026-10-25: console 的 systemd unit 里没有 MIND_ADMIN_API_KEY（实测），而 mind 自己的 .env.local 里有。
  //   让 console 进程复制一份密钥属于"把同一个 secret 写两处"，容易漂移；这里改成**服务端只读**地取 mind 的那份
  //   （仅本机文件读取，不入浏览器、不进构建产物）。优先级：env > MIND_ADMIN_KEY_FILE > mind/.env.local。
  const candidates = [
    process.env.MIND_ADMIN_KEY_FILE,
    path.join(process.cwd(), "..", "mind", ".env.local"),
    "~/lions/packages/apps/mind/.env.local",
  ].filter(Boolean) as string[];
  for (const f of candidates) {
    try {
      const txt = fs.readFileSync(f, "utf8");
      const m = txt.match(/^MIND_ADMIN_API_KEYs*=s*(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {}
  }
  return "";
}

export function mindAdminHeaders(): Record<string, string> | undefined {
  const key = process.env.MIND_ADMIN_API_KEY || readKeyFromMindEnv();
  return key ? { "x-admin-key": key } : undefined;
}
