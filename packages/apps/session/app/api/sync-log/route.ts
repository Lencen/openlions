import { NextResponse } from "next/server";
import * as fs from "fs";

// GET /api/sync-log?lines=50 — 返回 lions-sync-cron.log 尾部 (实时同步日志)
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const lines = Math.min(Math.max(parseInt(url.searchParams.get("lines") || "40"), 10), 200);
    const paths = [
      "~/lions/logs/lions-sync-cron.log",
      "~/lions/logs/session-dev.log",
    ];
    const entries = [];
    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      const size = Math.max(stat.size - lines * 400, 0); // 粗略按行数往前读
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(stat.size - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      const allArr = text.split("\n").filter(Boolean);
      const arr = allArr.slice(-lines);
      // 2026-09-02: 每行补时间 (解析 [YYYY-MM-DD HH:mm:ss] 或沿用批次)
      const tsRe = /^(\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\])/;
      let lastTs = "";
      for (let i = allArr.length - 1; i >= 0; i--) {
        const m = (allArr[i] || "").match(tsRe);
        if (m) { lastTs = m[1]; break; }
      }
      // 去掉时间戳两侧的方括号。`/[[\]]/g` 与旧写法 `/[\[\]]/g` 完全等价:
      // 字符类内 `[` 本就不必转义、`]` 必须转义 —— 两者都且仅匹配 `[` 与 `]`(消除 no-useless-escape, 匹配语义不变)
      const decorated = arr.map((raw: string) => {
        const m = raw.match(tsRe);
        if (m) { lastTs = m[1]; return { line: raw, time: m[1].replace(/[[\]]/g, "") }; }
        return { line: raw, time: lastTs ? "~" + lastTs.replace(/[[\]]/g, "") : "" };
      });
      entries.push({
        file: p.split("/").pop(),
        mtime: stat.mtime.toISOString(),
        size: stat.size,
        lines: decorated,
      });
    }
    return NextResponse.json({ success: true, generatedAt: new Date().toISOString(), files: entries });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
