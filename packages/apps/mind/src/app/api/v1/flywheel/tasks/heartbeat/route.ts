import { renewLease, getLease } from "@/server/pipeline/task-lease";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/tasks/heartbeat — 租约续约 (2026-09-14)
 *
 * 落地来源: 知识条目 cmtwa1b1900j0yn162「任务认领机制应内建的并发控制要素」第 1 要素
 *   "lease TTL + heartbeat 续约"。复核 cmu0stufv00nuki4ag8rzt5ur 明确点名该要素平台内无实现。
 *
 * 语义(为什么需要):
 *   认领时写 30min 租约(TASK_LEASE_MS)。执行体只要还活着就周期续约, 租约不会到期;
 *   一旦执行体掉线/卡死, 租约自然到期 -> 回收器/接管者可安全收回, 不需要人工运维。
 *   续约必须由**当前持有者**发起, 且带 version CAS —— "我以为我还持锁"与"库里已换人"的偏差会被拒绝。
 *
 * Body: { taskId, agentId, expectedVersion?, extendMs? }
 * 成功: { ok:true, leaseExpiresAt, version }
 * 失败(409/403): { ok:false, error: LEASE_EXPIRED | NOT_LEASE_HOLDER | NOT_IN_PROGRESS | CAS_LOST | NOT_FOUND }
 */
export async function POST(req: Request) {
  let body: { taskId?: string; agentId?: string; expectedVersion?: number; extendMs?: number } = {};
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }
  const taskId = String(body.taskId || "").trim();
  const agentId = String(body.agentId || "").trim();
  if (!taskId || !agentId) return Response.json({ ok: false, error: "MISSING_FIELDS" }, { status: 400 });

  try {
    const before = await getLease(taskId);
    if (!before) return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    const r = await renewLease({ taskId, agentId, expectedVersion: body.expectedVersion, extendMs: body.extendMs });
    if (!r.ok) {
      const status = r.reason === "NOT_FOUND" ? 404
        : r.reason === "NOT_IN_PROGRESS" ? 409
        : r.reason === "LEASE_EXPIRED" ? 409
        : r.reason === "CAS_LOST" ? 409 : 403;
      return Response.json({
        ok: false, error: r.reason,
        // 如实回传"库里的真实归属/版本", 让消费端能判断自己是否已被接管, 而不是只看到一句失败
        actualOwner: before.assignedAgent, actualVersion: before.version,
        leaseExpiresAt: r.leaseExpiresAt ?? before.leaseExpiresAt,
        hint: r.reason === "LEASE_EXPIRED"
          ? "租约已到期, 请用 /api/v1/flywheel/tasks/release (takeover=true) 显式接管后继续"
          : (r.reason === "CAS_LOST" ? "版本已变: 任务已被回收/接管/提交, 请重新查询归属" : undefined),
      }, { status });
    }
    return Response.json({ ok: true, taskId, agentId, leaseExpiresAt: r.leaseExpiresAt, version: r.version });
  } catch (e: any) {
    return Response.json({ ok: false, error: "HEARTBEAT_FAILED", message: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
