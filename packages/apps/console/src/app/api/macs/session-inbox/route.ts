import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// 2026-10-22 会话线收件箱（读 watcher 的镜像，不下发 session token）。
// watcher：scripts/macs-session-watch.cjs（systemd timer），镜像目录 run/macs-session/<sid>/。
const SID = process.env.MACS_SESSION_ID || "sess_bcf382dd99b5421d";
// 2026-10-22 修：console 服务的工作目录是 packages/apps/console（不是仓库根），
//   直接用 process.cwd() 会找不到 run/macs-session/<sid>/pending.json（线上曾因此返回 ok:false）。
//   解析顺序：显式 env → LIONS_HOME → 从 cwd 逐级向上找 run/ 目录 → cwd 自身。
function resolveMirror(): string {
  if (process.env.MACS_MIRROR_DIR) return process.env.MACS_MIRROR_DIR;
  const bases: string[] = [];
  if (process.env.LIONS_HOME) bases.push(process.env.LIONS_HOME);
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    bases.push(dir);
    dir = path.resolve(dir, "..");
  }
  for (const b of bases) {
    const cand = path.join(b, "run/macs-session", SID);
    try { if (fs.existsSync(path.join(cand, "pending.json"))) return cand; } catch {}
  }
  return path.join(process.cwd(), "run/macs-session", SID);
}
const MIRROR = resolveMirror();

export async function GET(req: Request) {
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit") || 20), 1), 100);
  const pendingFile = path.join(MIRROR, "pending.json");
  let pending: any = null;
  try { pending = JSON.parse(fs.readFileSync(pendingFile, "utf8")); } catch { pending = null; }
  if (!pending) {
    // 没镜像过：如实说明"watcher 未跑过"，不假装 0 条
    return NextResponse.json({ ok: false, session_id: SID, reason: "watcher 尚未产出镜像（" + pendingFile + "）", count: null, items: [] });
  }
  return NextResponse.json({
    ok: true,
    session_id: SID,
    asOf: pending.at || null,
    count: pending.count ?? 0,
    // 传输层待处理（SLO 关心这个）；与"未确认读取"分开，避免把"我还没点开"当成"没送到"
    pendingDelivery: pending.pendingDelivery ?? 0,
    items: (pending.items || []).slice(0, limit),
    ackedTotal: pending.acked_total ?? null,
    // 实时通道状态：wake 长轮询（主用）最后一次结果；用于 UI 显示"实时通道"而不是假装 SSE
    wake: pending.wake ?? null,
    seenTotal: pending.seen_total ?? null,
  });
}
