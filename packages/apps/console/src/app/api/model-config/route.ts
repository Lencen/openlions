import { NextResponse } from "next/server";
import fs from "fs";
import { MODEL_KEYS, maskValue, parseEnvText, mergeEnvText, modelEnvFiles } from "@/lib/server/model-config";
// 0.4.39-08 批1：写 .env 必须先落一条 platform_audit_log（密钥自动脱敏、只存变更键）。
import { writeAudit } from "@/lib/server/audit";

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
  return NextResponse.json({ ok: true, masked, configured, keys: MODEL_KEYS });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "无效请求" }, { status: 400 });

  // 0.4.39-08（按 uiux 契约）：写配置必须带二次确认痕迹，后端独立校验（不能只靠前端拦）。
  //   接受 confirmed === true 或非空 confirmToken；两者都没有 -> 400，且**不产生审计**（未发生写操作）。
  const confirmed = body.confirmed === true;
  const confirmToken = typeof body.confirmToken === "string" ? body.confirmToken.trim() : "";
  if (!confirmed && !confirmToken) {
    return NextResponse.json({ ok: false, error: "缺少二次确认（confirmed 或 confirmToken）" }, { status: 400 });
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

  // 2) 审计（落 mind 库 AuditLog，按 uiux 契约：entityType/action/actor/before/after/metadata）
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
    // uiux 验收第 7 条：审计不可用时必须能从日志证明"这次写被拒绝了、不是漏审计"。
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
    // uiux 复核要求（#7 补偿）：失败路径必须留一条补偿审计，否则会出现「审计说改过、实际没改」——
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
