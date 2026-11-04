import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildVerifyEvidencePack, renderEvidencePack } from "@/server/pipeline/verify-evidence-pack";

export const dynamic = "force-dynamic";

/**
 * 2026-09-10 治本(用户口径: agent 产出与 session 一样进飞轮处理, 不另设人工评审队列):
 *  POST /api/v1/flywheel/agent-output/verify-tasks?limit=5
 *  未复核的 agent 结论候选(verification=PENDING_REVIEW) -> 自动开"验证任务"(GOAL_GAP 家族, improvementPayload.kind=VERIFY_AGENT_OUTPUT),
 *  由另一个 agent 认领: 查库/查接口/查文件给证据或反例, 输出首行必须是 VERDICT: VERIFIED 或 VERDICT: REJECTED。
 *  提交时由 submit 路由自动把结论写回候选(转正/否决), 人的角色退化为抽查与否决(veto)。
 */
const THEME = "验证·agent产出";

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 5)));
  // 2026-09-11 P0 (任务 cmtvfgeps00121j765jmy4sk7): 修"验证任务重复派发"的主源。
  //   实测: 候选只按 verification='PENDING_REVIEW' 取; 而 agent 交了 NO_VERDICT(没给裁定)时提交侧**不改变**候选状态,
  //   于是同一个候选被反复开单 —— 实测候选 cmtvg7zyi… 被开了 4 条 DONE 验证任务, 另有多个候选各 3 条。
  //   修法: 在候选 tags 里记未判定次数, 达到上限(默认 2)后不再自动开单, 转人工(避免无限循环与白烧 token)。
  const NO_VERDICT_MAX = Number(process.env.VERIFY_NO_VERDICT_MAX ?? 2);
  // asset-scope-exempt: 平台自动派单作业（无调用者身份；按设计对全部 PENDING_REVIEW 候选开单，按归属过滤会漏派）
  const raw = await prisma.knowledge.findMany({
    where: { sourceType: "AGENT_OUTPUT", verification: "PENDING_REVIEW", stale: false },
    orderBy: { createdAt: "asc" },
    take: limit * 3,
    select: { id: true, title: true, content: true, qualityScore: true, agentSource: true, sourceId: true, theme: true, createdAt: true, tags: true },
  });
  const exhausted: Array<{ candidateId: string; attempts: number }> = [];
  const candidates = raw.filter((c) => {
    let n = 0;
    try { n = Number(JSON.parse(String(c.tags || "{}"))?.verifyNoVerdict ?? 0); } catch { n = 0; }
    if (n >= NO_VERDICT_MAX) { exhausted.push({ candidateId: c.id, attempts: n }); return false; }
    return true;
  }).slice(0, limit);
  const active = await prisma.task.findMany({
    where: { theme: THEME, status: { notIn: ["DONE", "FAILED", "DEPRECATED"] } },
    select: { id: true, improvementPayload: true },
  });
  const busy = new Set<string>();
  for (const t of active) {
    try { const p = JSON.parse(t.improvementPayload || "{}"); if (p?.candidateId) busy.add(String(p.candidateId)); } catch {}
  }
  const created: Array<{ candidateId: string; taskId: string }> = [];
  const skipped: Array<{ candidateId: string; reason: string }> = [];
  for (const c of candidates) {
    if (busy.has(c.id)) { skipped.push({ candidateId: c.id, reason: "已有活跃验证任务" }); continue; }
    const submitter = String(c.agentSource || "unknown");
    // 2026-09-14: 开单侧先跑确定性证据, 随任务下发(让文本通道也能做有依据的判断, 而不是空转)
    let evidencePackText = "";
    let evidencePack: any = null;
    try {
      evidencePack = await buildVerifyEvidencePack({
        id: c.id, title: c.title, content: c.content, contentHash: (c as any).contentHash,
        theme: c.theme, agentSource: c.agentSource, qualityScore: c.qualityScore, sourceId: c.sourceId,
      });
      evidencePackText = renderEvidencePack(evidencePack);
    } catch (e: any) {
      evidencePackText = "【证据包(开单侧确定性生成)】生成失败: " + String(e?.message || e).slice(0, 80) + " —— 本次只能依据候选正文与既有知识判断。";
    }
    const acceptance = [
      "【输出格式(硬性)】第一行必须是 `VERDICT: VERIFIED` 或 `VERDICT: REJECTED`, 随后给出证据/反例与查证命令。",
      "【判定口径】VERIFIED = 你能用平台数据/代码/接口复现该结论, 且结论表述准确无误导; REJECTED = 与事实不符/证据不足/只是过程叙述/与既有已验证知识重复冲突。",
      // 2026-09-14 修(实测空转根因): 原文要求"必须给出可复现的查证方式(DB 查询/…)" —— 对**没有数据访问**的
      //   文本通道 agent 是做不到的要求, 于是它们只能回 UNVERIFIABLE(近 2h 如此 25 条, VERIFY 类占任务量 79%)。
      //   现在开单侧已经把确定性证据跑好随任务下发(见 materials.evidencePack), 证据要求随之改为"引用+说明"。
      "【证据要求】任务已随附**证据包**(同主题已有知识/同内容哈希命中/来源任务状态/主题产物存量, 每项带可原样重放的 SQL)。请直接引用其中的具体条目作为依据; 若你认为还需要证据包之外的材料(例如代码行号、线上接口返回), 请**明确写出你缺哪一项** —— 那本身就是一条有价值的结论, 不要用空话或复述原文代替。",
      "【回避】本条候选提交者 = " + submitter + "; 若你是提交者请勿自证, 直接说明并让其他 agent 认领。",
    ].join("\n");
    try {
      const task = await prisma.task.create({
        data: {
          title: ("[VERIFY_AGENT_OUTPUT] 验证 agent 结论: " + (c.title || "")).slice(0, 180),
          description: [
            "【要验证的结论】" + (c.title || ""),
            "【候选全文】" + String(c.content || "").slice(0, 1800),
            "【来源】提交者 " + submitter + " / 任务 " + (c.sourceId || "-") + " / 候选质量分 " + (c.qualityScore ?? "-") + " / 候选 id " + c.id,
            "【为什么开这条】agent 产出属未证实结论, 按平台口径与 session 一样进飞轮: 结论只有被独立验证才能进正式知识并被注入上下文。",
            acceptance,
            evidencePackText,
          ].join("\n"),
          background: "agent 产出候选独立验证 (verify-tasks " + new Date().toISOString() + ")",
          requirements: "对该结论给出 VERDICT(VERIFIED/REJECTED) 与可复现证据; 提交后平台自动更新候选状态。",
          acceptanceCriteria: "输出含 VERDICT 行 + 至少一条可复现证据; 由平台自动写回候选(转正/否决)",
          qualityStandards: "独立判断(不自证)/ 证据可复现 / 诚实(证据不足就 REJECTED 并说明)",
          status: "PENDING",
          priority: "P2",
          theme: THEME,
          improvementType: "VERIFY_AGENT_OUTPUT",
          manualReview: false,
          improvementPayload: JSON.stringify({ kind: "VERIFY_AGENT_OUTPUT", candidateId: c.id, candidateTitle: (c.title || "").slice(0, 120), submitter }),
          structuredContext: JSON.stringify({ sourceChain: { type: "KnowledgeCandidate", id: c.id, submitter }, candidateQuality: c.qualityScore }),
          materials: JSON.stringify({
            candidateId: c.id,
            howToVerify: "证据包已随任务下发(每项带 SQL 可原样重放); 需要额外核实请在结论里写明缺哪一项",
            evidencePack,
            relatedDocs: ["docs/platform-logic/knowledge.md", "docs/platform-logic/goals.md"],
          }),
        },
        select: { id: true },
      });
      created.push({ candidateId: c.id, taskId: task.id });
      await prisma.flywheelEvent.create({
        data: { stage: "KNOWLEDGE_VERIFY_TASK", sourceType: "verify-tasks", sourceId: c.id, sourceTitle: ("task=" + task.id + " candidate=" + c.id).slice(0, 200), targetStage: "OK" },
      }).catch(() => null);
    } catch (e: any) {
      skipped.push({ candidateId: c.id, reason: "创建失败: " + (e?.message || String(e)).slice(0, 120) });
    }
  }
  return NextResponse.json({ ok: true, scanned: raw.length, openable: candidates.length, created, skipped, exhaustedNoVerdict: exhausted });
}