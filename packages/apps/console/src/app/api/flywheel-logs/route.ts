import { NextRequest, NextResponse } from "next/server";
import fs from "fs";

// 飞轮程序运行日志 API (2026-09-01 重构)
// 业务审计用执行记录 (flywheel-audit), 本端点用于代码故障排查: 原始程序日志
// 来源: /tmp/lions-flywheel.log (L1 文本) + logs/mind-dev.log + logs/session-dev.log
// 安全: 只读尾部, 限制行数/大小, 不支持任意路径

const SOURCES: Record<string, { path: string; label: string }> = {
  flywheel: { path: "/tmp/lions-flywheel.log", label: "飞轮定时任务 (L1)" },
  mind: { path: "" + (process.env.LIONS_HOME || process.cwd()) + "/logs/mind-dev.log", label: "Mind 服务" },
  session: { path: "" + (process.env.LIONS_HOME || process.cwd()) + "/logs/session-dev.log", label: "会话服务" },
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const source = sp.get("source") || "flywheel";
  const lines = Math.min(parseInt(sp.get("lines") || "50"), 300);
  const level = sp.get("level") || ""; // error/warn/info/空=全部

  const cfg = SOURCES[source];
  if (!cfg) return NextResponse.json({ error: "unknown source" }, { status: 400 });

  try {
    if (!fs.existsSync(cfg.path)) {
      return NextResponse.json({ source, label: cfg.label, lines: [], error: "日志文件不存在" });
    }
    const stat = fs.statSync(cfg.path);
    if (stat.size > 200 * 1024 * 1024) {
      // 大文件只读末尾 2MB
      const fd = fs.openSync(cfg.path, "r");
      const buf = Buffer.alloc(2 * 1024 * 1024);
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - buf.length));
      fs.closeSync(fd);
      var allLines = buf.toString("utf-8").split("\n");
    } else {
      var allLines = fs.readFileSync(cfg.path, "utf-8").split("\n");
    }

    let filtered = allLines.filter(Boolean).slice(-lines);
    if (level) {
      const lvl = level.toUpperCase();
      const re = lvl === "ERROR" ? /error|failed|fatal|exception/i : lvl === "WARN" ? /warn|⚠|警告/i : null;
      if (re) filtered = filtered.filter((l) => re.test(l));
    }
    // 2026-09-02: 每行补时间 — 解析行内 [YYYY-MM-DD HH:mm:ss] 前缀;
    //   解析不到的行 (如 run-pipeline 候选行) 沿用同批次最后一次见到的 ts, 加 ~ 前缀标记
    const tsRe = /^(\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\])/;
    // 先在全文件 (含 slice 之前的部分) 找到最后一个时间戳, 作为 carry-forward 起点
    let lastTs = "";
    for (let i = allLines.length - 1; i >= 0; i--) {
      const line = allLines[i] || "";
      const m = line.match(tsRe);
      if (m) { lastTs = m[1]; break; }
    }
    const decorated = filtered.map((raw: string) => {
      const m = raw.match(tsRe);
      if (m) {
        lastTs = m[1];
        return { line: raw, time: m[1].replace(/[\[\]]/g, "") };
      }
      // 无时间戳 → 借上次 tick 时间 (同批内推理: 候选行紧跟 tick start/end)
      return { line: raw, time: lastTs ? "~" + lastTs.replace(/[\[\]]/g, "") : "" };
    });
    return NextResponse.json({
      source,
      label: cfg.label,
      lines: decorated,
      total: allLines.length,
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
