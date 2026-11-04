import { prisma } from "@/lib/prisma";

/**
 * lib/mind-sync.ts — 拉 mind tRPC 的 SessionRegistry, 镜像到 lions-session
 *
 * 数据流方向:
 *   mind (元信息 + 提取状态 + summary) → lions (作为 session 元信息镜像)
 *
 * 策略:
 *   1. 按 sortBy=updated_at desc 增量拉 (上次 mindSyncedAt 之后的)
 *   2. upsert by sessionUid (全局唯一 key)
 *   3. 不写 messages (mind 里只有摘要, 不是原文)
 *   4. 不动 fullSyncedAt / fullSyncSource (那是 lions 自己的原文同步状态)
 *
 * Pitfall (P3-9): mind tRPC v11 input 必须 {json: {...}} 包装. 响应是 result.data.items (无 json 包装).
 */

/**
 * mind 端点: session 与 mind **同机部署**(mind 3000 / session 3002), 默认走回环即可。
 *
 * 2026-10-12 (round 72-AM): 原默认值是 `http://[internal-ip]:3000` —— 那是**本机旧的 Tailscale 地址**。
 *   本机 tailscale 当前是 `NeedsLogin`(`tailscale ip -4` 无输出), 该地址**已不可达**:
 *   实测 `curl --max-time 6 http://[internal-ip]:3000` 超时(exit 124), 而**同一请求**打
 *   `127.0.0.1:3000/api/trpc/sessionRegistry.list` 返回 HTTP 200 且数据形状正确。
 *
 *   后果是这条链路**静默死掉**: lib/scheduler.ts 每 10 分钟调一次 syncFromMind, 日志里
 *   `[lions-session] Mind sync failed: ConnectTimeoutError (attempted address: [internal-ip]:3000, timeout 10000ms)`,
 *   而失败只进 `console.error` —— 不建待办、不上报、不影响健康检查, 所以没人发现。
 *
 *   判据(说明这是**回归**而不是"从未工作过"): session 库里已有 **5,038 行** `mindSyncedAt IS NOT NULL`,
 *   即 Tailscale 在线时这条镜像链路是真跑通过的。
 *
 *   同机部署没有理由绕自己的 Tailscale 地址(那既多一跳, 又多一个"离线即静默失效"的依赖);
 *   跨机场景仍可用 `MIND_ENDPOINT` 覆盖, 语义不变。
 */
const MIND_ENDPOINT = process.env.MIND_ENDPOINT || "http://127.0.0.1:3000";
const PAGE_SIZE = 200;

interface MindSessionRow {
  id: string;
  session_uid: string;
  agent_id: string;
  source: string;
  source_id: string;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_message_at: string | null;
  message_count: number;
  status: string;
  processed_at: string | null;
  processing_error: string | null;
  payload_size: number;
  uploaded_at: string;
  updated_at: string;
}

async function fetchMindPage(offset: number, limit: number): Promise<{ items: MindSessionRow[]; total: number }> {
  const input = encodeURIComponent(JSON.stringify({
    json: { limit, offset, sortBy: "updated_at", sortOrder: "desc" }
  }));
  const url = `${MIND_ENDPOINT}/api/trpc/sessionRegistry.list?input=${input}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`mind tRPC ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const data = body?.result?.data;
  if (!data) throw new Error(`mind response shape unexpected: ${JSON.stringify(body).slice(0, 200)}`);
  return {
    items: data.items as MindSessionRow[],
    total: Number(data.total ?? 0),
  };
}

function safeDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Agent_id 到 display name 的本地映射 (mind 那边没有 join 出来, lions 这边做 hardcode)
 */
const AGENT_NAMES: Record<string, string> = {
  "agent-h": "UT (hermes/本机)",
  "agent-g": "UTC (claude)",
  "agent-b": "[host]",
  "agent-c": "agent-x-host",
};

