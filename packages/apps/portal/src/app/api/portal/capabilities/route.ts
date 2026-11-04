import { NextRequest, NextResponse } from "next/server";
// 2026-10-15 架构收口(DB-ACCESS-RULE §3.1): 读走**驱动级只读**句柄, 不再用 Prisma 读写打开生产库。
import { q as mindQuery } from "@/lib/mind-read";
import { silentQuery } from "@/lib/dbLog";
import { GUIDE_VERSION, resolvePlatformBase } from "@/lib/platform-guide";

// GET /api/portal/capabilities?agentHost=[host]
// 列出平台可用服务 + API + MCP 工具 (2026-09-22: 认知数据计数实时取, 手册版本与 mcp URL 走事实源)
export async function GET(req: NextRequest) {
  const agentHost = req.nextUrl.searchParams.get("agentHost") || "";
  const base = resolvePlatformBase(agentHost);

  // 实时认知数据计数(2026-09-22 修: 原硬编码 30K/35K/.../136K 落后实测 34%)
  //   supersededBy IS NULL = 当前有效; status 过滤按各表习惯(Knowledge/Practice)。
  let warning: string | null = null;
  const flag = () => { warning = "data_unavailable"; };
  const tables = [
    { t: "Memory",      where: "WHERE supersededBy IS NULL" },
    { t: "Knowledge",   where: "WHERE COALESCE(stale,0)=0 AND COALESCE(verification,'')!='REJECTED'" },
    { t: "Reflection",  where: "WHERE COALESCE(status,'') NOT IN ('DROPPED','REJECTED') AND supersededBy IS NULL" },
    { t: "Practice",    where: "WHERE supersededBy IS NULL" },
    { t: "Skill",       where: "WHERE COALESCE(stale,0)=0" },
  ];
  const counts: Record<string, number> = {};
  let total = 0;
  for (const { t, where } of tables) {
    const r = await silentQuery<any[]>(
      () => mindQuery(`SELECT COUNT(*) as c FROM ${t} ${where}`),
      [{ c: 0 }],
      `capabilities.count.${t}`,
      flag,
    );
    const n = Number((r as any[])[0]?.c || 0);
    counts[t] = n;
    total += n;
  }
  // 数据行展示为人类可读 + 数字(前端可任选)
  const data: Record<string, string | number> = {
    Memory: counts.Memory,
    Knowledge: counts.Knowledge,
    Reflection: counts.Reflection,
    Practice: counts.Practice,
    Skill: counts.Skill,
    total,
  };

  return NextResponse.json({
    ok: true,
    warning,
    agentHost: agentHost || null,
    services: [
      { name: "mind", url: base.mind, description: "飞轮+认知管线 (Memory/Knowledge/Reflection/Practice/Skill)" },
      { name: "session", url: base.session, description: "Session 归档+检索 (需 X-API-Key)" },
      { name: "console", url: base.console, description: "可视化 (飞轮/认知/Agent/System)" },
      { name: "portal", url: base.portal, description: "AI 接入层 (注册/认证/知识查询)" },
      { name: "mcp_agent_chat", url: base.mcp, description: "跨框架 Agent 通信" },
    ],
    apis: {
      knowledge: "GET /api/portal/knowledge?q=xxx&type=Skill -- 5 表一站式知识检索 (portal)",
      register: "POST /api/portal/register -- Agent 注册",
      heartbeat: "POST /api/portal/heartbeat -- 心跳/状态/手册版本(匿名 200); 带 X-API-Key: <你的服务密钥> 才返回**你自己**的 services 明文密钥",
      guide: `GET /api/portal/guide?format=md|json -- 接入手册 (v${GUIDE_VERSION})`,
      guide_version: "GET /api/portal/guide/version -- 接入手册当前版本号",
      daily_report: "GET /api/portal/daily-report -- 每日总结",
      agents: "GET /api/portal/agents -- Agent 列表",
      memory_search: "GET /api/v1/memory/search?q=xxx (mind)",
      memory_best: "GET /api/v1/memory/best?theme=xxx (mind)",
      skill_list: "GET /api/v1/skill?search=xxx&category=xxx (mind, 开放)",
      skill_detail: "GET /api/v1/skill/<id> (mind, 含 steps)",
      flywheel_metrics: "GET /api/v1/flywheel/metrics (mind)",
      sessions_list: "GET /api/v1/sessions?agentId=<你的agent_id>&limit=20 (session, X-API-Key: 你的 lions_session 密钥)",
      sessions_detail: "GET /api/v1/sessions/<sessionUid> (session, X-API-Key)",
      sessions_upload: "POST /api/sessions/upload (session, X-API-Key)",
      ingest: "POST /api/v1/ingest (mind, X-API-Key: 你的服务密钥) -- 认知写入; 旧的 POST /api/portal/ingest 已于 2026-10-15 退役(410)",
      // 2026-10-23 能力发现: MACS 会话/多线定向(同一个 agent 的多条会话线互通)此前没有任何机器可读入口。
      macs_capabilities: `GET ${base.mcp}/api/macs/capabilities -- MACS 能力清单(免鉴权): 寻址三档/身份两档/端点/ack 语义/定向降级行为`,
      macs_send: `POST ${base.mcp}/api/reply -- 发消息; to=<agent_id> | <agent_id>#<label> | @g_<group>; 可选 target_session_id / strict_target / client_message_id`,
      macs_lines: `GET ${base.mcp}/api/agents/<agent_id>/sessions -- 线注册表(label/title/status/token 元信息); 注册线用 POST 同路径 {label, issue_token}`,
      macs_inbox: `GET ${base.mcp}/api/sessions/<sid>/inbox?unread=1&after_seq=<seq> -- 线级收件箱; ack: POST ${base.mcp}/api/sessions/<sid>/ack`,
      macs_wake: `GET ${base.mcp}/api/sessions/<sid>/wake?after_seq=<seq>&timeout=30 -- 线级长轮询唤醒`,
    },
    data,
    mcp_tools: [
      "send_message -- 发消息: to=<agent_id> | <agent_id>#<label> | @g_<group>; 回执里 target_session_id 非空才是真定向, target_fallback=true 表示已降级; strict_target=true 可让失败显式报错",
      "list_lines -- 列出你自己的会话线(label/session_id/status), label 可直接用于 to=<你的agent_id>#<label>",
      "skill_get -- 取技能详情 (mind /api/v1/skill/<id>)",
      "memory_search -- 搜索飞轮记忆",
    ],
  });
}
