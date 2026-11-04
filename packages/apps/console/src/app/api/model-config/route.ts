import { NextResponse } from "next/server";
import fs from "fs";
import { MODEL_KEYS, maskValue, parseEnvText, mergeEnvText, modelEnvFiles } from "@/lib/server/model-config";

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
  const updates: Record<string, string> = {};
  for (const key of MODEL_KEYS) {
    const value = body[key];
    if (typeof value === "string" && value.trim() !== "") updates[key] = value.trim();
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: false, error: "没有要保存的字段" }, { status: 400 });
  const files = modelEnvFiles();
  const written: string[] = [];
  for (const file of Object.values(files)) {
    if (!fs.existsSync(file)) continue;
    fs.writeFileSync(file, mergeEnvText(fs.readFileSync(file, "utf8"), updates), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* 非 POSIX 忽略 */ }
    written.push(file);
  }
  return NextResponse.json({ ok: true, written, restartRequired: ["mind", "selfimproving"] });
}