/**
 * Channel 推断: source → 渠道标签 (用于列表过滤)
 * 2026-07-02 收敛: agent-h 的 HERMES_SESSION 不再区分 local/remote, 统一 "hermes"
 * (原 hermes-local 遗留在 DB 里那批 1446 条会被 cleanup 脚本清掉)
 */
function inferChannel(source: string, agentId: string): string {
  if (source === "HERMES_SESSION") {
    return "hermes";
  }
  if (source === "CLAUDE_CONVERSATION") return "claude";
  return source.toLowerCase();
}

export async function syncFromMind(opts?: { fullResync?: boolean }): Promise<{ updated: number; inserted: number; total: number; scanned: number; mode: string; watermark: string | null }> {
  const fullResync = opts?.fullResync === true;
  let inserted = 0;
  let updated = 0;
  let scanned = 0;
  let offset = 0;
  let total = 0;
  const now = new Date();

  // V2 增量水位线: 取本地最新的 updatedAt (Session.updatedAt = @updatedAt 自动更新)
  // 由于 mind 端按 updated_at desc 排序, 遇到 it.updated_at <= watermark 就早停
  let watermark: Date | null = null;
  if (!fullResync) {
    const latest = await prisma.session.findFirst({
      where: { mindSyncedAt: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    if (latest) {
      // 留 60s 缓冲, 避免 mind 端 update_at 时区/精度漂移漏数据
      watermark = new Date(latest.updatedAt.getTime() - 60_000);
    }
  }

  // no-constant-condition: `for (;;)` 与 `while (true)` 完全等价(都是无循环条件, 靠 break 退出);
  //   这里是仓库既有风格, `break outer` 的语义与标签都不变。
  outer: for (;;) {
    const { items, total: t } = await fetchMindPage(offset, PAGE_SIZE);
    total = t;
    if (items.length === 0) break;

    for (const it of items) {
      scanned++;
      // 增量早停: items 已按 updated_at desc 排序, 一旦遇到 <= watermark, 后续都更老
      if (watermark && it.updated_at) {
        const itTs = new Date(it.updated_at);
        if (!Number.isNaN(itTs.getTime()) && itTs <= watermark) {
          break outer;
        }
      }
      try {
      const existing = await prisma.session.findUnique({
        where: { sessionUid: it.session_uid },
      });

      const mindFields = {
        sessionUid: it.session_uid,
        agentId: it.agent_id,
        agentName: AGENT_NAMES[it.agent_id] || it.agent_id,
        source: it.source,
        sourceId: it.source_id,
        channel: inferChannel(it.source, it.agent_id),
        title: it.title || existing?.title || null,
        extractStatus: it.status,
        extractedAt: safeDate(it.processed_at),
        extractError: it.processing_error,
        mindSyncedAt: now,
        // 这些字段只在 INSERT 时设, UPDATE 不动 (避免回退 lions 自己同步的原文计数)
      };

      if (existing) {
        await prisma.session.update({
          where: { id: existing.id },
          data: mindFields,
        });
        updated++;
      } else {
        // 占位 session (没有原文, 等 hermes-local sync 或远端 push)
        await prisma.session.create({
          data: {
            id: it.id, // 用 mind 的 id 做本地 PK (cuid 防冲突)
            platform: inferChannel(it.source, it.agent_id),
            startedAt: safeDate(it.started_at) || safeDate(it.uploaded_at) || now,
            lastMessageAt: safeDate(it.last_message_at),
            endedAt: safeDate(it.ended_at),
            messageCount: 0, // 没有原文
            toolCallCount: 0,
            isActive: !it.ended_at,
            ...mindFields,
          },
        });
        inserted++;
      }
      } catch (e) {
        console.error(`[mind-sync] failed for ${it.session_uid}:`, e instanceof Error ? e.message : String(e));
        console.error('  item:', JSON.stringify(it).slice(0, 500));
      }
    }

    offset += items.length;
    if (offset >= total) break;
  }

  return {
    updated,
    inserted,
    total,
    scanned,
    mode: fullResync ? "full" : watermark ? "incremental" : "initial",
    watermark: watermark ? watermark.toISOString() : null,
  };
}
