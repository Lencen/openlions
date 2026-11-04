import { NextResponse } from "next/server";
import fs from "fs";
import { improvementTypeSql } from "@/config/taskScopes";
import { q, one, openMind, openSession } from "@/lib/server/lions-db";

// 2026-10-15 round-78: **真静态风险**(不 fetch, 只读打开 mind + session 两个库 + 读 /tmp/lions-flywheel.log) ——
//   它确实会被 build 期预渲染, 把"飞轮在不在转/每步堆积"冻在编译时刻, 且 build 期直读两个生产库。
//   另有按 Date.now() 的 5m/15m/1h/24h 窗口, 静态化后窗口相对量全部失真。故 force-dynamic。
export const dynamic = "force-dynamic";

// 飞轮运转动态图 API v3 (2026-09-09)
// 目标: ①飞轮在不在转 ②每步输入来源/处理量/堆积 ③产出质量(含未打分审计) ④哪些 session 被处理过
//
// 口径修正记录 (v2 -> v3):
// 1) steps 原用"旧 stage 映射"(MEMORIZE/EVALUATE/REFLECT…), 而旧流水线已停发事件 ~2 天,
//    当前真实事件只有 CALL_LLM(按 sourceType 区分入口) 与 REFLECTION_TO_TASK →
//    现按真实事件 + 权威表证据分步计数(每步 desc 标注口径), scan/extract/write/reflect 不再因映射错误恒 0;
// 2) reflectStatus 原按 createdAt>24h(反思行按主题 upsert, createdAt 多为历史) → 改按 updatedAt>24h;
// 3) quality 原只统计"有分"行且忽略未打分(新行未打分 -> avg 恒 0 误导) → 现返回 total/scored/unscored/avg(有分行),
//    未打分缺口对应"落库行质量分补齐"(calcQualityScore 覆盖 FLYWHEEL_STRUCTURED/BRIDGE 写入路径, 见 execute-improving-task.ts);
// 4) 质量表用 FlywheelReflection(coverageScore, updatedAt 窗口) 替代已停用的旧 Reflection 表。
const FLYWHEEL_LOG = "/tmp/lions-flywheel.log";

