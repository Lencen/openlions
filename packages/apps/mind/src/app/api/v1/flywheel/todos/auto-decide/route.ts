import { openMindDb } from "@/server/lib/open-mind-db";
import { todoRepo } from "@/server/lib/todo-repo";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import path from "path";

/**
 * POST /api/v1/flywheel/todos/auto-decide — 2026-09-14
 *
 * 用户要求: 「需要我(人类)决策的, 超过 30 分钟我没有决策, 就应该自动跑 8 维审视, 按审视后的建议自动处理,
 *            而不是一直等我」
 *
 * 做法(不替人拍板, 但也不让平台停摆):
 *   1. 扫描"人类待办"中 OPEN 且**已等待超过 HUMAN_DECISION_TIMEOUT_MIN(默认30分钟)** 的;
 *   2. 为每条开一条 [决策包+8维审视] 任务(指派执行体): 让它判断"这事是不是真需要人拍板",
 *      确需 -> 给出 2-4 个选项与后果并**推荐一个**; 不需 -> 直接给出平台应当执行的动作;
 *   3. 任务产出里必须带一行 `AUTO_DECISION: <选项或动作>`;
 *   4. 提交时(见 tasks/submit)由平台**自动把该待办结单**(doneBy=system:auto-decision-8d)并生成落地任务,
 *      同时在讨论串写明"人类未在 30 分钟内决策, 平台已按 8 维审视建议处理, 可随时推翻"。
 *
 * 与"人类干预"口径的关系: 自动决策记的 actor 是 **system**, 不是 human —— 不会污染自主率指标;
 *   人类任何时候仍可在待办上提交自己的决定(那是 human 结单, 覆盖自动结论)。
 */
const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");

// 8 维审视清单见 @/server/pipeline/eight-dimensions(Next 路由文件不允许额外导出, 故独立成模块)
import { EIGHT_DIMENSIONS } from "@/server/pipeline/eight-dimensions";;

async function openDb() {

  const db = openMindDb({ role: "direct-rw", dbPath: DB_PATH, caller: "route" });

  return db;
}

