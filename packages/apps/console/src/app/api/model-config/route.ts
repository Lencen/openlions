import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { MODEL_KEYS, maskValue, parseEnvText, mergeEnvText, modelEnvFiles } from "@/lib/server/model-config";
// 0.6 模型配置页（2026-11-16）：四区块全配置点状态 + 切换 + 测试调用。
import { readAllGroups, testCall, fileForPoint, keyHealth, type ConfigPoint } from "@/lib/server/model-config-status";
// 0.4.39-08 批1：写 .env 必须先落一条 platform_audit_log（密钥自动脱敏、只存变更键）。
import { writeAudit } from "@/lib/server/audit";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";

export const dynamic = "force-dynamic";

function readAll() {
  const files = modelEnvFiles();
  const masked: Record<string, string> = {};
  const configured: string[] = [];
  for (const app of Object.keys(files)) {
    const file = files[app];
    if (!fs.existsSync(file)) continue;
    const env = parseEnvText(fs.readFileSync(file, "utf8"));
    for (const key of MODEL_KEYS) {
      if (env[key]) {
        masked[key] = maskValue(env[key]);
        if (!configured.includes(app)) configured.push(app);
      }
    }
  }
  return { masked, configured };
}

export async function GET() {
  const { masked, configured } = readAll();
  // groups：模型配置页四区块（飞轮/平台/fleet），key 只回尾号（maskValue 在读取层已做）。
  let groups: ReturnType<typeof readAllGroups> = [];
  try { groups = readAllGroups(); } catch { /* 单区块读失败不拖垮整体；页面对缺失区块显示 n/a */ }
  // asOf（基线 §1 页头「数据时刻」）：服务端取数时刻；页面拿不到时回落「请求时刻」并标注原因。
  const asOf = new Date().toISOString();
  // 键健康（基线 §5 KPI「配置点数=已配键/总键」「缺失键数」），来源文件随响应下发以便标注。
  let health: ReturnType<typeof keyHealth> | null = null;
  try { health = keyHealth(); } catch { /* 汇总失败 -> 页面 KPI 显示 n/a+原因 */ }
  return NextResponse.json({ ok: true, masked, configured, keys: MODEL_KEYS, groups, asOf, keyHealth: health });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "无效请求" }, { status: 400 });

  // 2026-11-13 P0（运营团队 11:42 / 设计 发现）：写配置必须接平台写鉴权（PLATFORM_WRITE_AUTH）+ 二次确认。
  //   对照 /api/agent-permissions:207 同款守卫；未授权返回 401/503，不落盘、不产生"成功审计"。
  const guard = requirePlatformWrite(req as any, "config.write", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

  // ── 0.6 模型配置页：action 分支 ──────────────────────────────────────
  const action = typeof body.action === "string" ? body.action : "";

  // action=test-call：R1/R3 验收门。走上面的平台写鉴权 + 二次确认（confirm=true，用户点按钮即确认）；
  //   **不落审计**（非写操作），
  //   且**请求体/prompt 一律不落日志**——只返回 HTTP 码 + 回复前 20 字（用户红线）。
  if (action === "test-call") {
    const pointId = typeof body.point === "string" ? body.point : "";
    const groups = readAllGroups();
    const found = groups.flatMap((g) => g.points).find((p) => p.id === pointId);
    if (!found) return NextResponse.json({ ok: false, error: "配置点不存在" }, { status: 404 });
    const file = fileForPoint(found);
    const prompt = "连通性自检：请回复 OK 两个字母。"; // 最小提示词，固定文案（不含用户输入）
    const result = await testCall(found, prompt, file);
    return NextResponse.json({ ok: !!result.ok, ...result });
  }

  // 0.4.39-08（按 设计 契约）：写配置必须带二次确认痕迹，后端独立校验（不能只靠前端拦）。
  //   接受 confirmed === true 或非空 confirmToken；两者都没有 -> 400，且**不产生审计**（未发生写操作）。
  // 字段对齐 guard（platform-write-guard 的 decideConfirm 读 `confirm`，11-13 版读 `confirmed`）：
  //   两者都接受，避免同页两个字段名打架。
  const confirmed = body.confirmed === true || body.confirm === true;
  const confirmToken = typeof body.confirmToken === "string" ? body.confirmToken.trim() : "";
  if (!confirmed && !confirmToken) {
    return NextResponse.json({ ok: false, error: "缺少二次确认（confirm 或 confirmToken）" }, { status: 400 });
  }

  // action=switch：切换某配置点的模型（写其配置文件）。
  //   顺序与既有写路径一致：鉴权(上方) -> 二次确认(下方已过) -> 备份 -> 审计 fail-closed -> 落盘 0600。
  //   今日不自动重启进程（全链路 11-17），但返回 restart 提示含**预计影响面**（switch 前弹窗要列明）。
  if (action === "switch") {
    const pointId = typeof body.point === "string" ? body.point : "";
    const groups = readAllGroups();
    const found = groups.flatMap((g) => g.points).find((p) => p.id === pointId);
    if (!found) return NextResponse.json({ ok: false, error: "配置点不存在" }, { status: 404 });

    // 锁定项（selfimproving：用户指示暂不切 2026-11-16）默认拒绝；解锁需 force + 二次确认（已过 confirm 校验）。
    if (found.locked && body.force !== true) {
      return NextResponse.json({ ok: false, error: "该配置点已锁定：" + (found.lockReason || "用户指示暂不切"), code: "LOCKED" }, { status: 409 });
    }

    const file = fileForPoint(found);
    if (!file || !fs.existsSync(file)) return NextResponse.json({ ok: false, error: "配置文件不可得" }, { status: 409 });
    const nextModel = typeof body.model === "string" ? body.model.trim() : "";
    const nextBase = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (!nextModel && !nextBase) return NextResponse.json({ ok: false, error: "没有要写入的字段" }, { status: 400 });

    const before: Record<string, string> = {};
    const patch: Record<string, string> = {};
    const cur = fs.readFileSync(file, "utf8");
    const env = parseEnvText(cur);
    if (nextModel) { before.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || ""; patch.ANTHROPIC_MODEL = nextModel; }
    if (nextBase) { before.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL || ""; patch.ANTHROPIC_BASE_URL = nextBase; }
    const next = mergeEnvText(cur, patch);

    // 备份：同目录 .bak-<时间戳>，0600（一键回滚取最近备份；明日接回滚链路）。
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = file + ".bak-" + stamp;
    try {
      fs.writeFileSync(backupPath, cur, { mode: 0o600 });
      try { fs.chmodSync(backupPath, 0o600); } catch { /* 非 POSIX 忽略 */ }
    } catch (e) {
      return NextResponse.json({ ok: false, error: "备份失败，已中止（不写入）", detail: String((e as Error)?.message || e).slice(0, 120) }, { status: 500 });
    }

    // 审计 fail-closed：写不出来就不落盘（与既有写路径同约束）。
    try {
      await writeAudit({
        entityType: "PlatformConfig",
        entityId: found.id,
        action: "platform.model.switch",
        before,
        after: patch,
        actor: { id: String(req.headers.get("x-actor") || "console-ui"), type: "human" },
        changeType: "update",
        confirmed,
        confirmToken: confirmToken || undefined,
        extraMetadata: { file, backupPath },
      });
    } catch (e) {
      try { fs.unlinkSync(backupPath); } catch { /* 备份未用则清理 */ }
      return NextResponse.json({ ok: false, error: "审计写入失败，已拒绝切换（fail-closed）", detail: String((e as Error)?.message || e).slice(0, 160) }, { status: 500 });
    }

    try {
      fs.writeFileSync(file, next, { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* 非 POSIX 忽略 */ }
    } catch (e) {
      try { fs.writeFileSync(file, cur, { mode: 0o600 }); } catch { /* 回滚失败则留备份可人工恢复 */ }
      return NextResponse.json({ ok: false, error: "写入失败，已回滚原内容", detail: String((e as Error)?.message || e).slice(0, 160) }, { status: 500 });
    }

    const impact = found.group === "flywheel"
      ? "重启 lions-mind：飞轮短暂中断（提炼/反思排队，不丢数据）"
      : found.group === "fleet"
        ? "重启对应 agent client：该线投递暂停，恢复后 pending 继续"
        : "重启对应进程后生效（未重启则配置不生效）";
    return NextResponse.json({
      ok: true,
      file,
      backupPath,
      mtime: fs.statSync(file).mtime.toISOString().replace("T", " ").slice(0, 19),
      restart: { unit: found.unit, hint: impact, applied: false },
      note: "配置已写入但进程未重启（可能未生效）；重启链路 11-17 上线。",
    });
  }

  const updates: Record<string, string> = {};
  for (const key of MODEL_KEYS) {
    const value = body[key];
    if (typeof value === "string" && value.trim() !== "") updates[key] = value.trim();
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: false, error: "没有要保存的字段" }, { status: 400 });
  const files = modelEnvFiles();
  const targets = Object.values(files).filter((f) => fs.existsSync(f));

  // 1) 先算 before（只取要改的键）与「即将写入的内容」，但不落盘 —— 为了 fail-closed：
  //    审计写不出来就不改 .env（否则会出现"改了但没审计"的静默窗口）。
  const before: Record<string, string> = {};
  const plan: Array<{ file: string; next: string }> = [];
  for (const file of targets) {
    const cur = fs.readFileSync(file, "utf8");
    const env = parseEnvText(cur);
    for (const key of Object.keys(updates)) before[key] = env[key] || "";
    plan.push({ file, next: mergeEnvText(cur, updates) });
  }

  // 2) 审计（落 mind 库 AuditLog，按 设计 契约：entityType/action/actor/before/after/metadata）
  //    失败 -> 500 且不落盘（fail-closed）；PLATFORM_AUDIT_ENFORCE=0 时降级为只记日志。
  const actorId = String(req.headers.get("x-actor") || "console-ui");
  try {
    await writeAudit({
      entityType: "PlatformConfig",
      entityId: targets.join(","),
      action: "platform.config.update",
      before,
      after: updates,
      actor: { id: actorId, type: "human" },
      changeType: "update",
      confirmed,
      confirmToken: confirmToken || undefined,
    });
  } catch (e) {
    // 设计 验收第 7 条：审计不可用时必须能从日志证明"这次写被拒绝了、不是漏审计"。
    //   字段：event / entityId / attemptedKeys（只报键名，不报值）/ requestId
    const requestId = req.headers.get("x-request-id") || "";
    console.error(JSON.stringify({
      event: "platform.write.audit_failed",
      entityType: "PlatformConfig",
      entityId: targets.join(","),
      attemptedKeys: Object.keys(updates),
      requestId,
      level: "ERROR",
      detail: String((e as Error)?.message || e).slice(0, 200),
    }));
    return NextResponse.json(
      { ok: false, error: "审计写入失败，已拒绝修改 .env（fail-closed）", detail: String((e as Error)?.message || e).slice(0, 200), requestId: requestId || undefined },
      { status: 500 }
    );
  }

  // 3) 审计成功后落盘；写失败则按原内容回滚，避免"审计成功但文件只写了一半"。
  const written: string[] = [];
  const originals: Array<{ file: string; text: string }> = [];
  try {
    for (const item of plan) {
      originals.push({ file: item.file, text: fs.readFileSync(item.file, "utf8") });
      fs.writeFileSync(item.file, item.next, { mode: 0o600 });
      try { fs.chmodSync(item.file, 0o600); } catch { /* 非 POSIX 忽略 */ }
      written.push(item.file);
    }
  } catch (e) {
    const reason = String((e as Error)?.message || e).slice(0, 200);
    for (const o of originals) { try { fs.writeFileSync(o.file, o.text, { mode: 0o600 }); } catch { /* ignore */ } }
    // 设计 复核要求（#7 补偿）：失败路径必须留一条补偿审计，否则会出现「审计说改过、实际没改」——
    //   那比没有审计更危险（追责时指向错误结论）。
    try {
      await writeAudit({
        entityType: "PlatformConfig",
        entityId: targets.join(","),
        action: "platform.config.write_failed",
        before,
        after: updates,
        actor: { id: actorId, type: "human" },
        changeType: "update",
        confirmed,
        confirmToken: confirmToken || undefined,
        extraMetadata: { reason, attemptedBefore: before, attemptedAfter: updates, failed: true },
      });
    } catch { /* 补偿审计自身失败：已回滚，不再二次抛出，避免掩盖原始写失败 */ }
    return NextResponse.json({ ok: false, error: "写入 .env 失败，已回滚原内容", detail: reason }, { status: 500 });
  }
  return NextResponse.json({ ok: true, written, restartRequired: ["mind", "selfimproving"] });
}