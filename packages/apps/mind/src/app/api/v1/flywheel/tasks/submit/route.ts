import { todoRepo } from "@/server/lib/todo-repo";
import { canCloseTodo } from "@/server/pipeline/guard-todo-close-gate";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { prisma } from "@/lib/prisma";
// round 57 G4: 统一写入层(store 闸)
import { safeCreateKnowledge } from "@/server/pipeline/safe-create";
// 2026-10-25 撤回流程补漏: 去重判定统一走"活行口径"(未撤回 + 未被取代)
import { liveRowWhere } from "@/server/pipeline/stale-aware-dedup";
import { parseInjectedIds, buildInjectedTitle, extractCitedIds } from "@/server/pipeline/injected-ids";
import { getLease, recordOwnershipChange } from "@/server/pipeline/task-lease";
import { MAX_STORED, storeTaskOutput } from "@/server/pipeline/store-task-output";
import { classifyTaskRequirement } from "@/server/pipeline/agent-capability";
import { detectEvidenceAnchors } from "@/server/pipeline/evidence-anchor";
import { storeRejectedOutput } from "@/server/pipeline/rejected-output";
import { classifyExternalFault } from "@/server/pipeline/external-fault";
import { noteExternalFault } from "@/server/pipeline/claim-circuit";
import { releaseOrTakeover } from "@/server/pipeline/task-lease";
// 2026-10-11 (任务 cmv2z9dsa007oo74gp): 同家族弱自证自核「透明披露」闸门 —— 依据 Memory cmv2x8pf000iyrztjk
//   弱型 = submitter(candidate.agentSource) 与 executor(task.assignedAgent) 不同 agentId 但同家族(同 host)。
//   命中且产出未「坦白 + 邀请 leader 覆写」-> 422 拒收, 任务保持 IN_PROGRESS(与 evidencePreflight 同模式)。
import { checkWeakRecusalDisclosure, loadHostMap, normalizeAgentId } from "@/server/pipeline/family-recusal";
// 2026-09-18: 待办回写也必须过同一份结单证据规则(单一规则源, 执行体已建; 这里补导入)
import { checkTodoCloseEvidence } from "@/server/pipeline/todo-evidence-gate";
import { createHash } from "crypto";
import { calcQualityScore } from "@/server/pipeline/db-writer";
import { checkDeclaredArtifacts } from "@/server/pipeline/deliverable-existence";
import { applyAutoDecisionToTodo } from "@/server/pipeline/auto-decision";
// 2026-09-23 机制修复(todo_e53950f0a49d477aa415): 改动声明闸门的规则加载改用 createRequire,
//   修复 Next.js webpack 改写裸 require(运行时绝对路径) 导致 94 次全抛 Cannot find module 的失效。
import { evaluateClaimedEdits } from "@/server/pipeline/claimed-edits-gate";

// 2026-09-15 假完成防线: 交付物存在性判定抽到 server/pipeline/deliverable-existence(可单测, 见 scripts/test-deliverable-existence.ts)
// POST /api/v1/flywheel/tasks/submit — agent 提交执行结果(2026-09-08 Phase2)
// Body: { taskId, agentId, output, qualitySelf? }
// 校验: task IN_PROGRESS 且 assignedAgent=agentId; 结果存 TaskExecution(审计), 不改五表

/**
 * 2026-10-12 (任务 cmv40krvt00qgzbjdm, HTTP 级 422 回归暴露的错位修复):
 *   同家族弱自证自核「透明披露」闸门必须**前置到 taskExecution.create / UPDATE Task status='DONE' 之前**。
 *   历史缺陷: 闸门原先内联在「验证任务回写」段(结单之后) —— HTTP 响应确实是 422, 但库里的任务早已 DONE、
 *   TaskExecution 也已落库, 与 body/commit 自称的「任务保持 IN_PROGRESS 未置 DONE」矛盾。这与 2026-09-23
 *   对 claimed-edits 闸门修过的错位是同一类问题。此处抽成可在结单前调用的函数; 判定逻辑仍复用 family-recusal.ts。
 *   返回 Response(422) = 拒绝结单; null = 放行(含 SUBMIT_FAMILY_CHECK=0 逃生口与任何 fail-open)。
 */
async function familyRecusalPreflight(task: any, agentId: string, output: string): Promise<Response | null> {
  if (String(process.env.SUBMIT_FAMILY_CHECK ?? "1") === "0") return null;
  let payload: any = {};
  try { payload = JSON.parse((task as any).improvementPayload || "{}"); } catch { return null; }
  if (payload?.kind !== "VERIFY_AGENT_OUTPUT" || !payload?.candidateId) return null;
  try {
    // asset-scope-exempt: 按 candidateId 取本任务候选（id 来自任务 payload，非列表读；归属过滤会破坏执行链）
    const cand = await prisma.knowledge.findUnique({ where: { id: String(payload.candidateId) }, select: { id: true, agentSource: true } });
    if (!cand) return null;
    const submitterRaw = String((cand as any).agentSource || "");
    const executorRaw = String(task.assignedAgent || agentId || "");
    const familyChk = checkWeakRecusalDisclosure({
      output,
      submitterAgentSource: submitterRaw,
      executorAgentId: executorRaw,
      hostByAgentId: await loadHostMap(prisma, [normalizeAgentId(submitterRaw), normalizeAgentId(executorRaw)]),
    });
    if (familyChk.triggered && !familyChk.disclosed) {
      await prisma.flywheelEvent.create({
        data: {
          stage: "SUBMIT_FAMILY_RECUSAL_REJECTED", sourceType: "submit", sourceId: task.id, taskId: task.id,
          sourceTitle: ("candidate=" + cand.id + " submitter=" + familyChk.submitterAgentId + " executor=" + familyChk.executorAgentId + " host=" + familyChk.host).slice(0, 300),
          targetStage: "OK",
        },
      }).catch(() => null);
      return Response.json({
        ok: false,
        error: "FAMILY_RECUSAL_DISCLOSURE_REQUIRED",
        detail: "本验证任务命中「同家族弱自证自核」(" + familyChk.detail + ")。按 Memory cmv2x8pf000iyrztjk, verdict 文本必须坦白说明并邀请 leader 覆写; 当前未披露, 任务保持 IN_PROGRESS 未置 DONE。",
        hint: "在产出里补一行: 「【Self-Submitter Recusal 弱型坦白】submitter=" + familyChk.submitterAgentId + ", executor=" + familyChk.executorAgentId + ", 同家族(host=" + familyChk.host + ")但不同 agentId, 严格说无独立审稿; 邀请 leader 覆写(invite-leader-overwrite:1)。」补后可重提。",
        familyCheck: { submitter: familyChk.submitterAgentId, executor: familyChk.executorAgentId, host: familyChk.host },
      }, { status: 422 });
    }
  } catch { /* 闸门异常不阻断提交(fail-open) */ }
  return null;
}

