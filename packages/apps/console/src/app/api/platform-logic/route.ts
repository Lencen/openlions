import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// 2026-10-15 round-78: 判为 **必须动态**(虽然返回的是文档文本, 但响应体不是纯静态文案):
//   ① 每个 domain 带 updatedAt(文件 mtime), 另回 docs/ 全量 inventory(mtime+size)与 timestamp:new Date()
//      —— 短缓存/静态都会让这些"文档新鲜度"字段说谎, 而 docs/ 每天在被改(本任务当天就改了
//      docs/platform-logic/GUARD-REGISTRY.md 等); ② 平台内**没有任何**正向 revalidate=N 先例
//      (全仓只有 readyz 的 revalidate = 0), 引入 revalidate=30/60 就是自创第三种口径, 违背"跟随既有口径";
//   ③ 成本可忽略(一次 docs/ ~750 个 md 的 readdir+stat, 毫秒级)。故跟随既有二元口径 force-dynamic。
export const dynamic = "force-dynamic";

/**
 * GET /api/platform-logic — 读取 docs/platform-logic/*.md (现状型文档 = 页面单一来源)
 * 返回: { domains: [{ key, title, file, updatedAt, sections: [{heading, lines[]}] }] , index }
 */
const DIR = process.env.LIONS_LOGIC_DOCS || "" + (process.env.LIONS_HOME || process.cwd()) + "/docs/platform-logic";
const DOMAIN_TITLES: Record<string, string> = {
  memory: "记忆 Memory",
  knowledge: "知识 Knowledge",
  skill: "技能 Skill",
  flywheel: "飞轮 Flywheel",
  session: "会话 Session",
  macs: "MACS 消息总线",
  "agent-registry": "Agent 注册",
};

function parseSections(md: string): Array<{ heading: string; lines: string[] }> {
  const out: Array<{ heading: string; lines: string[] }> = [];
  let cur = { heading: "（头部）", lines: [] as string[] };
  for (const line of md.split("\n")) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) { out.push(cur); cur = { heading: m[2].trim(), lines: [] }; }
    else cur.lines.push(line);
  }
  out.push(cur);
  return out.filter((s) => s.heading !== "（头部）" || s.lines.some((l) => l.trim()));
}

export async function GET() {
  try {
    if (!fs.existsSync(DIR)) return NextResponse.json({ error: "docs/platform-logic 不存在: " + DIR }, { status: 500 });
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".md"));
    const domains = files
      .filter((f) => f !== "README.md")
      .map((f) => {
        const key = f.replace(/\.md$/, "");
        const full = path.join(DIR, f);
        const md = fs.readFileSync(full, "utf-8");
        const st = fs.statSync(full);
        return {
          key,
          title: DOMAIN_TITLES[key] || key,
          file: "docs/platform-logic/" + f,
          updatedAt: st.mtime.toISOString(),
          sections: parseSections(md),
        };
      })
      .sort((a, b) => (a.key === "flywheel" ? -1 : b.key === "flywheel" ? 1 : a.title.localeCompare(b.title)));
    const index = fs.existsSync(path.join(DIR, "README.md")) ? fs.readFileSync(path.join(DIR, "README.md"), "utf-8") : "";
    // docs/ 文档清单 (回答"文档都在哪里, 有没有结构化")
    let inventory: Array<{ name: string; dir: string; updatedAt: string; sizeKb: number }> = [];
    try {
      const DOCS = "" + (process.env.LIONS_HOME || process.cwd()) + "/docs";
      const walk = (d: string, prefix: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (["node_modules", "reviews", "frontend-demos"].includes(e.name)) continue;
            walk(full, prefix + e.name + "/");
          } else if (e.name.endsWith(".md")) {
            const st = fs.statSync(full);
            inventory.push({ name: e.name, dir: prefix || "(root)", updatedAt: st.mtime.toISOString(), sizeKb: Math.round(st.size / 102.4) / 10 });
          }
        }
      };
      walk(DOCS, "");
      inventory.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    } catch { /* ignore */ }
    return NextResponse.json({ ok: true, dir: DIR, domains, index, inventory, timestamp: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
