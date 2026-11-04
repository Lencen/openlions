import { NextResponse } from "next/server";

/**
 * 统一探活阈值 (2026-09-14, 提案 cmtwl36jy02bx1j76zndaehd0 第 2 项):
 *   此前这里硬编码 2000ms, 而其它脚本各自 2s/5s/无超时 —— 同一个"Mind 是否活着"会得出互相矛盾的结论。
 *   现在平台级探活统一 3s, 且与 mind:3000 的 /readyz 自检同值(READYZ_TIMEOUT_MS)。
 */
// Next.js route 模块只允许导出约定的 handler/config 符号, 故此处常量不导出(避免 .next/types 校验报错)。
const PROBE_TIMEOUT_MS = 3000;

const SERVICES = [
  // Mind 打 /readyz(依赖就绪)而不是首页/业务接口 —— 返回 200 不代表 DB 可查, 见 app/readyz/route.ts 注释。
  { name: "Mind", port: 3000, url: "http://localhost:3000/readyz", note: "readyz 依赖自检" },
  // 全部走 /readyz 而非 / —— 仅 Mind 原生支持, 其余四个 2026-09-24 休假期间首日补齐。
  //   实测: next dev 首屏冷编译 4-5s, 探活 3s 阈值不够 -> session 永假阴。
  //   /readyz 是恒定 3s 内返回的纯 DB 心跳, 与首页/业务接口解耦。
  { name: "Selfimproving", port: 3001, url: "http://localhost:3001/readyz", note: "readyz 依赖自检 (休假期间首日补齐)" },
  { name: "Session", port: 3002, url: "http://localhost:3002/readyz", note: "readyz 依赖自检 (休假期间首日补齐)" },
  // 遗留#10 (2026-09-01): Portal 实际跑 3006 (文档 3003 是设计值, 修复探活漂移)
  { name: "Portal", port: 3006, url: "http://localhost:3006/readyz", note: "readyz 依赖自检 (休假期间首日补齐)" },
  { name: "Console", port: 3004, url: "http://localhost:3004/readyz", note: "readyz 依赖自检 (休假期间首日补齐)" },
  // 遗留#10: MCP-Server 是 stdio 进程 (无 HTTP 端口), 改改进程存在探测
  { name: "MCP-Server", port: 0, url: "", checkProcess: "mcp-server/dist/index.js" },
];

export async function GET() {
  const results = await Promise.all(
    SERVICES.map(async (s: any) => {
      // MCP-Server: 进程探测 (stdio 无 HTTP)
      if (s.checkProcess) {
        try {
          const { execSync } = await import("child_process");
          const alive = execSync(`pgrep -f ${JSON.stringify(s.checkProcess)} || true`, {
            timeout: 3000,
          })
            .toString()
            .trim();
          return {
            name: s.name,
            port: s.port,
            status: alive ? "ok" : "crit",
            code: alive ? 200 : 0,
            note: "stdio (进程探测)",
          };
        } catch {
          return { name: s.name, port: s.port, status: "crit", code: 0, note: "stdio (进程探测)" };
        }
      }
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        const res = await fetch(s.url, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timeout);
        return { name: s.name, port: s.port, status: res.ok ? "ok" : "warn", code: res.status, note: s.note };
      } catch {
        return { name: s.name, port: s.port, status: "crit", code: 0, note: s.note };
      }
    })
  );
  return NextResponse.json({ success: true, probeTimeoutMs: PROBE_TIMEOUT_MS, data: results });
}
