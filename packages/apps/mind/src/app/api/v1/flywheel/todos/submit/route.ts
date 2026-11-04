import { todoRepo } from "@/server/lib/todo-repo";
import { canCloseTodo } from "@/server/pipeline/guard-todo-close-gate";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkTodoCloseEvidence, isEvidenceRequiredTodo, TODO_EVIDENCE_MIN_LEN } from "@/server/pipeline/todo-evidence-gate";
import { verifyCommitSha } from "@/server/lib/commit-sha";

export const dynamic = "force-dynamic";

/**
 * 2026-09-11 [机制修复·agent协同] 待办承接回执 —— POST /api/v1/flywheel/todos/submit
 *
 * 为什么单独一条(而不是让 agent 直接 PATCH):
 *   PATCH 无归属校验、无状态前置条件、无并发展望 -> 任何 agent 都能改任何待办;
 *   且 "谁在什么时候把哪条待办推进到哪一步" 没有事件留痕, 消费端活性无法度量。
 *
 * 规则:
 *   - 人类待办(ownerType='human')不由 agent 提交(越权替人下结论);
 *   - ownerId 非本人 -> 403(不能替别人交差);
 *   - 状态必须 OPEN/DOING(已 DONE/DROPPED 不允许覆盖);
 *   - DONE 记 note/evidence/doneAt/doneBy; BLOCKED 记 note(阻塞原因, 用于升级执行体)。
 *
 * Body: { todoId, agentId, output, evidence?, status?: 'DONE'|'BLOCKED' }
 */
