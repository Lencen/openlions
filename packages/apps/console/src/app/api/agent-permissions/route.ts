import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import { one } from "@/lib/server/lions-db";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";
import { hostname } from "node:os";

// 2026-10-15 round-78: 读实时数据 —— 上游 mind 授权矩阵 + 直读 mind 库(MIND_DB)。授权变更必须立刻可见,
//   冻结快照会让"权限管理"页显示编译时刻的旧授权。本文件导出 POST(hasNonStaticMethods)故构建期已 bailout,
//   仍显式声明以统一口径/防回归, 并避免 build 期直读生产库。
export const dynamic = "force-dynamic";

// GET /api/agent-permissions — 全量 agent × service 授权矩阵 (含 REVOKED)
// POST /api/agent-permissions — 四种动作(2026-09-14 补齐后两种):
//   { action: 'grant'|'revoke', agent_id, service_name }                        整服务授权/取消(会换发 key)
//   { action: 'set_permissions', agent_id, service_name, permissions: string[] } 只改权限子集(**不换 key**)
//   { action: 'set_tier', agent_id, tier: 0..3, reason? }                        能力分级 T0-T3
// 2026-09-07: 业务授权按服务粒度管理 (approve 勾选业务 + 单独取消/补发)
// 2026-09-14 用户反馈"无法在 agent 详情中对 agent 权限进行调整": 排查确认前端只有 grant/revoke,
//   权限列是只读文本; 后端也缺"只改权限"的管理过程(setServicePermissions/setCapabilityTier 本次新增)。
// 2026-09-22 (前置-4): 能力分级调整不再只改服务端 profile, 联动客户端 .env + restart macs-responder,
//   避免 profile/tier 升了但 .env 还 TASK_WORKER=0/没有 CLAIM_TYPES 导致的"挂了 T 标签但活儿派不出去"漂移。
//   noEgress=true (大脑路径有不可控外发风险) 的 agent 永远锁在 T0, 不参与升档联动。

const TRPC = (process.env.LIONS_MIND_URL || "http://127.0.0.1:3000").replace(/\/$/, "") + "/api/trpc";
const ADMIN = process.env.MIND_ADMIN_API_KEY || "";
// 2026-10-21 清理：本路由早已改走 PG（lions-db 的 one()），better-sqlite3 的 import 与 MIND_DB 常量
//   都是死代码，留着会让"console 是否还直连 SQLite"的巡检误报。已删除。

