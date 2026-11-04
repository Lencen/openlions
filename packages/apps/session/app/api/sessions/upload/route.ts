import { requireSecret } from "@/lib/secret";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildMessageId } from "@/lib/messageIdentity";
import { verifyMindApiKey } from "@/lib/mindAuth";

// ===== 2026-09-03: 自动化会话治理 =====
// 1) 系统注入消息规范化: 客户端常把 heartbeat / cron 任务 / [IMPORTANT] 等系统注入标成 role=user,
//    UI 与提炼管线会把它们当用户消息 (agent-x 反馈: 一些不是 user 发的被判成 user)。
//    平台侧兜底: 命中前缀 → role=system (不管客户端版本, 一律修正)。
// 2) 自动化会话标记 SKIPPED: openclaw cron run / hook / 无真实 user 的纯自动化产出
//    → extractStatus=SKIPPED, mind 提炼管线 (status=PENDING 拉取) 不会消费 → 不烧 API/token。
//    真实会话 (有 role=user) 保持 PENDING 正常提炼。
const SYSTEM_INJECT_PREFIXES = [
  "[OpenClaw heartbeat poll]",
  "Task: Hook | Job ID:",
  "[cron:",
  "[IMPORTANT]: You are running as a scheduled cron job",
  "[IMPORTANT: You are running as a scheduled cron job",
  "[IMPORTANT]: Background process",
  "[IMPORTANT: Background process",
  "[IMPORTANT: The user has invoked the",
  "[IMPORTANT: MCP servers have been reloaded",
  "[CONTEXT COMPACTION",
  "[System note:",
  "System: [", // openclaw exec 完成等运行时注入 (2026-09-03 补)
  "[System: Your previous",
  "[Your active task list",
  "[Note: model was just switched",
  "[The user sent an image",
  "[MCP INBOX]",
  "[SYSTEM",
  "[system",
  "Continue the OpenClaw runtime event",
  "Review the conversation above and update the skill library",
  "Review the conversation above and consider saving to memory",
  "Review the conversation above and update two things",
  "You've reached the maximum number of tool-calling iterations",
  "Your previous turn was interrupted",
];

function normalizeRole(role: string | undefined, content: string | null | undefined): string {
  if (role !== "user" || !content) return role || "user";
  const c = content.trimStart();
  for (const p of SYSTEM_INJECT_PREFIXES) {
    if (c.startsWith(p)) return "system";
  }
  return "user";
}

function isAutoSessionSource(sourceId: string | undefined): boolean {
  if (!sourceId) return false;
  return sourceId.startsWith("cron:") || sourceId.startsWith("cron_") || sourceId.startsWith("session_cron_");
}

/**
 * POST /api/sessions/upload
 *
 * 远端 agent 推送 session 原文 (本期只搭骨架, 暂不开放未授权写入).
 *
 * 鉴权: header X-API-Key (后续接入 mind AgentServicePermission api_key_plain).
 *
 * Body:
 * {
 *   agentId: "agent-c",
 *   sessionUid: "agent-c:hermes_session:xxx" (可选, 不传则自动按 source+sourceId 拼),
 *   source: "HERMES_SESSION" | "CLAUDE_CONVERSATION" | "mcp",
 *   sourceId: "xxx",
 *   title: "...",
 *   startedAt: "ISO",
 *   lastMessageAt: "ISO",
 *   model: "minimax-m2.7",
 *   messages: [
 *     { id, role, content, timestamp, toolName?, toolCalls?, tokenCount?, reasoning? }, ...
 *   ]
 * }
 */
