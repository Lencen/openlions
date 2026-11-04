// POST /api/knowledge-dedupe/apply — 触发 dedupe --apply (2026-09-23 由 portal 迁入 console)
//   用途: console 待办中心 /todo 「通过并执行」按钮 (审核项=待办, todo_land_jp7xab44pb6g);
//         也保留无 todoId 的裸 apply/dry-run 供运维脚本。
//   鉴权: consoleOperatorGate —— 同源 + 服务端签发 CSRF nonce 双提交,
//     或服务端 env LIONS_CONSOLE_OPERATOR_TOKEN(脚本)。不使用任何硬编码 operator 头。
//   落地: 带 todoId → spawn scripts/knowledge-dedupe-review-todo.cjs --decide=... --decision=approve
//         (内部跑 dedupe --apply 并在成功后自动结单); 否则直接 spawn scripts/knowledge-dedupe.cjs。
//         两者都落审计日志 + FlywheelEvent。
import { NextResponse } from "next/server";
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
// 2026-10-16: 本 route **不再直连账本** —— better-sqlite3 句柄已删除(原 :87 的审计事件 INSERT
//   移进被 spawn 的 scripts/knowledge-dedupe.cjs --emit-event, 那条写路径带统一维护窗口闸门)。
import { consoleOperatorGate } from "@/lib/server/console-operator-gate";

export const dynamic = "force-dynamic";