async function callTrpc(path: string, body?: any) {
  const init: any = { cache: "no-store" as any };
  if (body) {
    init.method = "POST";
    init.headers = { "x-admin-key": ADMIN, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  } else {
    init.headers = { "x-admin-key": ADMIN };
  }
  const res = await fetch(`${TRPC}/${path}`, init);
  const data = await res.json();
  const r = data?.result?.data?.json || data?.result?.data || data;
  if (!res.ok) {
    const err = typeof r === "object" && r ? (r as any).message || (r as any).error?.message : r;
    throw new Error(String(err || "内部接口调用失败"));
  }
  return r;
}

/** tier -> 候选 CLAIM_TYPES (P1: 升档时 patch .env)。 */
function claimTypesForTier(t: number): string[] {
  if (t <= 0) return [];
  if (t === 1) return ["DISCUSSION_QUESTION"];
  if (t === 2) return ["DISCUSSION_QUESTION", "VERIFY_AGENT_OUTPUT", "VERIFICATION"];
  return [
    "DISCUSSION_QUESTION",
    "VERIFY_AGENT_OUTPUT",
    "VERIFICATION",
    "THEME_IMPROVE",
    "PLATFORM_REVIEW",
    "GOAL_GAP",
  ];
}

/**
 * 2026-11-02 开源清理：**机器相关地址不再写在代码里**。
 *
 * 原实现把 11 个 agent 的 `user@<内网地址>` 与 `root@<内网段>.<host>` 硬编码在本文件，
 * 开源发布时会泄露内网段与账号名。现改为两条配置：
 *
 *   AGENT_SSH_TARGETS   agentId=user@host,agentId=user@host  （无默认值；空 = 未登记）
 *   AGENT_HOST_PREFIX   仅当 AgentRegistry.host 是纯数字时，用它拼 `root@<PREFIX>.<host>`
 *                       默认 127.0.0.1（开源默认值必须是无害的环回地址）
 *
 * 主平台在 unit/env 里把这两条设成实际值即保持原有行为；未配置时退化为"解析不到 ssh target"，
 * 不会静默连到某个内网地址。
 */
function sshTargetsFromEnv(): Record<string, string> {
  const raw = String(process.env.AGENT_SSH_TARGETS || "").trim();
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim().replace(/-/g, "_");
    const v = pair.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function hostPrefix(): string {
  const p = String(process.env.AGENT_HOST_PREFIX || "").trim();
  return p || "127.0.0.1";
}

function resolveSshTarget(agentId: string, host: string): string {
  const known = sshTargetsFromEnv()[agentId.replace(/-/g, "_")];
  if (known) return known;
  if (!host) return "";
  if (/^\d+$/.test(host)) return `root@${hostPrefix()}.${host}`;
  return host;
}

/** 读 agent host 与 noEgress 标记（2026-10-21 Phase 2: 改用 PG 连接池）。 */
async function readAgentMeta(agentId: string): Promise<{ host: string; noEgress: boolean }> {
  try {
    const row = await one(
      "SELECT host, json_extract(profile,'$.noEgress') AS noEgress FROM AgentRegistry WHERE agent_id = $1",
      agentId
    ) as { host: string | null; noEgress: number | null } | null;
    if (!row) return { host: "", noEgress: false };
    return {
      host: String(row.host || ""),
      noEgress: Number(row.noEgress || 0) === 1,
    };
  } catch {
    return { host: "", noEgress: false };
  }
}

// 本机 .ssh/known_hosts + 免密 key 通常只配到 101 本机用户; console 跑在 101 时
// ssh 到本机自己的内网地址会失败。直接 execFileSync(本地) 即可, 不走 ssh 绕一圈。
function isLocalHost(host: string, sshTarget: string): boolean {
  if (hostname() === sshTarget) return true;
  if (host === "101" || host === hostname()) return true;
  if (sshTarget.endsWith("@" + hostname()) || sshTarget === hostname()) return true;
  return false;
}

/**
 * tier 升档后联动 agent 客户端:
 *   1. patch ~/.config/mcp-chat/agent-$id.env:
 *      - TASK_WORKER=0 -> TASK_WORKER=1
 *      - CLAIM_TYPES=<tier 推导列表>
 *   2. systemctl --user restart macs-responder-$id
 *   3. noEgress=true 直接拒绝联动(.env 不动)
 * 推送通道: 本机直接 execFileSync("bash"); 远机走 ssh BatchMode.
 * `core` 异常视为 ok:false, 但不影响 mind 端的 tier 设置成功(已有 trpc.ok)。
 * 集成者后续可在 console server 上配 ~/.ssh/known_hosts + 把 101/100/104 的
 * 公钥放进去(同 deploy-responders.sh 信任链), 推送就能走通。
 */
async function pushClientConfig(agentId: string, tier: number): Promise<{ ok: boolean; detail: string }> {
  const { host, noEgress } = await readAgentMeta(agentId);
  if (noEgress) {
    return { ok: false, detail: "noEgress=true, .env 不联动(大脑路径不可控外发, 永远锁 T0)" };
  }
  if (tier <= 0) {
    return { ok: false, detail: "tier=0 不联动 .env(由 noEgress 守门或人工决定 TASK_WORKER=0)" };
  }
  const sshTarget = resolveSshTarget(agentId, host);
  if (!sshTarget) {
    return { ok: false, detail: `AgentRegistry.host=${host} 解析不到 ssh target（AGENT_SSH_TARGETS 未登记且 host 不是数字）` };
  }
  const types = claimTypesForTier(tier);
  const typesStr = types.join(",");
  const envPath = `~/.config/mcp-chat/${agentId}.env`;
  const local = isLocalHost(host, sshTarget);
  const cmds = [
    `sed -i 's/^TASK_WORKER=.*/TASK_WORKER=1/' ${envPath}`,
    `grep -q '^CLAIM_TYPES=' ${envPath} && sed -i 's/^CLAIM_TYPES=.*/CLAIM_TYPES=${typesStr}/' ${envPath} || echo CLAIM_TYPES=${typesStr} >> ${envPath}`,
    `systemctl --user restart macs-responder-${agentId}.service`,
  ].join(" && ");
  try {
    if (local) {
      execFileSync("bash", ["-c", cmds], { timeout: 30000, encoding: "utf8" });
      return {
        ok: true,
        detail: `local (${hostname()}): .env 写入 TASK_WORKER=1, CLAIM_TYPES=${typesStr}, restart macs-responder`,
      };
    }
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", sshTarget, cmds], {
      timeout: 30000,
      encoding: "utf8",
    });
    return {
      ok: true,
      detail: `${sshTarget}: .env 写入 TASK_WORKER=1, CLAIM_TYPES=${typesStr}, restart macs-responder`,
    };
  } catch (e: any) {
    // SSH 失败是部署问题, 不阻断 tier 设置成功(已落到 mind), 留给集成者修复 ssh 信任。
    return {
      ok: false,
      detail: `${local ? "local" : sshTarget} 推送失败(集成者需修 SSH 信任或跑 deploy-responders.sh): ${String(e?.message || e).slice(0, 200)}`,
    };
  }
}