export async function POST(req: NextRequest) {
  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const todoId = String(b.todoId || "").trim();
  const agentId = String(b.agentId || "").trim();
  const output = String(b.output || "").trim();
  if (!todoId || !agentId || !output) return NextResponse.json({ ok: false, error: "need todoId, agentId, output" }, { status: 400 });
  const target = String(b.status || "DONE").toUpperCase();
  if (!["DONE", "BLOCKED"].includes(target)) return NextResponse.json({ ok: false, error: "bad status" }, { status: 400 });
  const now = Date.now();
  try {
    const row: any = await todoRepo.get("SELECT * FROM Todo WHERE id = ?", todoId);
    if (!row) { return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 }); }
    if (String(row.ownerType) !== "agent") { return NextResponse.json({ ok: false, error: "HUMAN_TODO_NOT_AGENT_SUBMITTABLE" }, { status: 403 }); }
    if (row.ownerId && String(row.ownerId) !== agentId) { return NextResponse.json({ ok: false, error: "NOT_YOURS", ownerId: row.ownerId }, { status: 403 }); }
    if (!["OPEN", "DOING"].includes(String(row.status))) { return NextResponse.json({ ok: false, error: "NOT_OPEN_OR_DOING", status: row.status }, { status: 409 }); }
    const prev = String(row.status);
    const evidence = b.evidence ? String(b.evidence).slice(0, 2000) : (row.evidence == null ? null : String(row.evidence));
    // ── 2026-09-18 新增: 结单证据预检(补齐 2026-09-17 PATCH 侧 c410b2d 未覆盖的 submit 入口) ──
    // 背景(重复发现 todo_cdf114b520f243edb2f6 / 任务 cmu5mfcf00007ni3k32c7ldbs): PATCH 结单侧已有
    //   TODO_CLOSE_EVIDENCE_REJECTED 门槛, 但 **submit 侧没有** —— 后者才是 responder/agent 的正式回执入口
    //   (scripts/macs-responder/todo_worker.py:661/686/747), 于是"通道回执型 DONE"从 submit 照样结单:
    //   产出是一句"本通道 0 工具", 系统收 DONE, 验收才判 FAIL。这里与 PATCH 用同一份判据
    //   (@/server/pipeline/todo-evidence-gate), 把"口头完成"堵在结单那一刻。
    // 适用范围: 仅 meta.needsTools===true 的取证类待办(由平台显式标记; 未标记的收件箱清读/讨论回答不受影响),
    //   且豁免 kind=HUMAN_DECISION_LANDING(人类决定落地单不是 agent 取证产物)。
    // 逃生口: TODO_EVIDENCE_GATE=0 关闭(与 PATCH 共用同一开关)。
    // 2026-10-23: 逐单证据强度开关 —— meta.requireEvidenceKind="commit-sha" 时，
    //   结单证据必须含 git commit sha（7-40 位十六进制），否则拒绝。
    //   为什么需要：并发线的"不能结单/未提交"留言也能把待办置 DONE（通道回执型结单）。
    if (target === "DONE") {
      let m: any = {};
      try { m = row.meta ? JSON.parse(String(row.meta)) : {}; } catch { m = {}; }
      if (m && m.requireEvidenceKind === "commit-sha") {
        // 只认**本次提交**带上的证据（不能沿用上次 attempt 里残留的旧 evidence，否则旧文本里的
        //   hex 片段会冒充 sha —— 实测：一次无 sha 的提交因为继承了旧 evidence 而通过）。
        const provided = b.evidence ? String(b.evidence).slice(0, 2000) : "";
        const verdict = verifyCommitSha(provided, row.ownerId);
        if (!verdict.ok) {
          await prisma.flywheelEvent.create({ data: {
            stage: "TODO_EVIDENCE_SHA_REQUIRED", sourceType: "todo", sourceId: todoId,
            sourceTitle: ("by=agent:" + agentId + " 结单被拒: " + verdict.reason).slice(0, 240), targetStage: "OK",
          } }).catch(() => null);
          return NextResponse.json({ ok: false, error: "TODO_EVIDENCE_SHA_REQUIRED",
            detail: "该待办要求本次提交的 evidence 里给出属于你（分支或署名）的 git commit sha：" + verdict.reason }, { status: 400 });
        }
      }
    }
    if (target === "DONE" && String(process.env.TODO_EVIDENCE_GATE ?? "1") !== "0" && isEvidenceRequiredTodo(row.meta)) {
      const chk = checkTodoCloseEvidence(evidence);
      if (!chk.ok) {
        await prisma.flywheelEvent.create({ data: {
          stage: "TODO_CLOSE_EVIDENCE_REJECTED", sourceType: "todo", sourceId: todoId,
          sourceTitle: ("by=agent:" + agentId + " submit 无证据结单被拒: " + chk.missing.join("; ")).slice(0, 240), targetStage: "OK",
        } }).catch(() => null);
        return NextResponse.json({
          ok: false, error: "TODO_CLOSE_EVIDENCE_REJECTED", missing: chk.missing,
          detail: "取证类待办(meta.needsTools=true)结单需要可复算证据(>=" + TODO_EVIDENCE_MIN_LEN + " 字 + 至少一个 file:/cmd:/sql:/commit/仓库路径 锚点)。待办保持 " + prev + ", 未置 DONE(避免'完成但无证据'的假象); 补证据后重新 submit。人类结单不受此限。",
        }, { status: 400 });
      }
    }
    // 2026-10-27（商业化线第 3 次追问）: **第三条写路径**。
    //   结单门先后堵了 PATCH /todos 与 tasks/submit 的 todoWriteback，但真正把
    //   todo_plautonomy_mvkhv3in 在 12:23:08 结掉的是**本路由**（/api/v1/flywheel/todos/submit）：
    //   事件 sourceTitle 里的 "via submit" 就是这里写的，doneBy 被设成 agentId。
    //   证据：生产日志中 `submit.todoWriteback` 出现 **0** 次 → 说明前一条路径没跑过。
    if (target === "DONE") {
      const srcOf = String(row.source || "");
      const closeVerdict = canCloseTodo(srcOf, { kind: "agent", actor: String(agentId) });
      console.log("[todos.submit] todoId=" + todoId + " source=" + (srcOf || "(空)") +
        " actor=" + agentId + " allowed=" + closeVerdict.allowed + " reason=" + closeVerdict.reason);
      if (!closeVerdict.allowed) {
        await prisma.flywheelEvent.create({ data: {
          stage: "GUARD_TODO_CLOSE_FORBIDDEN", sourceType: "todo", sourceId: todoId,
          sourceTitle: ("path=todos.submit by=agent:" + agentId + " source=" + (srcOf || "(空)")).slice(0, 240),
          targetStage: "OK",
        } }).catch(() => null);
        return NextResponse.json({ ok: false, error: "GUARD_TODO_CLOSE_FORBIDDEN", detail: closeVerdict.reason }, { status: 409 });
      }
    }
    const info = await todoRepo.run(
      "UPDATE Todo SET status=?, ownerType='agent', ownerId=?, note=?, evidence=?, doneAt=?, doneBy=?, updatedAt=? " +
      "WHERE id=? AND status IN ('OPEN','DOING') AND (ownerId IS NULL OR ownerId=?)"
    , target, agentId, output.slice(0, 1800), evidence, target === "DONE" ? now : null, agentId, now, todoId, agentId);
    if (info.changes !== 1) { return NextResponse.json({ ok: false, error: "RACE_OR_STATE_CHANGED" }, { status: 409 }); }
    const after: any = await todoRepo.get("SELECT * FROM Todo WHERE id = ?", todoId);
    await prisma.flywheelEvent.create({
      data: { stage: "TODO_STATUS", sourceType: "todo", sourceId: todoId, sourceTitle: (prev + " -> " + target + " by agent:" + agentId + " via submit").slice(0, 200), targetStage: "OK" },
    }).catch(() => null);

    // ===== 2026-09-14 定位迁移(阶段4): 讨论提问已改为**待办**, 因此"回答回写讨论串"要在这里接上 =====
    //   原先该回写写在 tasks/submit 的 DISCUSSION_QUESTION 分支; 待办路径走的是 /todos/submit, 必须同样回写,
    //   否则用户会看到"问了但答案不回帖"。判据: 待办 meta.kind === 'DISCUSSION_QUESTION'。
    let answerWrittenBack = false;
    try {
      let meta: any = {};
      try { meta = row.meta ? JSON.parse(String(row.meta)) : {}; } catch { meta = {}; }
      if (meta?.kind === "DISCUSSION_QUESTION" && meta?.entityId) {
        await runtimeRepo.run("INSERT INTO Discussion (id, entityType, entityId, authorType, authorId, kind, body, replyToId, taskId, meta, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          "dsc_ans_" + todoId.slice(-12) + "_" + Date.now().toString(36), String(meta.entityType || "task"), String(meta.entityId),
          "agent", agentId, "answer", output.slice(0, 6000), null, todoId,
          JSON.stringify({ viaTodo: todoId, askAgentId: meta.askAgentId || null }), Date.now());
        answerWrittenBack = true;
        await prisma.flywheelEvent.create({
          data: { stage: "DISCUSSION_ANSWER_WRITEBACK", sourceType: "todo", sourceId: todoId,
            sourceTitle: ("todo " + todoId + " 的回答已回写讨论串 " + String(meta.entityId)).slice(0, 240), targetStage: "OK" },
        }).catch(() => null);
      }
    } catch (e: any) {
      console.warn("[todos/submit] 讨论回答回写失败(非致命): " + String(e?.message || e).slice(0, 100));
    }
    return NextResponse.json({ ok: true, todoId, status: target, doneBy: agentId, prevStatus: prev, answerWrittenBack, todo: { id: todoId, status: String(after?.status || target), note: after?.note ?? null, evidence: after?.evidence ?? null } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}