export async function POST(req: Request) {
  // V2: 默认启用, 可通过 LIONS_DISABLE_REMOTE_UPLOAD=1 关闭
  const DISABLED = process.env.LIONS_DISABLE_REMOTE_UPLOAD === "1";
  if (DISABLED) {
    return NextResponse.json(
      { success: false, error: "远端 agent 原文上传接口已通过 LIONS_DISABLE_REMOTE_UPLOAD=1 关闭." },
      { status: 503 }
    );
  }

  // V3 auth: 双轨鉴权
  //   ① 固定 key 白名单 (兼容旧脚本, lions-session-dev-key)
  //   ② mind api_key (sk-mind-xxx, 查 AgentServicePermission 表, 反查 agentId)
  const apiKey = req.headers.get("x-api-key");
  const allowedRaw = requireSecret("LIONS_UPLOAD_API_KEYS");
  const allowed = allowedRaw.split(",").map((k) => k.trim()).filter(Boolean);

  let verifiedAgentId: string | null = null; // 从 mind api_key 反查的 agentId

  if (apiKey && allowed.includes(apiKey)) {
    // ① 固定 key 白名单 — 用 body.agentId
  } else if (apiKey?.startsWith("sk-mind-")) {
    // ② mind api_key 校验
    const result = await verifyMindApiKey(apiKey);
    if (!result.agentId) {
      // 2026-10-06: 401 必须**可归因**。此前只回状态码, 平台侧在 session-dev.log 里只看到 "401",
      //   连"是谁在传、哪把 key、哪个 agent"都不知道 —— 实测有少量 401 长期无法定位
      //   (三台在役机器的客户端都自报 fail=0, 说明可能是旁路/旧客户端在用失效 key)。
      //   现记 key 前缀 + 来源 IP + body 里自称的 agentId, 下一次出现即可直接定位。
      const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown-ip";
      let claimedAgent = "";
      try {
        const peek = await req.clone().json();
        claimedAgent = String(peek?.agentId || "");
      } catch { /* body 不可解析则忽略 */ }
      console.warn(`[upload] 401 mind api_key 无效 | key=${String(apiKey).slice(0, 14)}… | ip=${ip} | claimedAgentId=${claimedAgent || "(空)"} | err=${result.error}`);
      return NextResponse.json(
        { success: false, error: `mind api_key 无效: ${result.error}` },
        { status: 401 }
      );
    }
    verifiedAgentId = result.agentId;
  } else {
    const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown-ip";
    console.warn(`[upload] 401 X-API-Key 缺失/格式不符 | key=${String(apiKey || "(无)").slice(0, 14)} | ip=${ip}`);
    return NextResponse.json({ success: false, error: "X-API-Key 缺失或无效" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "JSON 解析失败" }, { status: 400 });
  }

  // agentId: mind api_key 校验通过时从服务端确定 (不信任 body.agentId)
  //          固定 key 时用 body.agentId (兼容旧脚本)
  const agentId = verifiedAgentId || body.agentId;
  const { source, sourceId, title, startedAt, lastMessageAt, endedAt, model, messages } = body || {};
  if (!agentId || !source || !sourceId) {
    return NextResponse.json({ success: false, error: "agentId/source/sourceId 必填" }, { status: 400 });
  }

  const sessionUid: string = body.sessionUid || `${agentId}:${source.toLowerCase()}:${sourceId}`;
  const now = new Date();

  // upsert by sessionUid
  const existing = await prisma.session.findUnique({ where: { sessionUid } });
  // 自动化判定 (2026-09-07 修订, 修复自主 agent 会话被误杀):
  //   ① cron/hook 源 (定时任务执行记录) → SKIPPED 不提炼
  //   ② 非 cron 但既无 user 也无 assistant/tool 工作内容 (纯壳/heartbeat) → SKIPPED
  //   ③ 其余 (有 user 真人对话, 或有 assistant/tool 的自主工作会话如 agent-x/operator) → 进提炼 PENDING
  //   原逻辑 "无 user 即 auto" 误杀了自主 agent (openclaw/hermes 任务驱动, 无人工逐条输入) 的工作会话
  const autoBySource = isAutoSessionSource(sourceId);
  const hasWorkContent = Array.isArray(messages) && messages.some(
    (m: any) => {
      const role = normalizeRole(m?.role, m?.content);
      return role === "user" || role === "assistant" || role === "tool" || role === "toolResult";
    }
  );
  const autoSession = autoBySource || !hasWorkContent;
  const sessionData: Record<string, unknown> = {
    sessionUid,
    agentId,
    source,
    sourceId,
    title: title || existing?.title || null,
    platform: source.toLowerCase(),
    channel: source.toLowerCase(),
    startedAt: startedAt ? new Date(startedAt) : existing?.startedAt || now,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
    endedAt: endedAt ? new Date(endedAt) : null,
    model: model || null,
    isActive: !endedAt,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    fullSyncSource: "remote-push",
    fullSyncedAt: now,
  };
  // 自动化会话 → SKIPPED (不进提炼管线, 不烧 API); 真实/工作会话保持原状态 (PENDING→提炼)
  if (autoSession) {
    sessionData.extractStatus = "SKIPPED";
    sessionData.extractError = "auto session (cron/hook/无工作内容), 不进入提炼管线";
  } else if (existing && existing.extractStatus === "SKIPPED") {
    // 之前被标 SKIPPED 但现在出现真实工作内容 (user 真人 或 assistant/tool 自主工作) → 放回待提炼
    sessionData.extractStatus = "PENDING";
    sessionData.extractError = null;
  }

  // D-02 (2026-09-07): 整体事务化 — Session 写入/消息 upsert/recount 原子一致,
  //   杜绝 4 段独立事务中间失败导致 messageCount 漂移(历史上 56k 克隆的根因之一)。
  //   SyncActivityLog 审计留在事务外: 失败不阻塞主流程(见下方 try/catch)。
  const preExistingMsgIds = new Set<string>();
  let actualCount = 0;
  let msgCount = 0;
  const dbRes = await prisma.$transaction(
    async (tx) => {
      const sess = existing
        ? await tx.session.update({ where: { id: existing.id }, data: sessionData })
        : await tx.session.create({
            // sessionData 为动态字段(Record), spread 后 TS 无法静态推断 — 断言交给运行时校验
            data: { id: body.id || sessionUid.replace(/[^a-zA-Z0-9_-]/g, "_"), ...sessionData } as any,
          });

      // 统计新增消息数需在写入前查已有 id (否则覆盖式写入后全为已存在)
      if (existing && Array.isArray(messages)) {
        const pre = await tx.message.findMany({
          where: { sessionId: sess.id },
          select: { id: true },
        });
        for (const x of pre) preExistingMsgIds.add(x.id);
      }

      // 写消息 (覆盖式 upsert)
      // 2026-09-17 根因修复: content 含 NUL(\u0000) 的行会让 trigram FTS5 建索引产出坏段 ->
      //   message_fts 整体 malformed(3 天反复)。在入口统一剥离 NUL, 保证入库文本无 NUL。
      let written = 0;
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (!m || !m.id) continue;
          const _serialize = (v: any) =>
            v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
          // no-control-regex: 目标是"删掉字符串里所有 NUL", 与旧的 /\u0000/g 全局替换**语义完全相同**;
          //   改用 replaceAll(字符串) 只是为了不在正则字面量里出现控制字符 —— NUL 这个判据本身没变,
          //   上面 2026-09-17 的 FTS5 坏段修复(入库文本必须无 NUL)照旧生效。
          const _stripNul = (v: any) => (typeof v === "string" ? v.replaceAll("\u0000", "") : v);
          const normalizedRole = normalizeRole(m.role, m.content);
          const mid = buildMessageId(agentId, source, String(m.id));
          const msgData = {
            role: normalizedRole,
            content: _stripNul(m.content) || null,
            timestamp: new Date(m.timestamp || now),
            toolCallId: m.toolCallId || null,
            toolName: _stripNul(m.toolName) || null,
            toolCalls: _stripNul(_serialize(m.toolCalls)),
            toolInput: _stripNul(_serialize(m.toolInput)),
            toolOutput: _stripNul(_serialize(m.toolOutput)),
            tokenCount: m.tokenCount ?? null,
            reasoning: _stripNul(m.reasoning) || null,
          };
          await tx.message.upsert({
            where: { id: mid },
            update: { sessionId: sess.id, ...msgData },
            create: { id: mid, sessionId: sess.id, ...msgData },
          });
          written++;
        }
      }

      // 2026-09-04: 权威计数 — 以实际消息行为准
      const realCount = await tx.message.count({ where: { sessionId: sess.id } });
      if (realCount !== (existing?.messageCount ?? null) && realCount > 0) {
        await tx.session.update({ where: { id: sess.id }, data: { messageCount: realCount } });
      }
      msgCount = written;
      return { sess, realCount };
    },
    { timeout: 60_000 },
  );
  // prefer-const: 原先 `let session;` + 这里赋值 = 只赋值一次; 收成 `const` 语义不变
  // (若上面的 $transaction 抛错, 本行根本不会执行 —— 与修复前一样不会拿到 undefined 的 session)
  const session = dbRes.sess;
  actualCount = dbRes.realCount;

  // 同步活动审计 (事务外 best-effort) — 新建/更新/消息增量落 SyncActivityLog
  let addedCount = 0;
  try {
    // 统计本次真正新增的消息 (UPDATE: 用写入前快照 preExistingMsgIds 判断)
    if (Array.isArray(messages) && existing) {
      for (const m of messages) {
        if (!m || !m.id) continue;
        const mid = buildMessageId(agentId, source, String(m.id));
        if (!preExistingMsgIds.has(mid)) addedCount++;
      }
    } else if (Array.isArray(messages)) {
      addedCount = msgCount; // 新建 session: 全部算新增
    }
    await prisma.syncActivityLog.create({
      data: {
        agentId,
        platform: String(source || "").toLowerCase(),
        sessionUid,
        sourceId: String(sourceId || ""),
        title: title || existing?.title || null,
        action: existing ? "UPDATE" : "NEW",
        msgCount,
        addedCount,
        source: "remote-push",
      },
    });
  } catch (logErr) {
    // 审计落库失败不阻塞主流程
    console.error("[upload] SyncActivityLog 落库失败:", logErr instanceof Error ? logErr.message.slice(0, 120) : logErr);
  }
  return NextResponse.json({
    success: true,
    sessionUid,
    sessionId: session.id,
    messageCount: actualCount,
    action: existing ? "UPDATE" : "NEW",
    addedCount,
  });
}

export async function GET() {
  const DISABLED = process.env.LIONS_DISABLE_REMOTE_UPLOAD === "1";
  return NextResponse.json({
    endpoint: "/api/sessions/upload",
    method: "POST",
    auth: "X-API-Key header (env LIONS_UPLOAD_API_KEYS, default lions-session-dev-key)",
    enabled: !DISABLED,
    notes: "V2: enabled by default. Disable: LIONS_DISABLE_REMOTE_UPLOAD=1.",
  });
}