export async function POST(req: Request) {
  // 2026-09-10: usage = agent 自报的本次 LLM 用量(responder 侧才知道自己的 token/模型), 用于成本归因
  let body: { taskId?: string; agentId?: string; output?: string; qualitySelf?: number; usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; model?: string; calls?: number } };
  try { body = await req.json(); } catch { return Response.json({ error: "INVALID_JSON" }, { status: 400 }); }
  const taskId = (body.taskId || "").trim();
  const agentId = (body.agentId || "").trim();
  const output = (body.output || "").trim();
  if (!taskId || !agentId || !output) return Response.json({ error: "MISSING_FIELDS" }, { status: 400 });

  try {
    const task: any = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    if (task.status !== "IN_PROGRESS") return Response.json({ error: "NOT_IN_PROGRESS", status: task.status }, { status: 409 });
    if (task.assignedAgent !== agentId) return Response.json({ error: "NOT_ASSIGNED_TO_YOU" }, { status: 403 });

    // 2026-10-23 P2 补口: 产出本身是**通道级故障**时（401 / cli_error / compaction / 超时 / 空输出 / 本通道无工具），
    //   说明 agent 根本没机会干活。此时立即释放租约（外部故障不消耗放回次数），返回 503，
    //   而不是走证据闸门 422 —— 否则平台故障会被记成 agent 的证据缺失，任务还会在租约里白耗到 TTL。
    {
      const ef = classifyExternalFault(output);
      if (ef.fault) {
        let released = false;
        try {
          const rr = await releaseOrTakeover({ taskId, agentId, reason: "大脑通道不可用(提交时判定 " + ef.kind + "): " + ef.evidence });
          released = !!rr.ok;
        } catch { /* 释放失败不影响判定 */ }
        // 2026-10-25: 记一次外部故障 -> 触发该 agent 的认领熔断（窗口内累计 N 次则暂停 M 分钟）
        noteExternalFault(agentId);
        // 2026-10-25: 外部故障也留原文 —— 否则"通道为什么坏"只能靠旧样本猜
        const keptFault = storeRejectedOutput({ taskId, agentId, reason: "EXTERNAL_FAULT/" + ef.kind, output });
        await prisma.flywheelEvent.create({ data: {
          stage: "SUBMIT_EXTERNAL_FAULT", sourceType: "submit", sourceId: taskId, taskId,
          sourceTitle: ("by=" + agentId + " 通道故障(" + ef.kind + ") released=" + released + (keptFault ? " 原文=" + keptFault : "") + ": " + ef.evidence).slice(0, 400), targetStage: "OK",
        } }).catch(() => null);
        return Response.json({
          ok: false, error: "EXTERNAL_FAULT", fault: ef.kind, released,
          detail: "本通道故障（非你的产出问题），任务已释放回公开队列且不计放回次数；通道恢复后重领即可。",
        }, { status: 503 });
      }
    }

    // ===== 2026-09-15 收口自检(任务 cmu24ffju084dki4a5khu22g8 第 2 步) =====
    //  问题: 需要取证的任务(机制修复/落地/复核/补证)被文本通道领走后交一份"通道回执", 任务照样置 DONE,
    //        验收才判 evidence-attached FAIL —— 于是"任务 DONE"对外是假象(实测台账 165 条)。
    //  修法: 结单前先跑与验收同源的锚点探测; 一个锚点都没有 -> 422 拒绝置 DONE, 让执行体补证据后重提。
    //        判定口径与 scripts/acceptance/lib/verdict-authority.cjs 一致(见 evidence-anchor.ts 的说明)。
    //  逃生口: SUBMIT_EVIDENCE_GUARD=0 关闭(默认开)。拒绝时任务保持 IN_PROGRESS, 不写执行记录 ——
    //        不会把一次没证据的提交计成"健康提交", 也不会制造 DONE 假象。
    const reqCap = classifyTaskRequirement(task.title, task.improvementType, task.improvementPayload);
    const EVIDENCE_GUARD = String(process.env.SUBMIT_EVIDENCE_GUARD ?? "1") !== "0";
    let evidencePreflight: { ok: boolean; anchors: string[]; detail: string } | null = null;
    if (EVIDENCE_GUARD && reqCap.evidenceRequired) {
      const chk = await detectEvidenceAnchors(output, [task.title, task.description, task.requirements, task.materials].join("\n"));
      evidencePreflight = { ok: chk.ok, anchors: chk.anchors, detail: chk.detail };
      if (!chk.ok) {
        // 2026-10-23: 拒绝时留存原文 —— 否则"误拒"无法事后复算（当天两次误拒都是靠本地复现才定位的）
        const keptAt = storeRejectedOutput({ taskId, agentId, reason: "EVIDENCE_REQUIRED/" + reqCap.kind, output });
        const c = chk.counts;
        await prisma.flywheelEvent.create({
          data: {
            stage: "SUBMIT_EVIDENCE_REJECTED", sourceType: "submit", sourceId: taskId, taskId,
            sourceTitle: ("taskKind=" + reqCap.kind + " by=" + agentId + " 产出无可复算证据锚点, 拒绝结单" +
              " [cmd=" + c.cmd + " file=" + c.file + "/" + c.fileExists + " commit=" + c.commit + " id=" + c.dbIdExists + "]" +
              (keptAt ? " 原文=" + keptAt : "") + ": " + chk.detail).slice(0, 500),
            targetStage: "OK",
          },
        }).catch(() => null);
        return Response.json({
          ok: false,
          error: "EVIDENCE_REQUIRED",
          taskKind: reqCap.kind,
          taskKindLabel: reqCap.label,
          detail: `本任务属「${reqCap.label}」, 产出必须附可复算证据锚点; 当前` + chk.detail + `。任务保持 IN_PROGRESS, 未置 DONE(避免"完成但无证据"的假象)。`,
          hint: "在产出里附: ① 复测命令 + 原始输出(SELECT…FROM / curl / node / git …) ② 真实库内 id / 仓库文件路径 / commit hash ③ 引用的材料原文(带出处)。补证据后重新提交。",
          checked: { counts: chk.counts },
        }, { status: 422 });
      }
    }

    // ===== 2026-09-18 P1 / 2026-09-23 二次修复: 代码/落地类任务必须**真改过文件**, 且必须**在结单前**判定 =====
    // 实测漏洞: 锚点是文本属性, 抄写即可满足; 改动声明 + 窗口内提交是结构属性, 抄写满足不了。
    //   修前(ba5f586..c7f80d6)判定在 UPDATE Task status='DONE' **之后**: 422 只改响应, 任务已 DONE、执行记录已写
    //   -> 没有真正阻止结单。本次前移到写执行记录/置 DONE 之前; 拒绝时任务保持 IN_PROGRESS、不写执行记录。
    //   加载口径与验收侧 code-change.json 的 claimed-edits-committed 同一份实现
    //   (scripts/acceptance/checks/claimed-edits.cjs), 见 server/pipeline/claimed-edits-gate 的 webpack 安全加载。
    //   逃生口: SUBMIT_EVIDENCE_GUARD=0; 规则库不可用 -> UNAVAILABLE 放行并留痕(fail-open, 不 fail-closed)。
    const isCodeKind = reqCap.kind === "MECHANISM_FIX" || reqCap.kind === "LANDING";
    let claimedEditsOk: { claims: number; hits: number; per: string[] } | null = null;
    if (EVIDENCE_GUARD && isCodeKind) {
      try {
        const sinceIso = task.createdAt ? new Date(task.createdAt).toISOString() : null;
        const nowIso = new Date().toISOString();
        const v = evaluateClaimedEdits({ output, sinceIso, nowIso });
        if (v.status === "UNAVAILABLE") {
          await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_CLAIMED_EDITS_UNAVAILABLE", sourceType: "submit", sourceId: taskId, taskId,
            sourceTitle: ("规则库不可用, 本次放行(不 fail-closed): repoRoot=" + v.repoRoot + " err=" + v.error).slice(0, 300), targetStage: "OK" } }).catch(() => null);
        } else if (v.status === "CLAIMS_REQUIRED") {
          // 2026-10-12 round 72-BI: **交回通道** —— 产出声明「需要人类决策」时不要求改动声明, 放行。
          //
          //   为什么必须放行(实测链路): 平台两侧其实**都已存在**但被本闸门切断 ——
          //     · 下游 route.ts:520 会调 createHumanTodoFromTaskOutput() 从产出里识别 [需要人类决策] 并派生人类待办
          //       (todo-store.ts, 还专门修过"否定语境误命中导致自转"的坑);
          //     · 但本闸门在第 133 行, 产出没有改动声明就 422 返回 —— **那段派生逻辑永远跑不到**。
          //   而平台的任务描述**早就**要求执行体「若卡在授权/采购/业务决策, 标注 [需要人类决策] 并说明卡点, 不要代做」。
          //
          //   实测规模(round 72-BH): 466 条 BLOCKED 的 GOAL_GAP 任务里 **92% 命中"架构性/需协调/需人类决策"**,
          //   且**全部 retryCount=2**(被隔离阈值统一挡下)、**201 条从未被拒**(根本没走到提交)。
          //   它们不是"做完了没法交", 是"**这东西执行体做不了**"——免改动通道(72-AZ)对它们不适用。
          //
          //   判据一律复用 **todo-store.needsHumanDecision()**(SSOT, 含否定语境排除),
          //   **不在本文件或规则模块里复制一份正则** —— 复制就会漂移, 而它正是防"自转"的那道逻辑。
          let humanDecision = false;
          try {
            const { needsHumanDecision } = await import("@/server/pipeline/todo-store");
            humanDecision = needsHumanDecision(output);
          } catch { humanDecision = false; }
          if (humanDecision) {
            await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_HUMAN_DECISION_DECLARED", sourceType: "submit", sourceId: taskId, taskId,
              sourceTitle: ("taskKind=" + reqCap.kind + " by=" + agentId + " 声明「需要人类决策」放行(交回, 下游派生人类待办)").slice(0, 300), targetStage: "OK" } }).catch(() => null);
            // 不 return: 让流程继续走到 taskExecution 落库、置 DONE、以及 line~520 的人类待办派生。
          } else {
          const keptAt2 = storeRejectedOutput({ taskId, agentId, reason: "CLAIMED_EDITS_REQUIRED/" + reqCap.kind, output });
          await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_CLAIMS_REJECTED", sourceType: "submit", sourceId: taskId, taskId,
            sourceTitle: ("taskKind=" + reqCap.kind + " by=" + agentId + " 无改动声明, 拒绝结单" + (keptAt2 ? " 原文=" + keptAt2 : "")).slice(0, 400), targetStage: "OK" } }).catch(() => null);
          return Response.json({
            ok: false, error: "CLAIMED_EDITS_REQUIRED", taskKind: reqCap.kind, taskKindLabel: reqCap.label,
            detail: "本任务属「" + reqCap.label + "」, 产出必须含 >=1 个带改动语义且紧邻路径的**改动声明**(如『修改了 packages/…/x.ts』)。" +
              "注意: 只提到/建议运行某个已存在脚本不算改动声明; 抄写验收里的命令也不等于做过(实测教训: 无工具通道靠抄 curl 通过了旧的锚点闸门)。",
            // 2026-10-12 round 72-BE: **把免改动通道写进拒绝提示**。
            //   实测(round 72-AZ 上线后 20 分钟): SUBMIT_CLAIMS_REJECTED=10 而 SUBMIT_NO_CHANGE_DECLARED=**0** ——
            //   通道存在但**没人知道**。原来这句只说"如实交回并说明", 既没给规范句, 也没说清"写了会被放行",
            //   于是执行体只能反复重投同一份必然被拒的产出(round 72-AY 的取证: 同一份被重投过 22 次)。
            //   现在把**唯一可用的那句话**直接给出(与 closure-files.cjs 的 CLOSURE_NO_CHANGE_DECL 逐字一致)。
            hint: "① 若你真的改了文件: 产出里写明**哪个文件**、改了什么、附 commit;" +
              " ② 若核对后发现**确实无需改动**(如已由别的任务完成): **在产出里逐字写上『本任务无文件改动』** —— " +
              "闸门认得这句话, 会**放行结单并留痕**; 同时在产出里给出你核对了什么(库内 id / 文件 / commit 等可复算依据)。" +
              " ③ 若这活**执行体做不了**(需要人类拍板 / 授权 / 架构决策, 或本 agent 无相应权限): " +
              "**在产出里逐字写上『[需要人类决策]』并说明卡点** —— 闸门会放行, 平台据此**派生一条人类待办**交给运营者, " +
              "不要代做、也不要反复重投。注意 ②③ 仍须**通过前面的证据闸门**(可复算证据锚点), 不是免死金牌。",
          }, { status: 422 });
          }
        } else if (v.status === "NO_CHANGE_DECLARED") {
          // 2026-10-12 round 72-AZ: 免改动声明 -> **放行**(不 return), 但强制留痕。
          //   为什么放行: 任务描述本身就要求"核对后发现已由别的任务完成时如实标注『无需改动』";
          //   此前无出口, 诚实交回会被 422 -> 任务被租约回收 -> 最终 BLOCKED(实测 247/281)。
          //   为什么留痕: 这是一条**可被滥用的出口**, 必须让它**可计数**。
          //   下一步(不在本 round): 若该事件比例异常升高, 就按主题/agent 收紧或改 require 人工复核。
          await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_NO_CHANGE_DECLARED", sourceType: "submit", sourceId: taskId, taskId,
            sourceTitle: ("taskKind=" + reqCap.kind + " by=" + agentId + " 声明『本任务无文件改动』放行(留痕待核)").slice(0, 300), targetStage: "OK" } }).catch(() => null);
        } else if (v.status === "NO_COMMIT_IN_WINDOW") {
          await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_NO_COMMIT_IN_WINDOW", sourceType: "submit", sourceId: taskId, taskId,
            sourceTitle: ("taskKind=" + reqCap.kind + " by=" + agentId + " 声明的改动窗口内无提交: " + v.per.join(", ")).slice(0, 300), targetStage: "OK" } }).catch(() => null);
          return Response.json({
            ok: false, error: "NO_COMMIT_IN_WINDOW", taskKind: reqCap.kind, taskKindLabel: reqCap.label,
            detail: "产出声明改了 " + v.claims + " 个文件, 但它们在**任务窗口(" + (sinceIso || "?") + " ~ 现在)内没有任何提交**: " + v.per.slice(0, 6).join(", "),
            hint: "提交后再交回(commit 是这类任务的硬交付)。若你的通道无工具, 请如实交回并说明, 平台会另派有工具的通道。",
          }, { status: 422 });
        } else if (v.status === "ERROR") {
          await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_CLAIMED_EDITS_ERROR", sourceType: "submit", sourceId: taskId, taskId,
            sourceTitle: ("规则执行异常, 放行: " + v.error).slice(0, 200), targetStage: "OK" } }).catch(() => null);
        } else {
          // OK 先记内存, 等 DONE CAS 成功后再写 SUBMIT_CLAIMED_EDITS_OK(避免 CAS 失败却报成功)。
          claimedEditsOk = { claims: v.claims, hits: v.hits, per: v.per };
        }
      } catch (e) {
        await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_CLAIMED_EDITS_ERROR", sourceType: "submit", sourceId: taskId, taskId,
          sourceTitle: ("规则执行异常, 放行: " + String((e as Error)?.message || e)).slice(0, 200), targetStage: "OK" } }).catch(() => null);
      }
    }

    // ===== 2026-10-12 (任务 cmv40krvt00qgzbjdm): 同家族披露闸门前置到 taskExecution.create / DONE 之前 =====
    //   否则 422 只是"事后响应": 任务已 DONE、执行记录已写(HTTP 级回归实测证据见
    //   docs/handoff/cmv40krvt00qgzbjdm-http-422-family-recusal-regression-2026-10-12.md)。
    const familyReject = await familyRecusalPreflight(task, agentId, output);
    if (familyReject) return familyReject;

    const now = new Date();
    // 2026-09-11 第 40 轮(采纳独立复核 k05q3m 的裁决): 原来的 6000/60000 上限是**静默截断** ——
    //   实测提交 112025 字 -> 库里只存 60000, 尾部内容无声丢失, 复核者既看不到尾部也不知道被截过,
    //   复核意见原话: "上限本身仍是盲盒, 截断可能在 60001 字处静默发生且复核者永远看不到"。
    //   改法: 超限时把**全文落盘**, 并在存储文本尾部写入明确的截断标记(原文长度 + 全文路径 + sha256),
    //   使截断可被发现、全文可被取回。落盘失败也必须留下标记, 不得退回静默截断。
    // 2026-09-15: 截断/落盘逻辑抽到 @/server/pipeline/store-task-output (行为不变),
    //   供 V1.6 cron 执行器写 TaskExecution 时共用同一份 MAX_STORED 契约。
    const storedOutput = storeTaskOutput(taskId, output);
    if (output.length > MAX_STORED) {
      console.warn("[tasks/submit] 提交内容超限, 已落盘全文: task=" + taskId + " len=" + output.length + " -> " + (process.env.LIONS_HOME || process.cwd()) + "/logs/task-output/" + taskId + ".txt");
    }
    // 先落执行记录, 成功后再置 DONE(避免记录失败但任务已 DONE 的不一致)
    const execRow = await prisma.taskExecution.create({
      data: {
        taskId, agentId, agentRole: "macs-agent", status: "COMPLETED",
        startedAt: now, completedAt: now,
        // 2026-09-11 第 36 轮修(实测缺陷): 原来截断到 6000 字符。两名独立复核(agent-b bra34m /
        //   agent-d wycgjl)对我的落地提交**均判 NO_VERDICT**, 共同理由是
        //   "自证 + 节选 = 复核员无法独立验证": 证据(命令 + 原始输出)常超过 6000 字, 截断后复核者只看得到节选,
        //   独立验证事实上无法完成 —— 这把"开独立复核"变成了形式。SQLite 的 TEXT 无长度限制,
        //   TaskExecution 也非高频大表, 故放宽到 60000(留 10 倍余量)并保留上限以防异常巨型输出。
        input: "",
        output: storedOutput,
        qualityPassed: body.qualitySelf != null ? body.qualitySelf >= 0.6 : false,
      },
    });
    // 2026-09-14 认领并发控制落地(复核 cmu0stufv00nuki4ag8rzt5ur "释放侧对称记 transition"):
    //   提交同样走 version CAS + 清租约(expectedOwner/leaseExpiresAt) + 对称审计。
    //   若提交瞬间任务已被回收/接管(version 变或 assignedAgent 变), CAS 影响行=0 -> 拒绝并把刚写的
    //   执行记录标记 SUPERSEDED, 绝不把一次失败的提交计成成功(健康闸门按 status='COMPLETED' 统计)。
    const expectedVersion = (await getLease(taskId))?.version ?? 0;
    const upd = await prisma.$executeRawUnsafe(
      "UPDATE Task SET status='DONE', completedAt=?, completedBy=?, expectedOwner=NULL, leaseExpiresAt=NULL, version=version+1, updatedAt=? " +
      "WHERE id=? AND status='IN_PROGRESS' AND assignedAgent=? AND version=?",
      now, agentId, now, taskId, agentId, expectedVersion
    );
    if (upd !== 1) {
      await prisma.$executeRawUnsafe('UPDATE "TaskExecution" SET status=\'SUPERSEDED\' WHERE id=?', execRow.id).catch(() => null);
      const cur = await getLease(taskId);
      return Response.json({
        ok: false, error: "CLAIM_LOST",
        detail: `提交时归属已变(可能被回收/被接管): actualOwner=${cur?.assignedAgent ?? "-"} actualVersion=${cur?.version ?? "-"} expectedVersion=${expectedVersion}`,
        task: { id: taskId, status: cur?.status, assignedAgent: cur?.assignedAgent, version: cur?.version },
      }, { status: 409 });
    }
    await recordOwnershipChange({
      taskId, fromStatus: "IN_PROGRESS", toStatus: "DONE",
      actor: "agent:" + agentId, reason: "submitted by " + agentId,
      beforeOwner: task.assignedAgent ?? null, afterOwner: agentId,
      beforeVersion: expectedVersion, afterVersion: expectedVersion + 1,
      extra: { completedBy: agentId, leaseCleared: true },
    });

    // 改动声明闸门通过(OK)才在置 DONE 成功后留痕 —— 旧实现成功不写事件, 于是 "94 ERROR / 0 OK" 的失效状态没人看得见。
    if (claimedEditsOk) {
      await prisma.flywheelEvent.create({ data: { stage: "SUBMIT_CLAIMED_EDITS_OK", sourceType: "submit", sourceId: taskId, taskId,
        sourceTitle: ("改动声明 " + claimedEditsOk.claims + " 个, 窗口内提交命中 " + claimedEditsOk.hits + " 个: " + claimedEditsOk.per.join(", ")).slice(0, 300), targetStage: "OK" } }).catch(() => null);
      evidencePreflight = { ok: true, anchors: (evidencePreflight?.anchors || []).concat(["claimed-edits:" + claimedEditsOk.per.join(",")]), detail: "改动声明 " + claimedEditsOk.claims + " 个, 窗口内提交命中 " + claimedEditsOk.hits + " 个" };
    }

    // ===== 2026-09-18 P1(cmu6gvmqp0006lupmf0b4uv9y): 代码/落地类任务必须**真改过文件** =====
    // 2026-09-23 二次机制修复(todo_e53950f0a49d477aa415): 判定已**前移**到 TaskExecution/DONE 之前(见上方
    //   "改动声明闸门前置")。旧位置在 UPDATE Task status='DONE' 之后 -> 422 只改了响应, 库里任务已 DONE、
    //   执行记录已写, 并未真正阻止结单。这里只保留指针注释。
    // ===== 2026-09-10 第一段闭环: agent 输出回写平台记忆 =====
    // 为什么: 以前 agent 的结论只落在 TaskExecution, 平台记忆读不到 -> "agent 按平台数据工作 + 越用越强"断裂。
    // 规则: 结论/提案型任务(或输出≥200字) -> 提炼为 Knowledge(sourceType=AGENT_OUTPUT, 幂等 by contentHash);
    //       同时把本次注入过的记忆/知识/技能计一次使用(usageCount/lastUsedAt), 供冷却与"越用越强"度量。
    let ingested: { knowledgeId?: string; skipped?: string; usageBumped?: number; usedCountBumped?: number; citedCount?: number; staged?: boolean; noVerdictAttempts?: number } = {};

    // ===== 2026-09-10: 验证任务回写 — 另一 agent 对 agent 产出候选给裁定, 平台自动转正/否决 =====
    // 与 session 同口径: 结论进飞轮被独立验证, 人的角色退化为抽查与否决(veto), 不做逐条人工评审。
    let verdict: { candidateId?: string; decision?: string } = {};
    try {
      let payload: any = {};
      try { payload = JSON.parse((task as any).improvementPayload || "{}"); } catch {}
      if (payload?.kind === "VERIFY_AGENT_OUTPUT" && payload?.candidateId) {
        const m = output.match(/VERDICT\s*[:：]\s*(VERIFIED|REJECTED)/i);
        const decision = m ? m[1].toUpperCase() : "NO_VERDICT";
        // asset-scope-exempt: 同上（本任务候选，用于判定与披露门；不是跨 agent 列表读）
        const cand = await prisma.knowledge.findUnique({ where: { id: String(payload.candidateId) }, select: { id: true, tags: true, content: true, agentSource: true } });
        if (cand) {
          // ===== 2026-10-11 弱型同家族披露闸门 (任务 cmv2z9dsa007oo74gp; 依据 Memory cmv2x8pf000iyrztjk) =====
          //   2026-10-12 (cmv40krvt00qgzbjdm): 判定已**前移**到 taskExecution.create/DONE 之前(见上方
          //   familyRecusalPreflight 调用与函数定义)。旧实现在此(结单之后)内联, 于是 422 只改响应、
          //   任务实际已 DONE(HTTP 级回归实测的证据)。这里只保留指针注释。
          verdict = { candidateId: cand.id, decision };
          // 命题分类: 无工具的改进建议(GOAL_GAP 通道产出, 自称"未执行")不是知识而是待执行提案 ->
          //   采纳后进 PROPOSAL_ACCEPTED(不注入上下文, 由同主题执行任务承接); 只有可复现的事实类结论才 VERIFIED 进正式知识。
          let isProposal = false;
          try {
            const tg = JSON.parse(cand.tags || "{}");
            isProposal = String(tg?.improvementType || "").includes("GOAL_GAP") || /方案|建议|待实施|未执行|本通道无工具/.test(String(cand.content || ""));
          } catch { isProposal = false; }
          if (decision === "VERIFIED" && isProposal) {
            await prisma.knowledge.update({ where: { id: cand.id }, data: { verification: "PROPOSAL_ACCEPTED", confidence: 0.6, stale: false, staleReason: "已采纳的建议(非已验证事实), 由同主题执行任务承接落地" } });
          } else if (decision === "VERIFIED") {
            await prisma.knowledge.update({ where: { id: cand.id }, data: { verification: "VERIFIED", confidence: 0.8, stale: false, staleReason: null } });
          } else if (decision === "REJECTED") {
            await prisma.knowledge.update({ where: { id: cand.id }, data: { verification: "REJECTED", stale: true, staleReason: ("独立复核否决 by " + agentId + ": " + output.slice(0, 180)) } });
          }
          await prisma.flywheelEvent.create({
            data: {
              stage: decision === "REJECTED" ? "KNOWLEDGE_REJECTED" : (decision === "VERIFIED" ? (isProposal ? "KNOWLEDGE_PROPOSAL_ACCEPTED" : "KNOWLEDGE_VERIFIED") : "KNOWLEDGE_VERDICT_MISSING"),
              sourceType: "agent-verify", sourceId: cand.id,
              sourceTitle: ("by=" + agentId + " task=" + taskId + " candidate=" + cand.id).slice(0, 250), targetStage: "OK",
            },
          }).catch(() => null);
          if (decision === "NO_VERDICT") {
            ingested.skipped = "验证任务未给 VERDICT, 候选保持 PENDING_REVIEW";
            // 2026-09-11 P0: 未判定必须计数, 否则同一个候选会被无限反复开验证任务(实测同一候选 4 条)。
            //   达到 VERIFY_NO_VERDICT_MAX(默认 2) 后由 verify-tasks 侧停止自动开单, 并置 needsHumanReview 供人工兜底。
            try {
              const tg = (() => { try { return JSON.parse(String(cand.tags || "{}")); } catch { return {}; } })();
              const attempts = Number(tg.verifyNoVerdict ?? 0) + 1;
              const max = Number(process.env.VERIFY_NO_VERDICT_MAX ?? 2);
              const next = { ...tg, verifyNoVerdict: attempts, needsHumanReview: attempts >= max, lastNoVerdictBy: agentId, lastNoVerdictAt: new Date().toISOString() };
              // 复核意见(agent-e, PARTIAL)落地: 只记次数是"截断", 会被换 agent/改 tags 绕过。
              //   达到上限时**推进候选状态到终态 NEEDS_HUMAN_REVIEW** —— 它不再是 PENDING_REVIEW, 自然离开自动复核池(根除, 而非截断)。
              await prisma.knowledge.update({
                where: { id: cand.id },
                data: attempts >= max
                  ? { tags: JSON.stringify(next), verification: "NEEDS_HUMAN_REVIEW", stale: false,
                      staleReason: ("自动复核 " + attempts + " 次均未给出 VERDICT, 按上限(" + max + ")转人工复核 (by " + agentId + ")").slice(0, 240) }
                  : { tags: JSON.stringify(next) },
              });
              ingested.noVerdictAttempts = attempts;
              await prisma.flywheelEvent.create({
                data: { stage: attempts >= max ? "VERIFY_EXHAUSTED_TO_HUMAN" : "VERIFY_NO_VERDICT_COUNTED", sourceType: "agent-verify", sourceId: cand.id,
                  sourceTitle: ("candidate=" + cand.id + " attempts=" + attempts + "/" + max + " by=" + agentId + (attempts >= max ? " -> 停止自动开单, 转人工" : "")).slice(0, 240), targetStage: "OK" },
              }).catch(() => null);
            } catch { /* 计数失败不影响提交本身 */ }
          }
        }
      }
    } catch { /* 裁定回写失败不影响提交本身 */ }

    // ===== 2026-09-10: 讨论提问的回答回写 — agent 的答复自动进入该实体的讨论串 =====
    let discussed: { entityType?: string; entityId?: string } = {};
    try {
      let p: any = {};
      try { p = JSON.parse((task as any).improvementPayload || "{}"); } catch {}
      if (p?.kind === "DISCUSSION_QUESTION" && p?.entityId) {
        await runtimeRepo.run(
          "INSERT INTO Discussion (id, entityType, entityId, authorType, authorId, kind, body, replyToId, taskId, meta, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          "dsc_" + taskId.slice(-16), String(p.entityType || "task"), String(p.entityId), "agent", agentId, "answer",
          output.slice(0, 6000), null, taskId, JSON.stringify({ viaTask: taskId }), Date.now()
        );
        discussed = { entityType: String(p.entityType || "task"), entityId: String(p.entityId) };
      }
    } catch { /* 讨论回写失败不影响提交本身 */ }

    // ===== 2026-09-14: 人类决策超时 -> 8 维审视任务的产出**自动结单该待办**(用户要求: 不要一直等人) =====
    //   链路: auto-decide 扫描到"人类 30 分钟未决" -> 开 [决策包+8维审视] 任务(指派执行体) -> 执行体产出里带
    //   AUTO_DECISION 行 -> 这里把它写回待办(status=DONE, doneBy=system:auto-decision-8d), 随后由
    //   human-decision-consumer 生成落地任务并回写讨论串。人类随时可用自己的决定覆盖(那是 human 结单)。
    let autoDecision: { todoId?: string; decision?: string; followUpTaskId?: string } = {};
    try {
      let p2: any = {};
      try { p2 = JSON.parse((task as any).improvementPayload || "{}"); } catch {}
      if (p2?.kind === "HUMAN_DECISION_REVIEW" && p2?.decisionTodoId) {
        // 2026-09-18 机制修复(实测: 落地待办 todo_land_cpq1bwkv4731, 其【人类决定】竟是材料 JSON 回显):
        //   旧代码在 output 无 AUTO_DECISION 行时用 `output.slice(0,300)` 兜底当"人类决定" ——
        //   于是 429 报错原文 / 材料 JSON 回显被当决策, 把人类待办结单并生成伪落地待办, 再被升级成任务
        //   (同类: todo_land_1eclqh4e8eqk JSON 残片, todo_land_ib3dyd692eq1 dsh RATE_LIMIT 429)。
        //   修法: 解析不出 AUTO_DECISION 行 = 这次 8 维审视没有产出决策 -> **不结单、不生成落地单**,
        //   把源待办标 BLOCKED 并留痕(判定+写回见 pipeline/auto-decision.ts, 有真库快照回归)。
        const applied = await applyAutoDecisionToTodo({
          dbPath: process.env.MIND_DB_PATH || "prisma/dev.db",
          todoId: String(p2.decisionTodoId), taskId, agentId, output,
        });
        if (!applied.ok) {
          autoDecision = { todoId: String(p2.decisionTodoId), decision: "", followUpTaskId: undefined };
        } else {
          const decision = applied.decision;
          await prisma.flywheelEvent.create({
            data: { stage: "HUMAN_DECISION_AUTO_APPLIED", sourceType: "todo", sourceId: String(p2.decisionTodoId), taskId,
              sourceTitle: ("auto 8d-review -> " + decision.slice(0, 140)).slice(0, 300), targetStage: "OK" },
          }).catch(() => null);
          // 生成落地任务(路由规则与人类决定一致)
          const { consumeHumanDecision } = await import("@/server/pipeline/human-decision-consumer");
          const res = await consumeHumanDecision(String(p2.decisionTodoId));
          autoDecision = { todoId: String(p2.decisionTodoId), decision, followUpTaskId: res.followUpTaskId };
          // 回写讨论串: 明确告知"人类未决, 平台已自动处理, 可随时推翻"
          try {
            await runtimeRepo.run(
              "INSERT INTO Discussion (id, entityType, entityId, authorType, authorId, kind, body, replyToId, taskId, meta, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
              "dsc_auto_" + taskId.slice(-12), "todo", String(p2.decisionTodoId), "system", "auto-decision-8d", "event",
              "【人类未在时限内决策 -> 平台已按 8 维审视自动处理】\n决定: " + decision +
              "\n落地任务: " + (res.followUpTaskId || "(未生成)") + "\n依据(8 维审视结论节选): " + output.slice(0, 800) +
              "\n**人类随时可以提交自己的决定覆盖本条**(重新决策会生成新的落地任务)。",
              null, taskId, JSON.stringify({ auto: true, viaTask: taskId }), Date.now());
          } catch { /* 回写失败不影响 */ }
        }
      }
    } catch (e: any) {
      console.warn("[submit] 自动决策结单失败(非致命): " + String(e?.message || e).slice(0, 120));
    }

    // ===== 2026-09-15: 承接待办的任务完成 -> 自动结单来源待办(补上"升级后失联"的闭环) =====
    //   实测断裂(09-15 09:52): 文本通道 agent 领到"需要工具能力"的待办 -> 升级为任务交给执行体 -> 执行体做完
    //   (任务 DONE) -> **没有任何一条链路把结果回写给那条待办**, 于是待办永远停在 BLOCKED。
    //   用户看到的是"我提的需求被阻塞了", 而代码其实早已落地(7 条 DONE 的升级任务对应 7 条 BLOCKED 待办,
    //   含"统一外观/全局搜索/大表筛选/文案业务化"等用户亲口提的项)。
    //   线索两条(兼容历史与新增): ① materials.ledger.sourceTodo(执行体证据包写的) ② materials 文本里的 todo_xxx。
    let todoWriteback: string[] = [];
    // 2026-09-18: 回写证据不达标而**拒绝自动结单**的待办(留 OPEN 并留痕), 绝不制造"无证据 DONE"。
    const todoWritebackRejected: Array<{ todoId: string; missing: string[] }> = [];
    try {
      const leads = new Set<string>();
      const materialsStr = String((task as any).materials || "");
      try {
        const mm = JSON.parse(materialsStr);
        if (mm?.ledger?.sourceTodo) leads.add(String(mm.ledger.sourceTodo));
      } catch { /* materials 不是 JSON -> 走文本线索 */ }
      // 2026-09-15 机制修复(实测): 原判据 `/todo_[a-z0-9]{12,}/` 不含下划线, 而落地待办 id 形如
      //   `todo_land_gmkl2nwkjkba`(含 `_`) -> 承接任务完成后**永远匹配不到来源待办**, 待办停在 DOING。
      //   实测: 任务 cmu25rlba089oki4aj78i5v3n DONE 后 todo_land_gmkl2nwkjkba 仍 DOING。
      //   改为允许 `_`: 与 todo-store 生成的 id 字符集一致(本任务 todo_s3set25bec0wrcgs 仍能匹配)。
      for (const m of materialsStr.matchAll(/todo_[a-z0-9_]{12,}/gi)) leads.add(m[0]);
      if (leads.size) {

        // 2026-09-18 机制修复(待办 todo_land_xwpvc44dq7rw / 任务 cmu5m3mc1000tgfvbjyohakqt):
        //   回写线索是从 materials 自由文本里正则捞的 todo_xxx —— 只要报告里提到某张待办 id, 就可能把它结掉。
        //   实测事故: 两张**仍在等人类拍板**的决策卡(todo_bf3yge70a95qwmjk / todo_wfkvmykek25qwmid)
        //   因被无关任务 cmu5m1oa100078xd9ojf3zbip 的 evidence 文本提到, 于 2026-09-17T19:19:10 被静默置 DONE。
        //   任务完成 ≠ 人类已决策 -> 人类决策卡一律不自动结单(判据见 todo-writeback-guard.ts)。
        const { writebackCloseVerdict } = await import("@/server/pipeline/todo-writeback-guard");
        const rowsById = new Map<string, any>();
        {
          const leadList0 = [...leads];
          const ph = leadList0.map(() => "?").join(",");
          const rows: any[] = (await todoRepo.all("SELECT id,status,source,meta FROM Todo WHERE id IN (" + ph + ")", ...leadList0)) as any[];
          for (const r of rows) rowsById.set(String(r.id), r);
        }
        const closableLeads: string[] = [];
        const skippedHumanCards: Array<{ id: string; reason: string }> = [];
        for (const lead of leads) {
          const v = writebackCloseVerdict(rowsById.get(String(lead)) || { id: String(lead) });
          if (v.code === "CLOSE") closableLeads.push(String(lead));
          else skippedHumanCards.push({ id: String(lead), reason: v.reason });
        }
        {
          if (skippedHumanCards.length) {
            for (const s of skippedHumanCards) await todoRepo.run("UPDATE Todo SET note=?, updatedAt=? WHERE id=? AND status IN ('OPEN','DOING','BLOCKED')", s.reason, Date.now(), s.id);
            console.warn("[submit] 拒绝自动结单人类决策卡 " + skippedHumanCards.map((s) => s.id).join(", "));
          }
          // 2026-09-15 假完成防线(第二道): 任务正文里声明过的交付物**必须真实存在**, 否则不结单。
          const { declared, missing } = checkDeclaredArtifacts(task as any);
          if (missing.length) {
            // 不结单: 把待办留在原地, 并把"缺哪个文件"写进去 —— 让"没做完"停在被看得见的地方。
            for (const lead of closableLeads) {
              await todoRepo.run("UPDATE Todo SET note=?, evidence=?, updatedAt=? WHERE id=? AND status IN ('OPEN','DOING','BLOCKED')",
                "承接任务 " + taskId + " 已提交完成, 但声明的交付物不存在, 拒绝结单",
                ("任务 " + taskId + " 提交于 " + new Date().toISOString() + "(by " + agentId + "); 声明的交付物缺失: " +
                  missing.join(", ") + "; 待办保持未结, 请补齐后重新提交。产出节选: " + output.slice(0, 300)),
                Date.now(), lead);
              await prisma.flywheelEvent.create({
                data: { stage: "FAKE_COMPLETION_BLOCKED", sourceType: "todo", sourceId: lead, taskId,
                  sourceTitle: ("交付物不存在, 拒绝结单: " + missing.join(",") ).slice(0, 250), targetStage: "FAIL" },
              }).catch(() => null);
            }
            console.warn("[submit] 假完成拦截: 任务 " + taskId + " 声明交付物缺失 " + missing.join(", "));
          } else {
            for (const lead of closableLeads) {
              // 2026-09-18 修(用户实测: 24h 内 36 条无证据结单, 22 条"实质写在 note、evidence 留空"):
              //   回写路径原先只拼一句"证据节选: output.slice(0,500)", **不过证据预检** —— 产出偏短或纯结论时
              //   就落成"无证据 DONE"。现统一过 @/server/pipeline/todo-evidence-gate 的同一份规则:
              //   ① 先试产出节选; ② 不足则补**真实存在的**落盘文件锚点(storeTaskOutput 会写 logs/task-output/<id>.txt);
              //   ③ 仍不达标 -> **不自动结单**(留 OPEN + 写事件 TODO_WRITEBACK_EVIDENCE_REJECTED), 交执行体补证据。
              let ev = "任务 " + taskId + " 完成回写(by " + agentId + ")。证据(任务产出节选): " + String(output).slice(0, 1000);
              if (!checkTodoCloseEvidence(ev).ok) {
                const rel = "logs/task-output/" + taskId + ".txt";
                try {
                  const fsMod: any = await import("fs");
                  const pathMod: any = await import("path");
                  if (fsMod.existsSync(pathMod.join(process.cwd(), rel))) {
                    ev = "任务 " + taskId + " 完成回写(by " + agentId + ")。完整产出已落盘: file:" + rel + " ; 节选: " + String(output).slice(0, 1000);
                  }
                } catch { /* 探测失败: 不加锚点, 走拒绝分支 */ }
              }
              const chk = checkTodoCloseEvidence(ev);
              if (!chk.ok) { todoWritebackRejected.push({ todoId: lead, missing: chk.missing }); continue; }
              // 2026-10-27（商业化线 3）: 守门来源的待办**不能经 submit 的 todo 回写被结单**。
              //   实测: agent-operator 经这条路径结掉了 todo_plautonomy_mvkhv3in
              //   （03:26:26 TODO_STATUS DOING->DONE by agent:agent-operator via submit）。
              //   PATCH /todos 侧已加门，但 submit 是**另一条写路径**，当时没堵 —— 这就是"还有路径没堵"。
              {
                const srcOf = String(((rowsById.get(String(lead)) as any) || {}).source || "");
                const closeVerdict = canCloseTodo(srcOf, { kind: "agent", actor: String(agentId) });
                // 2026-10-27（商业化线要求）: 结单决策必须留痕，否则"谁/哪条路径结的"只能靠猜。
                //   记录: 来源 / actor / 判定 / 是否被拒。日志与事件双写，便于事后溯源。
                console.log("[submit.todoWriteback] todoId=" + lead + " source=" + (srcOf || "(空)") +
                  " actor=" + agentId + " kind=agent allowed=" + closeVerdict.allowed +
                  " reason=" + closeVerdict.reason);
                if (!closeVerdict.allowed) {
                  await prisma.flywheelEvent.create({ data: {
                    stage: "GUARD_TODO_CLOSE_FORBIDDEN", sourceType: "todo", sourceId: String(lead),
                    sourceTitle: ("path=submit.todoWriteback by=" + agentId + " source=" + (srcOf || "(空)")).slice(0, 240),
                    targetStage: "OK",
                  } }).catch(() => null);
                  todoWritebackRejected.push({ todoId: lead, missing: [closeVerdict.reason] });
                  continue;
                }
              }
              const r = await todoRepo.run("UPDATE Todo SET status='DONE', doneAt=?, doneBy=?, note=?, evidence=?, updatedAt=? WHERE id=? AND status IN ('OPEN','DOING','BLOCKED')", Date.now(), "system:todo-task-writeback",
                "承接任务已完成: " + taskId + " (by " + agentId + ")",
                ev,
                Date.now(), lead);
              if (r.changes === 1) todoWriteback.push(lead);
            }
          }
        }
        for (const s of skippedHumanCards) {
          await prisma.flywheelEvent.create({
            data: { stage: "SKIPPED_CLOSE_HUMAN_CARD", sourceType: "todo", sourceId: s.id, taskId,
              sourceTitle: ("任务 " + taskId + " 完成, 但该待办是等人拍板的人类决策卡 -> 拒绝自动结单").slice(0, 250), targetStage: "OK" },
          }).catch(() => null);
        }
        for (const lead of todoWriteback) {
          await prisma.flywheelEvent.create({
            data: { stage: "TODO_CLOSED_BY_TASK", sourceType: "todo", sourceId: lead, taskId,
              sourceTitle: ("承接任务 " + taskId + " 完成 -> 待办自动结单").slice(0, 250), targetStage: "OK" },
          }).catch(() => null);
        }
        // 拒绝结单也要留痕(可观测: "有多少回写因证据不足没结", 而不是静默留着 OPEN 让人疑惑)
        for (const rj of todoWritebackRejected) {
          await prisma.flywheelEvent.create({
            data: { stage: "TODO_WRITEBACK_EVIDENCE_REJECTED", sourceType: "todo", sourceId: rj.todoId, taskId,
              sourceTitle: ("任务 " + taskId + " 完成但回写证据不足, 拒绝自动结单: " + rj.missing.join("; ") + " (待办留 OPEN, 请补证据)").slice(0, 250),
              targetStage: "OK" },
          }).catch(() => null);
          console.warn("[submit] 回写证据不足, 拒绝自动结单: todo=" + rj.todoId + " task=" + taskId + " missing=" + rj.missing.join("; "));
        }
      }
    } catch (e: any) {
      console.warn("[submit] 待办回写失败(非致命): " + String(e?.message || e).slice(0, 120));
    }

    // ===== 2026-09-10: agent 标注 [需要人类决策] -> 自动生成人类待办(独立实体 Todo) =====
    let todoId: string | null = null;
    try {
      const { createHumanTodoFromTaskOutput } = await import("@/server/pipeline/todo-store");
      const r = await createHumanTodoFromTaskOutput({ taskId, taskTitle: String(task.title || ""), agentId, output });
      todoId = r?.id ?? null;
    } catch { /* 待办生成失败不影响提交本身 */ }

    // ===== 2026-09-10 成本归因: agent 自报用量 -> CALL_LLM 事件(可按住 agent 聚合) =====
    //   此前 FlywheelEvent 只记平台侧调用, 各 agent 自己的 LLM 消耗完全不可见。
    let usageRecorded: { tokens?: number; model?: string; calls?: number } | null = null;
    try {
      const u = body.usage;
      const tokens = Number(u?.totalTokens ?? ((u?.inputTokens || 0) + (u?.outputTokens || 0)));
      if (u && tokens > 0) {
        const model = String(u.model || "unknown").slice(0, 60);
        const calls = Math.max(1, Number(u.calls || 1));
        await prisma.flywheelEvent.create({
          data: {
            stage: "CALL_LLM",
            sourceType: "agent:" + agentId,
            sourceId: taskId,
            sourceTitle: ("tok=" + tokens + " model=" + model + " entry=agent-submit calls=" + calls).slice(0, 300),
            targetStage: "OK",
          },
        });
        usageRecorded = { tokens, model, calls };
      }
    } catch { /* 用量记录失败不影响提交本身 */ }

    try {
      // 2026-09-11 第 36 轮: 同步放宽入库截断(原 2000 字)。实测我的更正条目入库后长度恰为 2000, 属被截断,
      //   复核者要核对的"修复 diff + debug 步骤"可能正好被切掉。放宽到 12000, 仍保留上限防异常巨型输出。
      const outText = output.length > 12000 ? output.slice(0, 12000) : output;
      // 2026-09-10 质量治理: agent 产出不再直接当"正式知识", 先进候选区(verification=PENDING_REVIEW),
      //   由另一 agent 或人类复核后才转正; 测试/联调来源直接拒收, 避免污染知识库。
      const isTestSource = /(^|[-_])e2e([-_]|$)|^test/i.test(agentId);
      const hash = createHash("sha256").update((task.title || "") + "\n" + outText).digest("hex");
      // 2026-10-25 撤回流程补漏: 同内容判重只看**活行**(未撤回 + 未被取代)。
      //   原实现只挡 supersededBy -> 被撤回(stale=1, supersededBy=NULL)的知识行仍会挡住
      //   agent 产出回写入库, 撤回等于把这条内容永久封死。
      // asset-scope-exempt: contentHash 去重探针（只返回 id，不返回内容）
      const dup = await prisma.knowledge.findFirst({ where: liveRowWhere("knowledge", { contentHash: hash }), select: { id: true } });
      if (isTestSource || verdict.candidateId != null) {
        ingested.skipped = ingested.skipped || (verdict.candidateId != null ? "验证任务产出不回写入库(避免自我引用)" : ("测试来源(agent=" + agentId + "), 拒收不入库"));
      } else if (dup) {
        ingested.skipped = "同内容已入库 " + dup.id.slice(-6);
      } else if (outText.trim().length >= 200) {
        const conf = Math.min(0.5, Number(body.qualitySelf ?? 0.6));
        const q = calcQualityScore({ type: "knowledge", content: outText, title: task.title, category: "AGENT_OUTPUT", confidence: conf });
        const k = await safeCreateKnowledge(prisma, {
          data: {
            title: ("[agent 结论] " + (task.title || "")).slice(0, 120),
            content: outText,
            sourceType: "AGENT_OUTPUT",
            sourceId: taskId,
            contentHash: hash,
            theme: task.theme ?? null,
            category: "AGENT_OUTPUT",
            agentSource: "agent:" + agentId,
            confidence: conf,
            qualityScore: q,
            verification: "PENDING_REVIEW",
            humanConfirmed: false,
            tags: JSON.stringify({ taskId, agentId, improvementType: task.improvementType, qualitySelf: body.qualitySelf ?? null }),
          },
          select: { id: true },
        });
        if (!k) {
          ingested.skipped = "store 内容闸拒绝(不合规), 不入库";
        } else {
        ingested.knowledgeId = k.id;
        ingested.staged = true;
        await prisma.flywheelEvent.create({
          data: { stage: "AGENT_OUTPUT_INGESTED", sourceType: "submit", sourceId: taskId, sourceTitle: ("agent=" + agentId + " candidate=PENDING_REVIEW knowledge=" + k.id + " q=" + q.toFixed(2)).slice(0, 300), targetStage: "OK" },
        }).catch(() => null);
        }
      } else {
        ingested.skipped = "输出过短(<200字), 不入库(避免稀释记忆)";
      }

      // 注入使用追踪: 认领时记录过 CONTEXT_INJECTED, 这里按实际使用计一次(供冷却/质量迭代)
      const inj = await prisma.flywheelEvent.findFirst({ where: { stage: "CONTEXT_INJECTED", sourceId: taskId }, orderBy: { createdAt: "desc" }, select: { sourceTitle: true } });
      if (inj?.sourceTitle) {
        // 2026-09-11 P0 记忆->使用闭环: 原来只认 JSON, claim-by-id 路径的 "ids=a,b,c" 一律解析失败 ->
        //   那条路径注入的产物永远不算"被使用"。改用统一解析(兼容 JSON 与旧 ids= 形态)。
        const ids: string[] = parseInjectedIds(inj.sourceTitle).slice(0, 20);
        if (ids.length) {
          const now2 = new Date();
          const [mk, kk, sk] = await Promise.all([
            prisma.memory.updateMany({ where: { id: { in: ids } }, data: { accessCount: { increment: 1 }, lastAccessed: now2 } }).catch(() => ({ count: 0 })),
            prisma.knowledge.updateMany({ where: { id: { in: ids } }, data: { usageCount: { increment: 1 }, lastUsedAt: now2 } }).catch(() => ({ count: 0 })),
            prisma.skill.updateMany({ where: { id: { in: ids } }, data: { totalUsageCount: { increment: 1 } } }).catch(() => ({ count: 0 })),
          ]);
          ingested.usageBumped = (mk?.count || 0) + (kk?.count || 0) + (sk?.count || 0);

          // 2026-09-16 P0 机制修复: extractAdopted7d 结构性为 0 (todo_8nevg4ol282ky6wt)
          // 根因: submit 只 increment accessCount/usageCount(被看到), 没写 CONTEXT_USED 事件 + usedCount+1,
          //   飞轮核心指标 extractAdopted7d 只认 usedCount, 恒为 0; 09-14 拆分定义的新口径
          //   (usedCount/CONTEXT_USED) 只有测试脚本写, 生产 CONTEXT_USED 09-15 起 0 条。
          // 修法: 在 submit 落地实际采用时, 同步写 CONTEXT_USED 事件 (事实源) + Memory/Knowledge.usedCount+1
          //   (派生统计), 与 recompute-used-count.cjs 的重算口径一致 (parseInjectedIds.slice(0,20) 同源)。
          // 事件 sourceTitle 形态沿用 buildInjectedTitle (JSON, 兼容 recompute 的 sourceTitle JSON.parse 路径)。
          // 2026-09-22 字段名回归修复(因任务 cmuc5x83200cs8tc7yguv4aze 等 tsc 守门需要, 由 rebase main 合流):
          //   原代码 (2026-09-16 agent-e b1ae5a3) 写的是 `usedCount` 这个**虚构字段** ——
          //   Memory schema 字段名是 `accessCount` (L525 已 increment), Knowledge 是 `usageCount` (L526 已 increment)。
          //   既无 `usedCount` 字段, 两条 updateMany 在生产中静默抛 TS2353(被 .catch(()=>({count:0}))吞掉, count 始终 0),
          //   实际从未累加。直接复用上一段的 accessCount/usageCount 累加结果, 不再重复 updateMany,
          //   沿用原 `usedCountBumped` 字段名保持对外接口稳定。
          //   [rebase 冲突合流说明] main 上 2026-09-21 的修法是把 usedCount 改名为 accessCount/usageCount
          //   再 updateMany 一次, 但与上方 mk/kk 块重复累加(每次使用 +2); 此处采用分支侧修法(复用 mk/kk, +1 一次)。
          ingested.usedCountBumped = (mk?.count || 0) + (kk?.count || 0);
          await prisma.flywheelEvent.create({
            data: {
              stage: "CONTEXT_USED",
              sourceType: "submit",
              sourceId: taskId,
              sourceTitle: buildInjectedTitle({
                agentId: agentId,
                source: "submit",
                count: ids.length,
                kinds: [],
                ids: ids,
              }),
              targetStage: "OK",
            },
          }).catch((e: any) => console.warn("[submit] CONTEXT_USED 事件写入失败(非致命): " + String(e?.message || "").slice(0, 100)));

          // 2026-10-26 北极星前置: 引用(ASSET_CITED) —— 只认产出里出现的**完整 id**。
          //   与 CONTEXT_USED 的区别: CONTEXT_USED 是"提交成功就算用了全部注入"; ASSET_CITED 是
          //   "产出里真的出现了哪几条"。两者都要，但口径必须在看板分开标。
          //   幂等: 同一 task 只写一条; 写失败不阻断提交。
          try {
            const cited = extractCitedIds(outText, ids);
            if (cited.length) {
              const exists = await prisma.flywheelEvent.findFirst({
                where: { stage: "ASSET_CITED", sourceId: taskId }, select: { id: true },
              });
              if (!exists) {
                await prisma.flywheelEvent.create({
                  data: {
                    stage: "ASSET_CITED",
                    sourceType: "submit",
                    sourceId: taskId,
                    sourceTitle: JSON.stringify({ agentId, count: cited.length, ids: cited, method: "full-id" }).slice(0, 900),
                    targetStage: "OK",
                    taskId,
                  },
                });
              }
              ingested.citedCount = cited.length;
            } else {
              ingested.citedCount = 0;
            }
          } catch (e: any) {
            console.warn("[submit] ASSET_CITED 事件写入失败(非致命): " + String(e?.message || "").slice(0, 100));
          }
        }
      }
    } catch (e: any) {
      console.warn("[submit] 输出回写平台记忆失败(非致命): " + String(e?.message || "").slice(0, 100));
    }

    return Response.json({ ok: true, taskId, status: "DONE", ingested, ...(evidencePreflight ? { evidencePreflight } : {}), ...(autoDecision.todoId ? { autoDecision } : {}), ...(todoWriteback.length ? { todoWriteback } : {}) });
  } catch (e: any) {
    // 2026-10-26: 这个 catch 原来只返回错误、**不写任何日志** —— 于是 500 在服务端毫无痕迹。
    //   今天排查 submit 500 时，客户端只有 "HTTP Error 500"、服务端什么都没有，
    //   只能靠"副作用事件已落库但响应 500"这种间接证据反推（说明是**提交之后的收尾阶段**抛的）。
    //   现在把 taskId/agentId/message/stack 落日志；响应体保持原样，不改客户端契约。
    console.error(
      "[submit] SUBMIT_FAILED taskId=" + String(taskId ?? "") +
      " agentId=" + String(agentId ?? "") +
      " message=" + String((e && e.message) || e) +
      "\nstack: " + String((e && e.stack) || "(no stack)")
    );
    return Response.json({ error: "SUBMIT_FAILED", message: String((e && e.message) || e) }, { status: 500 });
  }
}