const REPO = process.env.LIONS_REPO || "" + (process.env.LIONS_HOME || process.cwd()) + "";
const SCRIPT = path.join(REPO, "scripts/knowledge-dedupe.cjs");
// 2026-09-23 审核项=待办: 带 todoId 的「通过」走待办决定脚本(内部 apply + 自动结单)
const REVIEW_SCRIPT = path.join(REPO, "scripts/knowledge-dedupe-review-todo.cjs");
const APPLY_AUDIT_LOG = path.join(REPO, "logs/dedupe-apply-audit.log");
// 2026-10-25 更正（老板提醒：平台已全量 PG，不是 SQLite）：
//   这里原来默认指向 packages/apps/mind/prisma/dev.db（旧 SQLite 库），而 mind/session/macs
//   运行时都已是 PG（MIND_DB_DRIVER=pg）。被 spawn 的三个脚本（knowledge-dedupe.cjs /
//   -review-todo.cjs / -clusters.cjs）仍然只认 better-sqlite3 + 文件路径 —— 也就是说
//   「待办中心 › 通过并执行」此刻会写进那份旧库，而不是 PG。这属于**写错库**，必须先阻断，
//   由 mind 线把这些脚本迁到 PG 后再放开（已 MACS 通知）。显式维护场景可用
//   LIONS_ALLOW_SQLITE_WRITE=1 临时放行。
const MIND_DB = process.env.LIONS_MIND_DB || path.join(REPO, "packages/apps/mind/prisma/dev.db");
function sqliteWriteBlockReason(): string | null {
  if (process.env.LIONS_ALLOW_SQLITE_WRITE === "1") return null;
  const driver = String(process.env.MIND_DB_DRIVER || "pg").toLowerCase();
  if (driver !== "pg") return null;
  if (/^postgres(ql)?:\/\//i.test(MIND_DB)) return null;
  return "知识去重的写路径仍指向旧 SQLite 库（" + MIND_DB + "），而平台已切到 PostgreSQL。"
    + "为避免写错库，本操作已被阻断；待去重脚本迁移到 PG 后开放。";
}

export async function POST(req: Request) {
  const gate = consoleOperatorGate(req);
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: gate.error, detail: gate.detail }, { status: gate.status });
  }
  // 鉴权之后再判「会不会写错库」，避免把本机路径泄漏给未鉴权请求。
  const blockReason = sqliteWriteBlockReason();
  if (blockReason) {
    return NextResponse.json({ ok: false, blocked: true, error: blockReason }, { status: 409 });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* no body is ok */ }
  const dryRun = body.dryRun !== false; // 默认 dry-run; body.dryRun=false 才 apply
  if (!dryRun && String(body.confirm || "") !== "APPLY") {
    return NextResponse.json(
      { ok: false, error: "NEED_CONFIRM", detail: "真 apply 需在 body 中显式传 confirm 字段(值为 APPLY)" },
      { status: 400 }
    );
  }
  const ts = new Date().toISOString();
  const actor = String(body.actor || gate.actor);
  // 2026-09-23 审核项=待办 (todo_land_jp7xab44pb6g): 带 todoId 表示"人从待办点通过",
  //   复用 knowledge-dedupe-review-todo.cjs 的 decide(approve): apply 成功 → 自动结单(写 evidence)。
  //   不在本 route 里重造一份结单逻辑, 避免两处口径漂移。
  const todoId = body.todoId ? String(body.todoId) : "";
  const humanActor = String(body.actorId || "operator");

  let out = "";
  let code: number | null = 0;
  let decisionAction: string | null = null;
  if (todoId && !dryRun) {
    const r = spawnSync("node", [REVIEW_SCRIPT, "--json", "--decide=" + todoId, "--decision=approve", "--actor=" + humanActor], {
      encoding: "utf8",
      timeout: 600000,
      cwd: REPO,
      env: Object.assign({}, process.env, { LIONS_MIND_DB: MIND_DB, MIND_DB_PATH: MIND_DB }),
    });
    out = (r.stdout || "") + (r.stderr || "");
    code = r.status;
    try {
      const line = String(r.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
      decisionAction = line ? JSON.parse(line).action : null;
    } catch { decisionAction = null; }
  } else {
    const flag = dryRun ? [] : ["--apply"];
    const r = spawnSync("node", [SCRIPT, ...flag], {
      encoding: "utf8",
      timeout: 600000,
      cwd: REPO,
      env: Object.assign({}, process.env, { LIONS_MIND_DB: MIND_DB, MIND_DB_PATH: MIND_DB }),
    });
    out = (r.stdout || "") + (r.stderr || "");
    code = r.status;
  }

  try {
    fs.mkdirSync(path.dirname(APPLY_AUDIT_LOG), { recursive: true });
    fs.appendFileSync(
      APPLY_AUDIT_LOG,
      `[${ts}] actor=${actor} mode=${dryRun ? "DRY-RUN" : "APPLY"} todo=${todoId || "-"} code=${code} bytes=${out.length}\n`
    );
  } catch { /* ignore */ }

  // 2026-10-16 根因收尾(scripts/DB-ACCESS-RULE.md §3.1 登记点): 原实现在这里**内联**开一个读写句柄
  //   INSERT FlywheelEvent(stage=DEDUPE_APPLY) —— 那让 console 成了"零前置直连账本并写"的一方。
  //   现改为 spawn 脚本登记事件: 写入发生在 scripts/knowledge-dedupe.cjs 内, 且它带统一维护窗口闸门
  //   (scripts/lib/mind-db-write-window.cjs: 需 MIND_DB_WRITE_WINDOW=1 + mind 已停 + 读写持有者归零)。
  //   stage 仍是 DEDUPE_APPLY, 列与取值口径逐字不变(仅当窗口未开时不落库, 且在响应里显式说明)。
  let eventStatus: "recorded" | "refused_no_window" | "failed" = "failed";
  try {
    const r = spawnSync(
      "node",
      [SCRIPT, "--emit-event", "--mode=" + (dryRun ? "dry" : "apply"), "--actor=" + actor, "--code=" + String(code)],
      {
        encoding: "utf8",
        timeout: 60000,
        cwd: REPO,
        env: Object.assign({}, process.env, { LIONS_MIND_DB: MIND_DB, MIND_DB_PATH: MIND_DB }),
      }
    );
    // rc=3 = 统一闸门判定"维护窗口未开"(scripts/lib/mind-db-write-window.cjs 的约定)
    eventStatus = r.status === 0 ? "recorded" : r.status === 3 ? "refused_no_window" : "failed";
  } catch { eventStatus = "failed"; }

  try { fs.unlinkSync(path.join(REPO, "logs/console-dedupe-clusters.json")); } catch {}

  return NextResponse.json({
    // 带 todoId 时必须"已结单"才算成功, 避免 apply 成功但待办没关的悬挂状态
    ok: code === 0 && (!todoId || decisionAction === "approved_applied_closed"),
    mode: dryRun ? "DRY-RUN" : "APPLY",
    actor,
    code,
    todoId: todoId || null,
    decisionAction,
    // 审计事件是否真的落库(未开维护窗口时 = refused_no_window, 账本写入被闸门拒绝);
    //   与 logs/dedupe-apply-audit.log 无关 —— 那一行永远写, 不受窗口影响。
    flywheelEvent: eventStatus,
    summary: out
      .split("\n")
      .filter(
        (l: string) =>
          l.includes("cluster_count") ||
          l.includes("archived") ||
          l.includes("needsBackfill") ||
          l.includes("count:") ||
          l.startsWith("[APPLY]") ||
          l.startsWith("DRY-RUN")
      )
      .join("\n"),
    auditLog: APPLY_AUDIT_LOG,
  });
}