export async function GET() {
  try {
    const mind = openMind();
    const sess = openSession();
    const now = Date.now();
    const m5 = now - 5 * 60 * 1000;
    const m15 = now - 15 * 60 * 1000;
    const h1 = now - 3600 * 1000;
    const h24 = now - 24 * 3600 * 1000;
    // q/one 来自 lions-db（PG 连接池 + 方言）
    const W = [
      ["m5", m5], ["m15", m15], ["h1", h1], ["h24", h24],
    ] as const;

    // ========== 1. 事件打点 -> 步骤映射 (当前真实事件 + 遗留 stage 兜底) ==========
    // CALL_LLM: sourceType 即入口(reflect / improving-tasks / main-extract…)
    const llmStep = (entry: string): string => {
      if (entry === "reflect") return "reflect";
      if (entry === "improving-tasks") return "improve";
      if (entry === "main-extract" || entry === "main-extract-batch") return "extract";
      if (entry === "structured") return "structure";
      return "llm-other";
    };
    // 遗留 stage(旧流水线): 若重新启用仍可计数
    const legacyStep: Record<string, string> = {
      MEMORIZE: "write", KNOWLEDGE: "write", PRACTICE: "write",
      EVALUATE: "extract", LEARN: "extract",
      REFLECT: "reflect",
      OUTCOME: "improve", REFLECTION_TO_TASK: "improve", TASK_TO_FILL: "improve",
      GLOBAL_ORGANIZER: "backfill",
    };
    // 每窗一次聚合: stage->n, CALL_LLM 按 sourceType 再拆
    const evAcc: Record<string, Record<string, number>> = {};
    for (const [wn, w] of W) {
      const acc: Record<string, number> = {};
      const rows = await q(mind, "SELECT stage, sourceType, COUNT(*) c FROM FlywheelEvent WHERE createdAt > ? GROUP BY stage, sourceType", w) as any[];
      for (const r of rows) {
        if (r.stage === "CALL_LLM") {
          const step = llmStep(r.sourceType || "");
          acc[step] = (acc[step] || 0) + r.c;
          if (step !== "llm-other") acc.llmTotal = (acc.llmTotal || 0) + r.c;
          continue;
        }
        const step = legacyStep[r.stage] || "other";
        acc[step] = (acc[step] || 0) + r.c;
      }
      evAcc[wn] = acc;
    }

    // ========== 2. 权威表证据(按窗计数, 补齐"不产生事件但确实在工作"的环节) ==========
    const countFn = async (sql: string, nParams = 1) => {
      const out: Record<string, number> = {};
      for (const [wn, w] of W) {
        try { out[wn] = (await one(mind, sql, ...(new Array(nParams).fill(w))) || {}).c ?? 0; } catch { out[wn] = 0; }
      }
      return out;
    };
    const sessCount = async (sql: string) => {
      const out: Record<string, number> = {};
      if (!sess) return { m5: 0, m15: 0, h1: 0, h24: 0 };
      for (const [wn, w] of W) {
        try { out[wn] = (await one(sess, sql, w) || {}).c ?? 0; } catch { out[wn] = 0; }
      }
      return out;
    };
    // scan: 会话同步面 = Session.updatedAt 窗口内有更新的会话(新同步/状态变化)
    const scanQty = sessCount("SELECT COUNT(*) c FROM Session WHERE updatedAt > ?");
    // extract 补充: Session extractStatus='DONE' 且 updatedAt 在窗口(提炼完成会话)
    const extractDoneSess = sessCount("SELECT COUNT(*) c FROM Session WHERE extractStatus='DONE' AND updatedAt > ?");
    // write: 产物落库(非任务产物) = Memory+Knowledge+Practice (Skill 无 sourceType, 归 structure)
    const writeQty = await countFn(
      "SELECT (SELECT COUNT(*) FROM Memory WHERE createdAt > ? AND (sourceType IS NULL OR sourceType NOT IN ('FLYWHEEL_STRUCTURED','BRIDGE'))) + " +
      "(SELECT COUNT(*) FROM Knowledge WHERE createdAt > ? AND (sourceType IS NULL OR sourceType NOT IN ('FLYWHEEL_STRUCTURED','BRIDGE'))) + " +
      "(SELECT COUNT(*) FROM Practice WHERE createdAt > ? AND (sourceType IS NULL OR sourceType NOT IN ('FLYWHEEL_STRUCTURED','BRIDGE'))) c",
      3
    );
    // structure: Skill 行落库 = 结构化/技能打包产物(含 synthesizeSkill / SKILL 桥接)
    const structureQty = await countFn("SELECT COUNT(*) c FROM Skill WHERE createdAt > ?");
    // backfill: 任务产物回填落库 = sourceType IN (FLYWHEEL_STRUCTURED, BRIDGE)
    const backfillQty = await countFn(
      "SELECT (SELECT COUNT(*) FROM Memory WHERE createdAt > ? AND sourceType IN ('FLYWHEEL_STRUCTURED','BRIDGE')) + " +
      "(SELECT COUNT(*) FROM Knowledge WHERE createdAt > ? AND sourceType IN ('FLYWHEEL_STRUCTURED','BRIDGE')) + " +
      "(SELECT COUNT(*) FROM Practice WHERE createdAt > ? AND sourceType IN ('FLYWHEEL_STRUCTURED','BRIDGE')) c",
      3
    );
    // improve 补充: 改进任务完成数 (completedAt 在窗口, status=DONE)
    // 2026-09-10 任务语义分层: 与概览首页 / Agent 活跃看板统一口径 —— 只统计机制修复类
    // (GOAL_GAP 机制修复 + THEME_IMPROVE 反思衍生 + PLATFORM_REVIEW 平台复审);
    // 验证/裁决(VERIFY_AGENT_OUTPUT)、对话/问答(DISCUSSION_QUESTION) 与自动桥接(BRIDGE) 不计入。
    const taskDoneQty = await countFn(
      `SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ? AND improvementType IN (${improvementTypeSql()})`
    );
    // 另附全类型完成数, 便于核对"两个数为什么不一样"(不参与步骤计数)
    const taskDoneAllTypes = await countFn("SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ?");

    // 2026-10-13 round 76-CH: 阶段色改为 **var(--token)** —— 这些 color 由 FlowPipeline 直接当 DOM 样式用
    //   (border/color/background), DOM **能**解析 var(); 原来写死 hex 导致流程图的 7 个阶段色**不跟随主题**。
    const rawSteps = [
      { id: "scan", label: "① 同步/扫描", desc: "输入：智能体推送 / 定时拉取的会话；口径：窗口内有更新的会话（会话同步面）", color: "var(--info)", src: scanQty },
      { id: "extract", label: "② 提炼", desc: "动作: LLM 抽取候选+重要性打分; 口径: CALL_LLM main-extract* 事件 + 窗口内提炼完成会话(extractStatus=DONE)", color: "var(--info)", src: extractDoneSess },
      { id: "write", label: "③ 裁决入库", desc: "动作：裁决新建 / 更新 / 丢弃；口径：窗口内非任务产物落库行（记忆 + 知识 + 实践，排除飞轮结构化与自动桥接）", color: "var(--table-knowledge)", src: writeQty },
      { id: "reflect", label: "④ 主题聚合反思", desc: "动作：同主题跨会话全量消息聚合反思（每 4 小时 / 日结定时任务）；口径：反思调用事件（每次反思含多次模型调用）；轮次见下方主题反思行", color: "var(--table-knowledge)", src: { m5: 0, m15: 0, h1: 0, h24: 0 } },
      { id: "structure", label: "⑤ 结构化/技能打包", desc: "动作：知识→技能 合成 / 桥接；口径：窗口内技能落库数", color: "var(--table-practice)", src: structureQty },
      { id: "improve", label: "⑥ 改进任务", desc: "动作：反思→任务生成 / 合并 / 执行；口径：改进任务调用事件 + 反思转任务事件 + 窗口内完成【机制修复类】任务（状态=已完成，改进类型 ∈ GOAL_GAP/THEME_IMPROVE/PLATFORM_REVIEW) —— 与概览首页 / 智能体看板同口径", color: "var(--table-practice)", src: taskDoneQty },
      { id: "backfill", label: "⑦ 回填", desc: "动作: 任务执行产物写回(飞轮结构化 / 桥接落库行); 口径: 窗口内该类来源类型 产物行", color: "var(--status-ok)", src: backfillQty },
    ];
    const taskDoneAll = taskDoneAllTypes;
    // 在 improve 步骤的口径说明里附上"全类型完成数"对照, 避免与其它页面出现"两个数"却看不出差异
    for (const s of rawSteps) {
      if (s.id === "improve") {
        s.desc += `; 对照: 窗口内全类型 DONE ${taskDoneAll.h24} 条(含自动桥接 BRIDGE 等), 不计入本口径`;
      }
    }
    const steps = rawSteps.map((s) => {
      const qty: Record<string, number> = {};
      for (const [wn] of W) {
        // 2026-10-22 修：PG 的 COUNT/SUM 返回 string（bigint），这里直接 + 会变成字符串拼接
        //   （实测 "0"+"1" → "01" → 累加出 "02062"，页面显示 10,000,000）。强制数值化后再加。
        const n = (v: any) => (typeof v === "number" ? v : Number(v) || 0);
        qty[wn] = n(evAcc[wn]?.[s.id]) + n(s.src?.[wn]);
      }
      return { id: s.id, label: s.label, desc: s.desc, color: s.color, qty };
    });
    const llm24 = (evAcc.h24 || {}).llmTotal || 0;

    // ========== 3. 来源 / session 处理 ==========
    const llmEntries = (await q(mind, "SELECT sourceType source, COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt > ? GROUP BY sourceType ORDER BY c DESC", h24) as any[]);
    const bridgeN = (await one(mind, "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='REFLECTION_TO_TASK' AND createdAt > ?", h24) || {}).c ?? 0;
    const sources = bridgeN > 0 ? [...llmEntries, { source: "REFLECTION_TO_TASK", events: bridgeN }] : llmEntries;

    const sessSql = "SELECT agentId, COUNT(*) total, SUM(CASE WHEN extractStatus IS NULL OR extractStatus='PENDING' THEN 1 ELSE 0 END) pendingN, SUM(CASE WHEN extractStatus='DONE' THEN 1 ELSE 0 END) doneN, SUM(CASE WHEN extractStatus='FAILED' THEN 1 ELSE 0 END) failedN FROM Session WHERE updatedAt > ? GROUP BY agentId ORDER BY total DESC";
    const sessByAgent = sess ? (await q(sess, sessSql, h24) as any[]) : [];
    const recentProcessed = sess ? (await q(sess, "SELECT agentId, sessionUid, messageCount, datetime(updatedAt/1000,'unixepoch') t FROM Session WHERE updatedAt > ? AND extractStatus='DONE' ORDER BY updatedAt DESC LIMIT 15", h24) as any[]) : [];

    // ========== 4. 队列堆积 ==========
    const queues = {
      sessionPending: sess ? (await one(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus IS NULL OR extractStatus='PENDING'") || {}).c ?? -1 : -1,
      sessionProcessing: sess ? (await one(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='PROCESSING'") || {}).c ?? -1 : -1,
      sessionFailed: sess ? (await one(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='FAILED'") || {}).c ?? -1 : -1,
      sessionSkipped24: sess ? (await one(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='SKIPPED' AND updatedAt > ?", h24) || {}).c ?? -1 : -1,
      groupPending: sess ? (await one(sess, "SELECT COUNT(*) c FROM SessionGroup WHERE extractStatus='PENDING'") || {}).c ?? -1 : -1,
      jobPending: (await one(mind, "SELECT COUNT(*) c FROM FlywheelJob WHERE status IN ('PENDING','QUEUED')") || {}).c ?? 0,
      jobRunning: (await one(mind, "SELECT COUNT(*) c FROM FlywheelJob WHERE status='PROCESSING'") || {}).c ?? 0,
      // DLQ 堆积口径 = 未终态(OPEN/RETRYING/EXPIRED); RESOLVED/ABANDONED 为已处理归档 (2026-09-09 修正)
      dlq: (await one(mind, "SELECT COUNT(*) c FROM DeadLetterQueue WHERE status IN ('OPEN','RETRYING','EXPIRED')") || {}).c ?? 0,
    };

    // ========== 5. 产出质量(24h; 窗口=createdAt, FlywheelReflection 用 updatedAt) ==========
    // 口径: total=窗口产出行, scored=有质量分, unscored=未打分缺口, avgQ=有分行均值
    const prodTables: Array<{ name: string; qcol: string; win: "createdAt" | "updatedAt" }> = [
      { name: "Memory", qcol: "qualityScore", win: "createdAt" },
      { name: "Knowledge", qcol: "qualityScore", win: "createdAt" },
      { name: "Practice", qcol: "qualityScore", win: "createdAt" },
      { name: "Skill", qcol: "qualityScore", win: "createdAt" },
      { name: "FlywheelReflection", qcol: "coverageScore", win: "updatedAt" },
    ];
    const quality: Record<string, any> = {};
    for (const t of prodTables) {
      try {
        const sql = "SELECT COUNT(*) total, SUM(CASE WHEN " + t.qcol + " IS NULL THEN 1 ELSE 0 END) unscored, " +
          "ROUND(AVG(CASE WHEN " + t.qcol + " IS NOT NULL THEN " + t.qcol + " END),3) avgQ, " +
          "SUM(CASE WHEN " + t.qcol + " IS NOT NULL AND " + t.qcol + " >= 0.7 THEN 1 ELSE 0 END) highQ, " +
          "SUM(CASE WHEN " + t.qcol + " IS NOT NULL AND " + t.qcol + " < 0.4 THEN 1 ELSE 0 END) lowQ " +
          "FROM " + t.name + " WHERE " + t.win + " > ?";
        const row = await one(mind, sql, h24);
        const r = row || { total: 0, unscored: 0, avgQ: 0, highQ: 0, lowQ: 0 };
        quality[t.name] = {
          n: r.total ?? 0,
          scored: ((r.total ?? 0) - (r.unscored ?? 0)),
          unscored: r.unscored ?? 0,
          avgQ: r.avgQ ?? 0,
          highQ: r.highQ ?? 0,
          lowQ: r.lowQ ?? 0,
        };
      } catch { quality[t.name] = { n: -1 }; }
    }
    const resolver = (await q(mind, "SELECT action, COUNT(*) c FROM ResolverDecision WHERE createdAt > ? GROUP BY action", h24) as any[]);
    // reflectStatus: 反思行按主题 upsert -> 用 updatedAt 窗口才是"最近在反思的主题" (v2 用 createdAt 恒 0/1)
    const reflectStatus = (await q(mind, "SELECT status, COUNT(*) c FROM FlywheelReflection WHERE updatedAt > ? GROUP BY status", h24) as any[]);
    const errToday = (await q(mind, "SELECT errorType, COUNT(*) c FROM FlywheelErrorLog WHERE occurredAt > ? GROUP BY errorType ORDER BY c DESC LIMIT 5", h24) as any[]);

    // ========== 5.5 产出质量自检 (建议1: 最近一次 QUALITY_AUDIT 事件) ==========
    let qualityAudit: any = null;
    try {
      const ev = await one(mind, "SELECT sourceId, sourceTitle, targetStage, createdAt FROM FlywheelEvent WHERE stage='QUALITY_AUDIT' ORDER BY createdAt DESC LIMIT 1");
      if (ev) {
        let parsed: any = null;
        try { parsed = JSON.parse(ev.sourceTitle || "null"); } catch { parsed = null; }
        qualityAudit = {
          at: new Date(ev.createdAt).toISOString(),
          ageHours: Number(((now - ev.createdAt) / 3600000).toFixed(1)),
          violations: Number(ev.sourceId ?? 0),
          targetStage: ev.targetStage,
          failed: parsed?.failed ?? [],
          observations: parsed?.observations ?? {},
          scorecard: parsed?.scorecard ?? null, // 2026-09-10 组合指标
        };
      }
    } catch { /* ignore */ }

    // ========== 6. 心跳 ==========
    const lastEvent = await one(mind, "SELECT stage, sourceType, sourceTitle, createdAt FROM FlywheelEvent ORDER BY createdAt DESC LIMIT 1");
    const running = (await q(mind, "SELECT jobType, status, sessionUid, datetime(startedAt/1000,'unixepoch') started FROM FlywheelJob WHERE status='PROCESSING' ORDER BY startedAt DESC LIMIT 8") as any[]);
    const runningTheme = (await q(mind, "SELECT theme, status, datetime(updatedAt/1000,'unixepoch') up FROM FlywheelReflection WHERE status='PROCESSING' ORDER BY updatedAt DESC LIMIT 5") as any[]);

    // ========== 7. 实时日志 ==========
    let logs: string[] = [];
    try { const raw = fs.readFileSync(FLYWHEEL_LOG, "utf-8"); logs = raw.split("\n").filter(Boolean).slice(-25); } catch {}

    // 连接池由 lions-db 管理，不手动 close
    return NextResponse.json({
      ok: true,
      heartbeat: {
        lastEvent: lastEvent ? { stage: lastEvent.stage, sourceType: lastEvent.sourceType, title: lastEvent.sourceTitle, createdAt: lastEvent.createdAt, ageSec: Math.round((now - lastEvent.createdAt) / 1000) } : null,
        running, runningTheme, llm24,
      },
      steps, sources, sessByAgent, recentProcessed,
      queues, quality, resolver, reflectStatus, errToday, qualityAudit,
      taskScope: {
        key: "MECHANISM",
        types: ["GOAL_GAP", "THEME_IMPROVE", "PLATFORM_REVIEW"],
        note: "改进任务完成口径 = 机制修复类; 验证/对话/自动桥接不计入",
        doneMechanism: taskDoneQty,
        doneAllTypes: taskDoneAll,
      },
      logs, timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