export async function POST(_req: NextRequest) {
  const TIMEOUT_MIN = Number(process.env.HUMAN_DECISION_TIMEOUT_MIN ?? 30);
  const cutoff = Date.now() - TIMEOUT_MIN * 60000;
  const created: Array<{ todoId: string; taskId: string }> = [];
  const skipped: Array<{ todoId: string; reason: string }> = [];

  const rows: any[] = (await todoRepo.all(
    "SELECT id, title, detail, meta, createdAt, priority FROM Todo " +
    "WHERE ownerType='human' AND status='OPEN' AND createdAt <= ? ORDER BY priority, createdAt LIMIT 20", cutoff)) as any[];

  for (const t of rows) {
    let meta: any = {};
    try { meta = t.meta ? JSON.parse(String(t.meta)) : {}; } catch { meta = {}; }
    // 2026-09-14: 已被判定为"只能人拍板"的(humanOnly)不再自动审视 —— 否则会形成
    //   "自动审视 -> 判定给人 -> 生成决策卡 -> 30 分钟后又自动审视" 的死循环。
    if (meta.humanOnly) { skipped.push({ todoId: String(t.id), reason: "已判定只能人拍板(humanOnly), 等人类决策" }); continue; }
    if (meta.autoReviewTaskId) {
      const prev: any = await prisma.task.findUnique({ where: { id: String(meta.autoReviewTaskId) }, select: { status: true } }).catch(() => null);
      if (prev && ["PENDING", "IN_PROGRESS"].includes(String(prev.status))) { skipped.push({ todoId: String(t.id), reason: "已有进行中的自动审视" }); continue; }
    }
    const { buildEntityContext } = await import("@/server/pipeline/discussion-context");
    const ctx = await buildEntityContext("todo", String(t.id));
    const opts = Array.isArray(meta.options) && meta.options.length
      ? "【平台已备好的选项】\n" + meta.options.map((o: any, i: number) => "  " + (i + 1) + ") " + (typeof o === "string" ? o : JSON.stringify(o)).slice(0, 300)).join("\n")
      : "【平台未备选项】你需要自己给出 2-4 个候选方案。";
    try {
      const task = await prisma.task.create({
        data: {
          title: ("[决策包+8维审视] " + String(t.title || "")).slice(0, 180),
          description: [
            "【背景】这条是**人类决策待办**, 已等待超过 " + TIMEOUT_MIN + " 分钟仍无人决策。平台不停摆原则: 由你按 8 维审视给出建议并**由平台自动执行**。",
            ctx.text,
            opts,
            "【你要做的】",
            "① 先判定: 这件事**是否真的需要人类拍板**? (涉及钱/合规/对外承诺/不可逆的业务取舍 -> 需要; 纯技术选择 -> 不需要)",
            "② 若需要: 给出 2-4 个选项, 每个写清**后果/成本/风险**, 并**明确推荐一个**;",
            "③ 若不需要: 直接给出平台应当执行的动作(具体到可落地);",
            "④ 逐条过 8 维审视(见下), 指出任何一维不通过的理由;",
            "【8 维审视清单】",
            ...EIGHT_DIMENSIONS,
            "【输出格式(硬性)】最后必须单独一行:",
            "  AUTO_DECISION: <平台可立即执行的动作, 一句话>",
            "或(仅当属于下面四类之一时):",
            "  AUTO_DECISION: HUMAN_ONLY: <一句话说明要人拍板什么> | 选项: A)… B)… C)… | 推荐: X (一句话理由)",
            "【硬性规则(2026-09-14 实测修正)】",
            "1) **禁止把球踢回给人**: 上一版允许写'转人工/需人拍板/DEFER_TO_HUMAN', 结果 21 条自动决策里 7 条原样推回,",
            "   用户明确说'我处理不了这些数据' —— 那是平台该做的事, 不是人的事。",
            "2) 只有这四类才允许判给人: **花钱 / 合规法务 / 对外承诺 / 不可逆的业务取舍**。",
            "   属这四类时必须给出 2-4 个选项与后果 + 推荐一个, 让人**只看一张卡就能点选**;",
            "3) 其余情况一律给出平台自己能执行的动作(具体到命令/改动/数据处理方式);",
            "4) AUTO_DECISION 行只放**结论**, 推理过程写在正文, 不要混进行里。",
            "人类随时可以用自己的决定覆盖你; 但默认你必须把能做的做掉。",
          ].join("\n"),
          background: "人类决策超时 -> 平台自动 8 维审视 (auto-decide " + new Date().toISOString() + ")",
          requirements: "判定是否需人拍板 + 给选项与后果 + 推荐一个 + 输出 AUTO_DECISION 行。",
          materials: JSON.stringify({ decisionTodoId: t.id, waitedMinutes: Math.round((Date.now() - Number(t.createdAt)) / 60000), timeoutMin: TIMEOUT_MIN, options: meta.options || null }),
          acceptanceCriteria: "含 AUTO_DECISION 行 + 推荐理由 + 8 维逐条结论; 人类可直接读懂",
          qualityStandards: "明确/可执行/诚实标注不确定",
          status: "PENDING",
          priority: "P1",
          theme: "人类决策自动处理",
          improvementType: "GOAL_GAP",
          manualReview: false,
          assignedAgent: process.env.HUMAN_DECISION_EXECUTOR || "agent-d",
          improvementPayload: JSON.stringify({ kind: "HUMAN_DECISION_REVIEW", decisionTodoId: t.id }),
          structuredContext: JSON.stringify({ sourceChain: { type: "Todo", id: t.id, reason: "human decision timeout" } }),
        },
        select: { id: true },
      });
      meta.autoReviewTaskId = task.id;
      meta.autoReviewAt = new Date().toISOString();
      await todoRepo.run("UPDATE Todo SET meta = ?, updatedAt = ? WHERE id = ?", JSON.stringify(meta), Date.now(), String(t.id));
      await prisma.flywheelEvent.create({
        data: { stage: "HUMAN_DECISION_AUTO_REVIEW", sourceType: "todo", sourceId: String(t.id), taskId: task.id,
          sourceTitle: ("human 未在 " + TIMEOUT_MIN + " 分钟内决策 -> 自动开 8 维审视任务 " + task.id).slice(0, 300), targetStage: "OK" },
      }).catch(() => null);
      created.push({ todoId: String(t.id), taskId: task.id });
    } catch (e: any) {
      skipped.push({ todoId: String(t.id), reason: "创建失败: " + String(e?.message || e).slice(0, 100) });
    }
  }
  return NextResponse.json({ ok: true, timeoutMin: TIMEOUT_MIN, scanned: rows.length, created, skipped });
}

export async function GET() {
  return NextResponse.json({ ok: true, timeoutMin: Number(process.env.HUMAN_DECISION_TIMEOUT_MIN ?? 30), dimensions: EIGHT_DIMENSIONS,
    usage: "POST 触发扫描(由 crontab 每 10 分钟调用)" });
}
