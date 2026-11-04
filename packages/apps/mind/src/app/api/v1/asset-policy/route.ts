import { NextRequest, NextResponse } from "next/server";
import { getPlatformPolicy, invalidatePolicyCache } from "@/server/pipeline/asset-policy";
import { resolveRequestActor } from "@/server/lib/request-actor";
import { recordAudit } from "@/server/lib/audit-log";

// POST /api/v1/asset-policy —— 平台策略切换（root_admin，2026-10-26）
//
// 为什么必须有审计：允许"直接改库"等于没有任何人知道谁把资产从公开改成了私有；
//   这里把每次变更写进 AuditLog（before/after + actor），并且强制清掉进程内策略缓存。
//
// 切到 private 需要显式确认：存量行 ownerAgentId IS NULL 没有归属人，**不会被自动迁移**（grandfather 策略），
//   必须带 acknowledgeOwnerless=true 才允许切，否则返回 409 —— 防止"以为切了但存量还是公共/或以为数据丢了"。
export const dynamic = "force-dynamic";
export const revalidate = 0;

const MODES = ["public", "private", "agent_choice"] as const;
const KINDS = ["memory", "knowledge", "skill"] as const;
type Kind = (typeof KINDS)[number];
type Mode = (typeof MODES)[number];

// GET /api/v1/asset-policy —— 注册前策略发现（2026-10-26）
//   selectable=false 时注册表单应把该项渲染为只读并置为 fixedTo；服务端仍会拒绝相反选择（防御性）。
export async function GET() {
  try {
    const p = await getPlatformPolicy(true);
    const one = (mode: string) => ({
      mode,
      selectable: mode === "agent_choice",
      fixedTo: mode === "agent_choice" ? null : mode,
      // 2026-10-26（前端线提问）：agent_choice 时"不选 = 什么"必须由后端给出，前端不能猜。
      //   口径与 resolveWriteVisibility 的 fallback 一致：未显式选择 -> public。
      defaultMode: "public" as const,
    });
    return NextResponse.json({
      ok: true,
      memory: one(p.memory),
      knowledge: one(p.knowledge),
      skill: one(p.skill),
      hint: "selectable=false 时，注册表单应把该项渲染为只读并置为 fixedTo；服务端会拒绝与 fixedTo 相反的选择。",
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || "policy unavailable") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  const isAdmin = who.rootAdmin || (who.actor && who.actor.role === "OWNER");
  if (!isAdmin) return NextResponse.json({ ok: false, error: "forbidden: root_admin required" }, { status: 403 });

  let body: any = {};
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }

  const target: Partial<Record<Kind, Mode>> = {};
  for (const k of KINDS) {
    const v = body[k];
    if (v === undefined) continue;
    if (!MODES.includes(v)) return NextResponse.json({ ok: false, error: "invalid mode for " + k + ": " + String(v) }, { status: 400 });
    target[k] = v;
  }
  if (!Object.keys(target).length) return NextResponse.json({ ok: false, error: "no mode provided (memory/knowledge/skill)" }, { status: 400 });

  const before = await getPlatformPolicy(true);
  const goingPrivate = (Object.keys(target) as Kind[]).filter((k) => target[k] === "private" && before[k] !== "private");
  if (goingPrivate.length && body.acknowledgeOwnerless !== true) {
    return NextResponse.json({
      ok: false,
      code: "PRIVATE_SWITCH_NEEDS_ACK",
      error: "切到 private 需要显式确认：存量 owner=NULL 行没有归属人，不会被自动迁移（grandfather，保持公共）。请带 acknowledgeOwnerless=true。",
      affectedKinds: goingPrivate,
      ownerlessRows: await countOwnerless(goingPrivate),
    }, { status: 409 });
  }

  for (const k of Object.keys(target) as Kind[]) {
    await (await import("@/lib/prisma")).prisma.$executeRawUnsafe(
      "UPDATE platform_asset_policy SET mode=$2, updated_at=now() WHERE asset_type=$1", k, target[k]);
  }
  invalidatePolicyCache();

  const after = await getPlatformPolicy(true);
  await recordAudit({
    entityType: "PLATFORM_ASSET_POLICY",
    entityId: (Object.keys(target) as Kind[]).join(","),
    action: "SET",
    actor: who.rootAdmin ? "root_admin" : (who.actor?.agentId ?? "admin"),
    actorType: "admin",
    before: JSON.stringify(before),
    after: JSON.stringify(after),
    metadata: { acknowledgeOwnerless: body.acknowledgeOwnerless === true, goingPrivate },
  });

  return NextResponse.json({
    ok: true,
    platform: after,
    note: "存量 owner=NULL 行按 grandfather 策略保持公共（未自动迁移）；只影响此后新写入。",
  });
}

async function countOwnerless(kinds: Kind[]): Promise<Record<string, number>> {
  const { prisma } = await import("@/lib/prisma");
  const tableOf: Record<Kind, string> = { memory: "Memory", knowledge: "Knowledge", skill: "Skill" };
  const out: Record<string, number> = {};
  for (const k of kinds) {
    const rows = await prisma.$queryRawUnsafe<any[]>("SELECT count(*)::int n FROM \"" + tableOf[k] + "\" WHERE \"ownerAgentId\" IS NULL");
    out[k] = (rows[0] || {}).n ?? 0;
  }
  return out;
}
