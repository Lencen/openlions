import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";

// 2026-10-15 round-78: 每次请求都要**真实 ping** 五个服务(:3000/3001/3002/3004/3006), 结果是"此刻"的存活。
//   静态快照 = 服务全挂了也永远显示编译时刻的存活表。注: safeFetchJson 的 no-store fetch 使 build 期
//   已 bailout 成动态; 显式声明为去隐式依赖/防回归。
export const dynamic = "force-dynamic";

// 服务端 ping 各服务 (避开浏览器 CORS 限制)
export async function GET() {
  // 2026-11-04（开源/自定义端口）：不再写死 3000-3006；用安装器写入的环境变量。
  //   Portal 只在配了 LIONS_PORTAL_URL 时探测（open 版没有 portal，不能永远显示红）。
  const trim = (u: string) => String(u || "").replace(/\/$/, "");
  const mind = trim(process.env.LIONS_MIND_URL || ("http://127.0.0.1:" + (process.env.LIONS_MIND_PORT || "3000")));
  const task = trim(process.env.LIONS_TASK_URL || ("http://127.0.0.1:" + (process.env.LIONS_TASK_PORT || "3001")));
  const session = trim(process.env.LIONS_SESSION_API_BASE || ("http://127.0.0.1:" + (process.env.LIONS_SESSION_PORT || "3002")));
  const consoleUrl = trim(process.env.LIONS_CONSOLE_URL || ("http://127.0.0.1:" + (process.env.PORT || "3004")));
  const services = [
    { name: "Mind", url: mind + "/" },
    { name: "Selfimproving", url: task + "/" },
    { name: "Session", url: session + "/" },
    { name: "Console", url: consoleUrl + "/" },
  ];
  if (process.env.LIONS_PORTAL_URL) services.push({ name: "Portal", url: trim(process.env.LIONS_PORTAL_URL) + "/" });
  const results = await Promise.all(services.map(async (s) => {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      // 2026-10-26：此前用默认 8s 超时，任一服务不可达就整体拖到 8s（实测 /api/service-ping 7.76s），
      //   而 /system 页面等它 → 设计门按 networkidle 判超时。探测只要"活没活"，2s 足够（浏览器端也是 2s 口径）。
      const r = await safeFetchJson(s.url, { timeoutMs: 2000 });
      clearTimeout(timer);
      const code = r.status || (r.ok ? 200 : 0);
      return { name: s.name, code, ms: Date.now() - t0, alive: r.ok || (code > 0 && code < 500) };
    } catch {
      return { name: s.name, code: 0, ms: Date.now() - t0, alive: false };
    }
  }));
  // 2026-10-16（round 77-K）**顶层加 asOf**（单一行的纯增量）:
  //   本文件注释本来就写着"静态快照 = 服务全挂了也永远显示编译时刻的存活表" ✗ —— 这个接口
  //   存在的主要理由**就是时刻问题**。而 /system 的页头此前标的是 stats-overview 的时刻 ✗，
  //   也就是说"服务状态"这组数字戴着另一个源的时刻 ✓（铁律 2 要防的那种）。
  //   纯增量: 2 个消费者都读 services 层，同级多键会被忽略 ✓。
  return NextResponse.json({ services: results, asOf: asOf() });
}
