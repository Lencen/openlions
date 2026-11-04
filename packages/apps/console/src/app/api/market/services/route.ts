import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { findRepoRoot } from "@/lib/server/model-config";

export const dynamic = "force-dynamic";

// 2026-10-20 F2: 服务目录（services/index.json 为单一来源；由 check:service-index 防漂移）。
export async function GET() {
  try {
    const root = findRepoRoot(process.cwd());
    const p = path.join(root, "services", "index.json");
    const list = JSON.parse(fs.readFileSync(p, "utf8"));
    return NextResponse.json({ services: list, asOf: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ services: [], error: "目录暂不可用" }, { status: 200 });
  }
}
