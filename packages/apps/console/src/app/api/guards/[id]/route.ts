// 守门详情 API — 守门规则管理页面 (#3) 用
// 数据源: 1) guard-registry.json(SSOT) 2) logs/service-check-5h.json(最近一次跑的结果)
// 3) FlywheelEvent 中按 guard name 搜出的告警/事件 4) git log 找出处 PR
//
// 设计要点:
//   - 只读, 不引入可写配置(与 SSOT 不冲突)
//   - 命中找不到 guard 时返回 404 + 错误体
//   - service-check 跑过的守门才有"最近一次跑"结果; 未跑过的返回 null + 提示
//   - 出处 PR 用 git log -- <file> 反查最近 5 个 commit
import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { openMind, q } from "@/lib/server/lions-db";

// 2026-10-13 round 76-Q: dev server 的 process.cwd() 可能是 console 目录(packages/apps/console),
//   也可能是仓库根 —— 原先写死 process.cwd(), 在 console 目录启动时找不到 guard-registry 而返回 503。
const CWD = process.cwd();
const ROOT = (() => {
  const probe = "packages/apps/console/public/guard-registry.json";
  if (existsSync(path.join(CWD, probe))) return CWD;
  const up3 = path.resolve(CWD, "../../..");
  if (existsSync(path.join(up3, probe))) return up3;
  return CWD;
})();

function loadRegistry(): any | null {
  const candidates = [
    path.join(ROOT, "packages/apps/console/public/guard-registry.json"),
    path.join(ROOT, "docs/platform-logic/guard-registry.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
    }
  }
  return null;
}

function loadServiceCheck(): any | null {
  const p = path.join(ROOT, "logs/service-check-5h.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

async function loadFlywheelEvents(guardName: string): Promise<any[]> {
  // 2026-10-21 迁移修复：原来 spawn `sqlite3` 读 mind/prisma/dev.db —— mind 已全量切 PG，
  //   该文件停更，守门详情的"相关事件"会永远是旧快照（且 SQLite 时代的 type/source/message
  //   三列在 PG 里对应 stage/sourceType/sourceTitle）。改为走 lions-db 的 PG 连接池。
  const db = openMind();
  if (!db) return [];
  const like = "%" + String(guardName).replace(/[%_]/g, "") + "%";
  const rows = await q(
    db,
    "SELECT id, stage, sourceType, sourceTitle, createdAt FROM FlywheelEvent " +
      "WHERE LOWER(stage) LIKE LOWER(?) OR LOWER(sourceTitle) LIKE LOWER(?) OR LOWER(sourceType) LIKE LOWER(?) " +
      'ORDER BY "createdAt" DESC LIMIT 5',
    like, like, like
  );
  return rows.map((r: any) => {
    const ms = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    return {
      id: String(r.id ?? ""),
      type: String(r.stage ?? ""),
      source: String(r.sourceType ?? ""),
      message: String(r.sourceTitle ?? "").slice(0, 240),
      createdAt: ms,
      createdAtText: ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "",
    };
  });
}

function loadProvenance(file: string): any[] {
  if (!file || !existsSync(path.join(ROOT, file))) return [];
  try {
    const out = execFileSync("git", [
      "log", "-5", "--pretty=format:%H|%s|%an|%ad", "--date=short", "--", file,
    ], { encoding: "utf8", cwd: ROOT, timeout: 5000 });
    if (!out.trim()) return [];
    return out.trim().split("\n").map((ln) => {
      const [hash, subject, author, date] = ln.split("|");
      return { hash: (hash || "").slice(0, 12), subject, author, date };
    });
  } catch { return []; }
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = decodeURIComponent(params.id || "").trim();
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const reg = loadRegistry();
  if (!reg) return NextResponse.json({ error: "guard-registry 不可读" }, { status: 503 });

  const guard = (reg.guards || []).find((g: any) => g.id === id);
  if (!guard) return NextResponse.json({ error: "guard 不存在", id }, { status: 404 });

  const sc = loadServiceCheck();
  let lastRun: any = null;
  if (sc && Array.isArray(sc.checks)) {
    const hit = sc.checks.find((c: any) => c.name === guard.name);
    if (hit) {
      lastRun = {
        ok: hit.ok,
        detail: hit.detail,
        serviceCheckAt: sc.ts,
      };
    }
  }

  const events = await loadFlywheelEvents(guard.name);
  const provenance = loadProvenance(guard.file);

  return NextResponse.json({
    guard,
    layer: (reg.layers || []).find((l: any) => l.id === guard.layer) || null,
    registry: {
      generatedAt: reg.generatedAt,
      fingerprint: reg.fingerprint,
    },
    lastRun,
    events,
    provenance,
  });
}
