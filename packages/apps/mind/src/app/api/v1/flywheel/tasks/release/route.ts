import { releaseOrTakeover, getLease } from "@/server/pipeline/task-lease";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/tasks/release — 显式释放 / 接管 (expectedOwner + takeover) (2026-09-14)
 *
 * 落地来源: 知识条目 cmtwa1b1900j0yn162 第 2 要素 "expectedOwner/takeover 显式切换" +
 *   复核 cmu0stufv00nuki4ag8rzt5ur "释放侧对称记 transition"。
 *
 * 两个动作(二选一):
 *   A. release(释放): 持有者主动归还公开队列。
 *      Body: { taskId, agentId, expectedOwner?, reason? }
 *      条件: status=IN_PROGRESS 且 assignedAgent === expectedOwner(缺省=agentId)。
 *      效果: status=PENDING, assignedAgent=NULL, expectedOwner=NULL, leaseExpiresAt=NULL, version+1,
 *            写一条 IN_PROGRESS->PENDING 的 TaskStateTransition(before/after owner)。
 *   B. takeover(接管): 显式抢过一条**租约已到期**的任务(而不是悄悄改归属)。
 *      Body: { taskId, agentId, expectedOwner, takeover: true, leaseMs?, reason? }
 *      条件: status=IN_PROGRESS 且 assignedAgent === expectedOwner(必须显式写出你要从谁手里接管, 防误抢)
 *            且 leaseExpiresAt 已到期。
 *      效果: assignedAgent=agentId, expectedOwner=agentId, 新租约, version+1,
 *            写一条 IN_PROGRESS->IN_PROGRESS 的带 {beforeOwner, afterOwner, takeover:true} 审计。
 *
 * 为什么要有 expectedOwner:
 *   裸 takeover(只给 taskId)会在"原持有者其实还活着只是网络慢"时造成双写。要求调用方显式声明
 *   "我接管的预期所有者", 与库中实际归属做 CAS 比对, 不一致就拒绝 —— 归属切换从"隐式覆盖"变"显式断言"。
 */
export async function POST(req: Request) {
  let body: { taskId?: string; agentId?: string; expectedOwner?: string; takeover?: boolean; reason?: string; leaseMs?: number } = {};
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }
  const taskId = String(body.taskId || "").trim();
  const agentId = String(body.agentId || "").trim();
  if (!taskId || !agentId) return Response.json({ ok: false, error: "MISSING_FIELDS" }, { status: 400 });
  const takeover = body.takeover === true;
  if (takeover && !String(body.expectedOwner || "").trim()) {
    return Response.json({
      ok: false, error: "MISSING_EXPECTED_OWNER",
      hint: "接管必须显式声明 expectedOwner(你要从谁手里接管), 以防误抢仍持有活租约的任务",
    }, { status: 400 });
  }

  try {
    const before = await getLease(taskId);
    if (!before) return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    const r = await releaseOrTakeover({
      taskId, agentId,
      expectedOwner: body.expectedOwner ? String(body.expectedOwner) : undefined,
      reason: body.reason,
      takeover,
      leaseMs: body.leaseMs,
    });
    if (!r.ok) {
      const status = r.reason === "NOT_FOUND" ? 404
        : r.reason === "LEASE_STILL_ACTIVE" ? 409
        : r.reason === "CAS_LOST" ? 409 : 403;
      return Response.json({
        ok: false, error: r.reason,
        actualOwner: before.assignedAgent, actualVersion: before.version,
        leaseExpiresAt: before.leaseExpiresAt,
        hint: r.reason === "LEASE_STILL_ACTIVE"
          ? "租约仍在有效期内: 不能接管仍活着的持有者; 如需强切请等租约到期或由原持有者 release"
          : (r.reason?.startsWith("NOT_LEASE_HOLDER") ? "你不是当前归属者, 且未通过 expectedOwner 断言" : undefined),
      }, { status });
    }
    const after = await getLease(taskId);
    return Response.json({
      ok: true, taskId, action: takeover ? "takeover" : "release",
      beforeOwner: before.assignedAgent, afterOwner: after?.assignedAgent ?? null,
      version: after?.version, leaseExpiresAt: after?.leaseExpiresAt ?? null, status: after?.status,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: "RELEASE_FAILED", message: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
