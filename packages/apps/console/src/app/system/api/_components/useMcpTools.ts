"use client";
// system/api 页 · MCP 工具列表拉取 (从 page.tsx 抽出, 页面瘦身)
import { useEffect, useState } from "react";
import type { McpTool, Svc } from "./types";

export default function useMcpTools(services: Svc[]) {
  // MCP 服务工具列表（按服务名分桶）
  const [toolsByService, setToolsByService] = useState<Record<string, McpTool[]>>({});
  const [toolsLoading, setToolsLoading] = useState(false);

  // 拉取所有服务的 tools/list
  useEffect(() => {
    let aborted = false;
    (async () => {
      setToolsLoading(true);
      // 只对真实可调测的 stdio MCP server 拉工具 (lions_mind)
      try {
        const r = await fetch("/api/mcp-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "tools/list", params: {} }),
        });
        const j = await r.json();
        const tools = j?.result?.tools ?? [];
        const out: Record<string, McpTool[]> = {};
        services.forEach((s) => {
          // 只 lions_mind / mind 相关服务有真实工具
          out[s.name] = /mind|flywheel|knowledge/i.test(s.name) ? tools : [];
        });
        if (!aborted) {
          setToolsByService(out);
          setToolsLoading(false);
        }
      } catch {
        if (!aborted) setToolsLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [services.length]);

  return { toolsByService, toolsLoading };
}