export async function GET() {
  try {
    const agents = await callTrpc("agent.list?input=%7B%22json%22%3Anull%7D");
    const list = Array.isArray(agents) ? agents : [];
    return NextResponse.json(list);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action, agent_id, service_name, permissions, tier, reason } = body;
    if (!action || !agent_id) {
      return NextResponse.json({ error: "missing action/agent_id" }, { status: 400 });
    }

    // 0.4.40-02 批2：权限校验（PLATFORM_WRITE_AUTH）+ 二次确认（PLATFORM_WRITE_CONFIRM）
    const guard = requirePlatformWrite(req, "perm.grant", body as Record<string, unknown>);
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    // 审计用 before：读当前授权行（读不到就是空，不阻断业务）
    let beforeRow: Record<string, unknown> = {};
    if (service_name) {
      try {
        const row = await one(
          "SELECT status, permissions FROM AgentServicePermission WHERE agent_id = $1 AND service_name = $2 LIMIT 1",
          agent_id, String(service_name)
        ) as Record<string, unknown> | null;
        if (row) beforeRow = { status: row.status, permissions: row.permissions };
      } catch { /* 读不到不阻断 */ }
    }
    const auditAuth = async (act: string, changeType: string, after: Record<string, unknown>): Promise<string | undefined> => {
      try {
        const audit = await writeAudit({
          entityType: "PlatformAuth",
          entityId: [agent_id, service_name].filter(Boolean).join("/"),
          action: "platform.auth." + act,
          before: beforeRow,
          after,
          actor: { id: guard.actorId, type: "human" },
          changeType,
          confirmed: true,
        });
        return audit.id;
      } catch (e) {
        // 审计失败按 fail-closed 处理（与批1 model-config 同口径）
        throw new Error("AUDIT_WRITE_FAILED: " + String((e as Error)?.message || e));
      }
    };
    if (action === "set_tier") {
      const t = Number(tier);
      if (!Number.isInteger(t) || t < 0 || t > 3) {
        return NextResponse.json({ error: "tier 必须是 0..3 的整数" }, { status: 400 });
      }
      const { noEgress } = await readAgentMeta(agent_id);
      if (noEgress && t > 0) {
        return NextResponse.json(
          {
            error: `agent ${agent_id} 标记了 noEgress(大脑路径有不可控外发风险), 拒绝升档到 T${t}; 仅允许 T0。`,
          },
          { status: 403 }
        );
      }
      const result = await callTrpc("agent.setCapabilityTier", { json: { agent_id, tier: t, reason } });
      const auditId = await auditAuth("update_tier", "update", { tier: t, reason: reason || "" });
      const client = await pushClientConfig(agent_id, t);
      return NextResponse.json({
        ok: true,
        trpc: result,
        clientPush: client,
        auditId,
      });
    }
    if (!service_name) {
      return NextResponse.json({ error: "missing service_name" }, { status: 400 });
    }
    if (action === "set_permissions") {
      if (!Array.isArray(permissions)) {
        return NextResponse.json({ error: "permissions 必须是字符串数组" }, { status: 400 });
      }
      const result = await callTrpc("agent.setServicePermissions", { json: { agent_id, service_name, permissions } });
      const auditId = await auditAuth("update", "update", { permissions });
      return NextResponse.json({ ...(result as Record<string, unknown>), auditId });
    }
    const proc = action === "grant" ? "agent.grantServiceToAgent" : action === "revoke" ? "agent.revokeServiceFromAgent" : null;
    if (!proc) return NextResponse.json({ error: "action must be grant|revoke|set_permissions|set_tier" }, { status: 400 });
    const result = await callTrpc(proc, { json: { agent_id, service_name } });
    const auditId = await auditAuth(action === "grant" ? "grant" : "revoke", action === "grant" ? "grant" : "revoke", { granted: action === "grant" });
    return NextResponse.json({ ...(result as Record<string, unknown>), auditId });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
