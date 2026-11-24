import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * /api/docs-summary — /docs 页数据（D1，2026-11-13）
 * 数据卡 card-docs.md 口径：
 *   · 文档数(md，部署树) = find <tree>/docs -name '*.md' | wc -l（实测部署树 952；工作区树仅开发统计）
 *   · 逐文档索引条目数 / 索引最近更新时间 = n/a（G-01 未落地，禁止写 0）
 *   · 静态平台档 updatedAt = 2026-09-24（常量，非“最近文档更新时间”）
 * 本接口只做真实计数：找不到树 -> 503 fail-closed；不返回硬编码数字。
 */
function findDocsRoot(): { root: string; kind: "deploy" | "workspace" } | null {
  const candidates: Array<{ p: string; kind: "deploy" | "workspace" }> = [];
  if (process.env.LIONS_DOCS_ROOT) candidates.push({ p: process.env.LIONS_DOCS_ROOT, kind: "workspace" });
  // 2026-11-13：页面口径优先部署树（存在时），工作区树仅开发统计
  candidates.push({ p: "/opt/lions/current/docs", kind: "deploy" });
  if (process.env.LIONS_HOME) candidates.push({ p: path.join(process.env.LIONS_HOME, "docs"), kind: "workspace" });
  candidates.push({ p: path.resolve(process.cwd(), "../../docs"), kind: "workspace" });
  candidates.push({ p: process.cwd() + "/docs", kind: "workspace" });
  for (const c of candidates) {
    try {
      if (fs.statSync(c.p).isDirectory()) {
        const kind = c.p.includes("/opt/lions/") ? "deploy" : c.kind;
        return { root: c.p, kind };
      }
    } catch { /* 继续找 */ }
  }
  return null;
}

function countMd(dir: string): number {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop() as string;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".md")) n++;
    }
  }
  return n;
}

export async function GET() {
  const t0 = Date.now();
  const found = findDocsRoot();
  if (!found) {
    return NextResponse.json({ ok: false, reason: "未找到文档根目录（LIONS_DOCS_ROOT / LIONS_HOME / 部署树均不可读）" }, { status: 503 });
  }
  try {
    const count = countMd(found.root);
    return NextResponse.json({
      ok: true,
      treeKind: found.kind,             // deploy | workspace
      treeLabel: found.kind === "deploy" ? "部署树" : "工作区树（开发统计，非页面口径）",
      count,
      asOf: new Date().toISOString(),
      staticDoc: { kind: "static", updatedAt: "2026-09-24" },
      unavailable: [
        { field: "文档索引条目数", reason: "G-01 逐文档索引接口未落地（无 id/title/path/updatedAt/source 列表）" },
        { field: "索引最近更新时间", reason: "同上；降级位仅显示静态档内容日期 2026-09-24" },
      ],
      tookMs: Date.now() - t0,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: "文档统计失败：" + String(e?.message || e) }, { status: 500 });
  }
}